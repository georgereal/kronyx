import { getProvider, type ProviderCreds, type SandboxHandle, type SandboxProvider } from "./provider";
import { swallow } from "../lib/errlog";

/**
 * vscode-free sandbox wrapper shared by the extension's cloud controller
 * and the web worker. Credential/config resolution and prompting live in the
 * vscode-specific subclass (e2b.ts) or the worker's settings layer.
 *
 * Provider-agnostic: the underlying backend is selected by `provider` name
 * ("e2b" default; see src/sandbox/provider.ts registry).
 */
export class SandboxCore {
	private provider: SandboxProvider = getProvider("e2b");
	protected handle: SandboxHandle | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private onPause: (() => void) | undefined;
	private idleMinutes = 0;
	/** Lifecycle reporter — callers wire this to persistence (sqlite or Mongo). */
	onLifecycle: ((event: string, sandboxId: string) => void) | undefined;

	protected report(event: string): void {
		const id = this.sandboxId;
		if (id) this.onLifecycle?.(event, id);
	}

	/** Called when the sandbox is about to be paused (idle hot-load). */
	setPauseHook(fn: () => void): void {
		this.onPause = fn;
	}

	/** Auto-pause after N idle minutes (0 disables). */
	setIdlePause(minutes: number): void {
		this.idleMinutes = minutes;
		this.armIdlePause();
	}

	private armIdlePause(): void {
		clearTimeout(this.idleTimer);
		if (this.idleMinutes <= 0 || !this.provider.capabilities.pause) return;
		this.idleTimer = setTimeout(() => {
			void this.pause().then((ok) => ok && this.onPause?.());
		}, this.idleMinutes * 60_000);
	}

	/** Activity resets the idle-pause countdown — a live run must never be
	 *  paused out from under itself (previously the timer only armed at
	 *  create/connect, so it fired mid-run regardless of activity). */
	private touch(): void {
		if (this.handle) this.armIdlePause();
	}

	/** Pause the sandbox (snapshot filesystem/memory); resumes via connect(). */
	async pause(): Promise<boolean> {
		if (!this.handle || !this.provider.pauseById) return false;
		const id = this.sandboxId;
		if (!id) return false;
		try {
			// Skip the provider call when the VM is already paused (e.g. the
			// janitor beat the idle timer) — pausing twice double-records.
			const info = await this.provider.getInfoById?.(id, this.creds).catch(() => null);
			if (info?.state === "paused") {
				clearTimeout(this.idleTimer);
				this.handle = undefined;
				return true;
			}
			const ok = await this.provider.pauseById(id, this.creds);
			if (ok) {
				clearTimeout(this.idleTimer);
				this.onLifecycle?.("pause", id);
				this.handle = undefined;
			}
			return ok;
		} catch {
			return false;
		}
	}

	private creds: ProviderCreds = { secrets: {}, data: {} };

	/** Create a sandbox via the named provider (default e2b). */
	async create(opts: {
		creds: ProviderCreds;
		provider?: string;
		template?: string;
		timeoutMs?: number;
	}): Promise<SandboxHandle> {
		this.provider = getProvider(opts.provider);
		const err = this.provider.validate(opts.creds);
		if (err) throw new Error(err);
		this.creds = opts.creds;
		this.handle = await this.provider.create(opts.creds, { template: opts.template, timeoutMs: opts.timeoutMs });
		this.report("start");
		this.armIdlePause();
		return this.handle;
	}

	/** Reconnect to a running or paused sandbox by id; null if gone. */
	async connect(id: string, creds: ProviderCreds, provider?: string): Promise<SandboxHandle | null> {
		this.provider = getProvider(provider);
		if (!this.provider.capabilities.reconnect) return null;
		this.creds = creds;
		try {
			this.handle = (await this.provider.connect(id, creds)) ?? undefined;
		} catch {
			this.handle = undefined;
			return null;
		}
		if (!this.handle) return null;
		// "resume" only when the VM was actually paused — attaching to a running
		// sandbox is a connect, not a resume. Best-effort probe; unknown state
		// still reports resume (the historical label) rather than silence.
		const info = await this.provider.getInfoById?.(id, creds).catch(() => null);
		this.report(info?.state === "paused" ? "resume" : "connect");
		this.armIdlePause();
		return this.handle;
	}

	get providerName(): string {
		return this.provider.name;
	}

	/** Extend the sandbox lifetime from now (idle keepalive while a run is active). */
	async keepalive(minutes: number): Promise<void> {
		this.touch();
		await this.handle?.setTimeout?.(minutes * 60_000).catch(swallow("sandbox", "op"));
	}

	async runIn(dir: string, command: string, timeoutMs = 120_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		if (!this.handle) throw new Error("Sandbox not initialized.");
		this.touch();
		return this.handle.run(command, { cwd: dir, timeoutMs });
	}

