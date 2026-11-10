import { Sandbox } from "e2b";

/**
 * vscode-free E2B sandbox wrapper shared by the extension's cloud controller
 * and the web worker. Credential/config resolution and prompting live in the
 * vscode-specific subclass (e2b.ts) or the worker's settings layer.
 */
export class SandboxCore {
	protected sandbox: Sandbox | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private onPause: (() => void) | undefined;
	private idleMinutes = 0;
	/** Lifecycle reporter — callers wire this to persistence (sqlite or Mongo). */
	onLifecycle: ((event: string, sandboxId: string) => void) | undefined;

	protected report(event: string): void {
		const id = this.sandboxId;
		if (id) this.onLifecycle?.(event, id);
	}

	/** Called when the sandbox is about to be beta-paused (idle hot-load). */
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
		if (this.idleMinutes <= 0) return;
		this.idleTimer = setTimeout(() => {
			void this.pause().then((ok) => ok && this.onPause?.());
		}, this.idleMinutes * 60_000);
	}

	/** Pause the sandbox (snapshot filesystem/memory); resumes via connect(). */
	async pause(): Promise<boolean> {
		if (!this.sandbox) return false;
		const id = this.sandboxId;
		if (!id) return false;
		try {
			const ok = await Sandbox.betaPause(id);
			if (ok) {
				this.onLifecycle?.("pause", id);
				this.sandbox = undefined;
			}
			return ok;
		} catch {
			return false;
		}
	}

	/** Create a sandbox with an explicit key + options (no prompting). */
	async create(opts: { apiKey: string; template?: string; timeoutMs?: number }): Promise<Sandbox> {
		const sbx = opts.template
			? await Sandbox.create(opts.template, { apiKey: opts.apiKey, timeoutMs: opts.timeoutMs })
			: await Sandbox.create({ apiKey: opts.apiKey, timeoutMs: opts.timeoutMs });
		this.sandbox = sbx;
		this.report("start");
		this.armIdlePause();
		return sbx;
	}

	/** Reconnect to a running or paused sandbox by id (auto-resumes); null if gone. */
	async connect(id: string, apiKey?: string): Promise<Sandbox | null> {
		try {
			this.sandbox = await Sandbox.connect(id, apiKey ? { apiKey } : undefined);
			this.report("resume");
			this.armIdlePause();
			return this.sandbox;
		} catch {
			this.sandbox = undefined;
			return null;
		}
	}

	/** Extend the sandbox TTL from now (idle keepalive while a run is active). */
	async keepalive(minutes: number): Promise<void> {
		await this.sandbox?.setTimeout(minutes * 60_000).catch(() => {});
	}

	async runIn(dir: string, command: string, timeoutMs = 120_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		if (!this.sandbox) throw new Error("Sandbox not initialized.");
		const result = await this.sandbox.commands.run(command, { cwd: dir, timeoutMs });
		return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
	}

	/** Clone and return the repo's default branch ("" if undetectable). */
	async cloneRepo(repoUrl: string, token: string, dest: string): Promise<string> {
		const authed = repoUrl.replace("https://", `https://x-access-token:${token}@`);
		const result = await this.runIn("/home/user", `git clone ${authed} ${dest}`, 300_000);
		if (result.exitCode !== 0) throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
		const head = await this.runIn(dest, "git symbolic-ref refs/remotes/origin/HEAD --short", 15_000).catch(() => undefined);
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
		await this.runIn(dir, `git fetch origin ${base}`).catch(() => undefined);
		const r = await this.runIn(dir, `git rev-list --count HEAD..origin/${base}`).catch(() => undefined);
		return r && r.exitCode === 0 ? Number(r.stdout.trim()) || 0 : 0;
	}

	/** Rebase HEAD onto origin/<base>; returns false on conflict (rebase aborted). */
	async rebaseOnto(dir: string, base: string): Promise<boolean> {
		const r = await this.runIn(dir, `git rebase origin/${base}`, 180_000);
		if (r.exitCode === 0) return true;
		await this.runIn(dir, "git rebase --abort").catch(() => undefined);
		return false;
	}

	/** Raw file write into the sandbox filesystem (text or binary). */
	async writeFile(absPath: string, content: string | Uint8Array): Promise<void> {
		if (!this.sandbox) throw new Error("Sandbox not initialized.");
		await this.sandbox.files.write(absPath, content);
	}

	/** Raw file read; null when missing/unreadable. */
	async readFile(absPath: string): Promise<string | null> {
		if (!this.sandbox) return null;
		return this.sandbox.files.read(absPath).catch(() => null);
	}

	async close(): Promise<void> {
		clearTimeout(this.idleTimer);
		this.report("stop");
		await this.sandbox?.kill().catch(() => {});
		this.sandbox = undefined;
	}

	get sandboxId(): string | undefined {
		return (this.sandbox as unknown as { sandboxId?: string })?.sandboxId;
	}

	/** Underlying e2b Sandbox for tool factories (e.g. createRemoteFileTools). */
	get inner(): Sandbox | undefined {
		return this.sandbox;
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
