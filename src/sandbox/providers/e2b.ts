import { Sandbox } from "e2b";
import type { ExecResult, ProviderCreds, SandboxHandle, SandboxProvider } from "../provider";
import { swallow } from "../../lib/errlog";

const apiKey = (creds: ProviderCreds): string => creds.secrets.e2bApiKey ?? process.env.E2B_API_KEY ?? "";

class E2bHandle implements SandboxHandle {
	constructor(private readonly sbx: Sandbox) {}

	get id(): string {
		return (this.sbx as unknown as { sandboxId: string }).sandboxId;
	}

	async run(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<ExecResult> {
		try {
			const r = await this.sbx.commands.run(command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
			return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
		} catch (err) {
			// commands.run throws CommandExitError on nonzero exit — other
			// providers return ExecResult, and callers rely on exitCode +
			// stderr (e.g. grep's exit 1 on no matches). Normalize.
			const e = err as { exitCode?: number; stdout?: string; stderr?: string };
			if (typeof e?.exitCode === "number") return { exitCode: e.exitCode, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
			throw err;
		}
	}

	readFile(path: string): Promise<string> {
		return this.sbx.files.read(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await this.sbx.files.write(path, content);
	}

	setTimeout(timeoutMs: number): Promise<void> {
		return this.sbx.setTimeout(timeoutMs);
	}
}

export const e2bProvider: SandboxProvider = {
	name: "e2b",
	capabilities: { pause: true, reconnect: true, orphanSweep: true },
	secretKeys: ["e2bApiKey"],

	validate(creds) {
		return apiKey(creds) ? null : "No E2B API key — set it in Settings → Secrets (or E2B_API_KEY).";
	},

	async create(creds, opts) {
		const key = apiKey(creds);
		const sbx = opts.template
			? await Sandbox.create(opts.template, { apiKey: key, timeoutMs: opts.timeoutMs })
			: await Sandbox.create({ apiKey: key, timeoutMs: opts.timeoutMs });
		return new E2bHandle(sbx);
	},

	async connect(id, creds) {
		try {
			return new E2bHandle(await Sandbox.connect(id, { apiKey: apiKey(creds) }));
		} catch {
			return null;
		}
	},

	async pauseById(id, creds) {
		return Sandbox.betaPause(id, { apiKey: apiKey(creds) }).catch(swallow("e2b", "op", false));
	},

	async killById(id, creds) {
		const res = await fetch(`https://api.e2b.app/sandboxes/${encodeURIComponent(id)}`, {
			method: "DELETE",
			headers: { "X-API-KEY": apiKey(creds) },
			signal: AbortSignal.timeout(15_000),
		}).catch(swallow("e2b", "op"));
		return !!res && (res.ok || res.status === 404);
	},

	async listLive(creds) {
		const res = await fetch("https://api.e2b.app/v2/sandboxes", {
			headers: { "X-API-KEY": apiKey(creds) },
			signal: AbortSignal.timeout(15_000),
		}).catch(swallow("e2b", "op"));
		if (!res?.ok) return [];
		const list = (await res.json()) as { sandboxID?: string; sandboxId?: string; startedAt?: string }[];
		return list.map((s) => ({ id: s.sandboxID ?? s.sandboxId ?? "", startedAt: s.startedAt })).filter((s) => s.id);
	},
};