	/** Clone and return the repo's default branch ("" if undetectable). */
	async cloneRepo(repoUrl: string, token: string, dest: string): Promise<string> {
		const authed = repoUrl.replace("https://", `https://x-access-token:${token}@`);
		// Partial clone first (big repos fetch blobs on demand); full fallback.
		let result = await this.runIn("/home/user", `git clone --filter=blob:none ${authed} ${dest}`, 300_000);
		if (result.exitCode !== 0) {
			await this.runIn("/home/user", `rm -rf ${dest}`, 30_000).catch(swallow("sandbox", "op"));
			result = await this.runIn("/home/user", `git clone ${authed} ${dest}`, 300_000);
		}
		if (result.exitCode !== 0) throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
		const head = await this.runIn(dest, "git symbolic-ref refs/remotes/origin/HEAD --short", 15_000).catch(swallow("sandbox", "op"));
		return head?.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, "") : "";
	}

	async commitAndPush(dir: string, branch: string, message: string, excludePaths: string[] = []): Promise<void> {
		const cmds = [
			`git checkout -B ${branch}`,
			"git add -A",
			...excludePaths.map((p) => `git reset -q -- ${JSON.stringify(p)} || true`),
			`git -c user.name=Kronyx -c user.email=kronyx@local commit -m ${JSON.stringify(message)} || true`,
			`git push -u origin ${branch}`,
		];
		for (const cmd of cmds) {
			const r = await this.runIn(dir, cmd);
			if (r.exitCode !== 0 && !cmd.includes("|| true")) {
				throw new Error(`git failed (${cmd}): ${r.stderr || r.stdout}`);
			}
		}
	}

	/** Create/switch to the session feature branch (idempotent). */
	async createBranch(dir: string, branch: string): Promise<void> {
		const r = await this.runIn(dir, `git checkout -B ${branch}`);
		if (r.exitCode !== 0) throw new Error(`git checkout -B failed: ${r.stderr || r.stdout}`);
	}

	/** Fetch origin/<base>; returns how many commits the branch is behind (0 = up to date). */
	async driftBehind(dir: string, base: string): Promise<number> {
		await this.runIn(dir, `git fetch origin ${base}`).catch(swallow("sandbox", "op"));
		const r = await this.runIn(dir, `git rev-list --count HEAD..origin/${base}`).catch(swallow("sandbox", "op"));
		return r && r.exitCode === 0 ? Number(r.stdout.trim()) || 0 : 0;
	}

	/** Rebase HEAD onto origin/<base>; returns false on conflict (rebase aborted). */
	async rebaseOnto(dir: string, base: string): Promise<boolean> {
		const r = await this.runIn(dir, `git rebase origin/${base}`, 180_000);
		if (r.exitCode === 0) return true;
		await this.runIn(dir, "git rebase --abort").catch(swallow("sandbox", "op"));
		return false;
	}

	/** Raw file write into the sandbox filesystem (text or binary). */
	async writeFile(absPath: string, content: string | Uint8Array): Promise<void> {
		if (!this.handle) throw new Error("Sandbox not initialized.");
		this.touch();
		await this.handle.writeFile(absPath, content);
	}

	/** Raw file read; null when missing/unreadable. */
	async readFile(absPath: string): Promise<string | null> {
		if (!this.handle) return null;
		this.touch();
		return this.handle.readFile(absPath).catch(swallow("sandbox", "op", null));
	}

	async close(): Promise<void> {
		clearTimeout(this.idleTimer);
		this.report("stop");
		const id = this.sandboxId;
		if (id) await this.provider.killById(id, this.creds).catch(swallow("sandbox", "op"));
		this.handle = undefined;
	}

	get sandboxId(): string | undefined {
		return this.handle?.id;
	}

	/** Underlying provider-agnostic handle for tool factories (e.g. createRemoteFileTools). */
	get inner(): SandboxHandle | undefined {
		return this.handle;
	}
}

/** Create or find a PR for head; returns {url, number, created}. */
export async function openPr(
	repo: string,
	head: string,
	base: string,
	title: string,
	body: string,
	token: string,
): Promise<{ url: string; number: number; created: boolean }> {
	const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
	const list = await fetch(`https://api.github.com/repos/${repo}/pulls?head=${repo.split("/")[0]}:${head}&state=open`, { headers });
	const existing = (await list.json()) as { html_url?: string; number?: number }[];
	const found = Array.isArray(existing) ? existing[0] : undefined;
	if (found?.html_url && found.number) return { url: found.html_url, number: found.number, created: false };
	const created = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
		method: "POST",
		headers,
		body: JSON.stringify({ title, body, head, base }),
	});
	if (!created.ok) throw new Error(`PR creation failed (${created.status}): ${await created.text()}`);
	const pr = (await created.json()) as { html_url: string; number: number };
	return { url: pr.html_url, number: pr.number, created: true };
}
