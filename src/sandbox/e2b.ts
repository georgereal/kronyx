import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Sandbox } from "e2b";
import { IGNORED_DIRS } from "../tools/workspace";

const WORK_DIR = "/home/user/workspace";
const SYNC_FILE_LIMIT = 300;
const SYNC_BYTE_CAP = 512 * 1024;

export function sandboxEnabled(): boolean {
	return vscode.workspace.getConfiguration("kronyx").get<boolean>("sandbox.enabled", false);
}

export function sandboxBackend(): string {
	return vscode.workspace.getConfiguration("kronyx").get<string>("sandbox.backend", "local");
}

async function apiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
	return process.env.E2B_API_KEY ?? (await secrets.get("kronyx.sandbox.e2bApiKey"));
}

/**
 * Shared E2B sandbox for the window: workspace is uploaded once on first use,
 * commands run remotely, results come back. Created lazily per run.
 */
export class E2bSandbox {
	private sandbox: Sandbox | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private onPause: (() => void) | undefined;
	/** Lifecycle reporter — cloudController wires this to insertSandboxEvent. */
	onLifecycle: ((event: string, sandboxId: string) => void) | undefined;
	private report(event: string): void {
		const id = this.sandboxId;
		if (id) this.onLifecycle?.(event, id);
	}

	/** Called when the sandbox is about to be beta-paused (idle hot-load). */
	setPauseHook(fn: () => void): void {
		this.onPause = fn;
	}

	/** E2B template override from settings; "" = base image. */
	private template(): string {
		return vscode.workspace.getConfiguration("kronyx").get<string>("cloud.template", "");
	}

	private armIdlePause(): void {
		clearTimeout(this.idleTimer);
		const minutes = vscode.workspace.getConfiguration("kronyx").get<number>("cloud.idlePauseMinutes", 10);
		if (minutes <= 0) return;
		this.idleTimer = setTimeout(() => {
			void this.pause().then((ok) => ok && this.onPause?.());
		}, minutes * 60_000);
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

	async ensure(secrets: vscode.SecretStorage): Promise<Sandbox> {
		if (this.sandbox) {
			this.armIdlePause();
			return this.sandbox;
		}
		const key = await apiKey(secrets);
		if (!key) {
			const entered = await vscode.window.showInputBox({
				title: "Kronyx: E2B API key",
				prompt: "E2B API key (stored in SecretStorage; or set E2B_API_KEY env var).",
				password: true,
				ignoreFocusOut: true,
			});
			if (!entered) throw new Error("No E2B API key configured.");
			await secrets.store("kronyx.sandbox.e2bApiKey", entered.trim());
			this.sandbox = await this.create(entered.trim());
		} else {
			this.sandbox = await this.create(key);
		}
		this.armIdlePause();
		return this.sandbox;
	}

	private async create(key: string): Promise<Sandbox> {
		const template = this.template();
		const ttlMs = vscode.workspace.getConfiguration("kronyx").get<number>("cloud.ttlMinutes", 60) * 60_000;
		const opts = { apiKey: key, timeoutMs: ttlMs };
		const sbx = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
		this.sandbox = sbx;
		this.report("start");
		return sbx;
	}

	/** Upload workspace files (text, capped) into the sandbox work dir. */
	async syncUp(root: string): Promise<number> {
		const sbx = this.sandbox;
		if (!sbx) return 0;
		await sbx.commands.run(`mkdir -p ${WORK_DIR}`);
		let count = 0;
		for await (const rel of walk(root, "")) {
			if (count >= SYNC_FILE_LIMIT) break;
			const abs = path.join(root, rel);
			const stat = await fs.stat(abs).catch(() => undefined);
			if (!stat || stat.size > SYNC_BYTE_CAP) continue;
			const buffer = await fs.readFile(abs);
			if (buffer.includes(0)) continue;
			await sbx.files.write(`${WORK_DIR}/${rel.split(path.sep).join("/")}`, buffer.toString("utf8"));
			count++;
		}
		return count;
	}

	async run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		if (!this.sandbox) throw new Error("Sandbox not initialized.");
		const result = await this.sandbox.commands.run(command, { cwd: WORK_DIR, timeoutMs: 60_000 });
		return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
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

	/** Reconnect to a running or paused sandbox by id (auto-resumes); null if gone. */
	async connect(id: string): Promise<Sandbox | null> {
		try {
			this.sandbox = await Sandbox.connect(id);
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

	async cloneRepo(repoUrl: string, token: string, dest: string): Promise<void> {
		const authed = repoUrl.replace("https://", `https://x-access-token:${token}@`);
		const result = await this.runIn("/home/user", `git clone ${authed} ${dest}`, 300_000);
		if (result.exitCode !== 0) throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
	}

	async commitAndPush(dir: string, branch: string, message: string): Promise<void> {
		const cmds = [
			`git checkout -B ${branch}`,
			"git add -A",
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

async function* walk(root: string, rel: string): AsyncGenerator<string> {
	const dir = path.join(root, rel);
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
		const child = rel ? `${rel}${path.sep}${entry.name}` : entry.name;
		if (entry.isDirectory()) yield* walk(root, child);
		else yield child;
	}
}
