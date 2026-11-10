import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Sandbox } from "e2b";
import { IGNORED_DIRS } from "../tools/workspace";
import { SandboxCore, openPr } from "./sandboxCore";

export { openPr };

const WORK_DIR = "/home/user/workspace";
const SYNC_FILE_LIMIT = 300;
const SYNC_BYTE_CAP = 512 * 1024;

export function sandboxEnabled(): boolean {
	return vscode.workspace.getConfiguration("kronyx").get<boolean>("sandbox.enabled", false);
}

export function sandboxBackend(): string {
	return vscode.workspace.getConfiguration("kronyx").get<string>("sandbox.backend", "local");
}

export async function e2bApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
	return process.env.E2B_API_KEY ?? (await secrets.get("kronyx.sandbox.e2bApiKey"));
}

/**
 * vscode-facing sandbox: adds settings reads, SecretStorage resolution and
 * input-box prompts on top of the vscode-free SandboxCore.
 */
export class E2bSandbox extends SandboxCore {
	/** E2B template override from settings; "" = base image. */
	private template(): string {
		return vscode.workspace.getConfiguration("kronyx").get<string>("cloud.template", "");
	}

	async ensure(secrets: vscode.SecretStorage): Promise<Sandbox> {
		if (this.inner) {
			this.applyIdle();
			return this.inner;
		}
		let key = await e2bApiKey(secrets);
		if (!key) {
			const entered = await vscode.window.showInputBox({
				title: "Kronyx: E2B API key",
				prompt: "E2B API key (stored in SecretStorage; or set E2B_API_KEY env var).",
				password: true,
				ignoreFocusOut: true,
			});
			if (!entered) throw new Error("No E2B API key configured.");
			key = entered.trim();
			await secrets.store("kronyx.sandbox.e2bApiKey", key);
		}
		const ttlMs = vscode.workspace.getConfiguration("kronyx").get<number>("cloud.ttlMinutes", 60) * 60_000;
		const sbx = await this.create({ apiKey: key, template: this.template() || undefined, timeoutMs: ttlMs });
		this.applyIdle();
		return sbx;
	}

	override async connect(id: string, apiKey?: string): Promise<Sandbox | null> {
		const sbx = await super.connect(id, apiKey);
		if (sbx) this.applyIdle();
		return sbx;
	}

	private applyIdle(): void {
		const minutes = vscode.workspace.getConfiguration("kronyx").get<number>("cloud.idlePauseMinutes", 10);
		this.setIdlePause(minutes);
	}

	/** Upload workspace files (text, capped) into the sandbox work dir. */
	async syncUp(root: string): Promise<number> {
		const sbx = this.inner;
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
		if (!this.inner) throw new Error("Sandbox not initialized.");
		const result = await this.inner.commands.run(command, { cwd: WORK_DIR, timeoutMs: 60_000 });
		return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
	}
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
