import type { ExecResult, ProviderCreds, SandboxHandle, SandboxProvider } from "../provider";

/**
 * Vercel Sandbox provider (beta SDK) — ephemeral microVMs tied to a Vercel
 * team/project. No pause/resume: sandboxes die at their timeout and each run
 * creates a fresh one (the executor's re-clone path handles that).
 * SDK is loaded lazily via a variable specifier so this module typechecks and
 * bundles without the dep; the backend resolves it from its node_modules.
 */
const PKG = "@vercel/sandbox";

async function sdk(_creds: ProviderCreds): Promise<any> {
	const mod: any = await import(PKG);
	return mod.Sandbox;
}

const auth = (creds: ProviderCreds) => ({
	token: creds.secrets.vercelToken,
	teamId: creds.secrets.vercelTeamId,
	projectId: creds.secrets.vercelProjectId,
});

class VercelHandle implements SandboxHandle {
	constructor(private readonly sbx: any) {}

	get id(): string {
		return String(this.sbx.sandboxId);
	}

	async run(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<ExecResult> {
		const cmd = await this.sbx.runCommand({ cmd: "sh", args: ["-c", command], cwd: opts.cwd });
		const finished = await cmd.wait();
		return {
			exitCode: finished.exitCode ?? 1,
			stdout: typeof finished.stdout === "function" ? await finished.stdout() : "",
			stderr: typeof finished.stderr === "function" ? await finished.stderr() : "",
		};
	}

	async readFile(path: string): Promise<string> {
		const buf = await this.sbx.readFileToBuffer({ path });
		if (buf === null || buf === undefined) throw new Error(`readFile failed: ${path}`);
		return Buffer.from(buf).toString("utf8");
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
		await this.sbx.writeFiles([{ path, content: data }]);
	}
}

export const vercelProvider: SandboxProvider = {
	name: "vercel",
	capabilities: { pause: false, reconnect: false, orphanSweep: false },
	secretKeys: ["vercelToken", "vercelTeamId", "vercelProjectId"],

	validate(creds) {
		if (!creds.secrets.vercelToken) return "No Vercel token — set vercelToken in Settings → Secrets.";
		if (!creds.secrets.vercelTeamId || !creds.secrets.vercelProjectId)
			return "Vercel Sandbox needs vercelTeamId and vercelProjectId in Settings → Secrets.";
		return null;
	},

	async create(creds, opts) {
		const Sandbox = await sdk(creds);
		const sbx = await Sandbox.create({
			...auth(creds),
			runtime: creds.secrets.vercelRuntime || "node22",
			timeout: opts.timeoutMs,
		});
		return new VercelHandle(sbx);
	},

	async connect(id, creds) {
		try {
			const Sandbox = await sdk(creds);
			const sbx = await Sandbox.get({ ...auth(creds), sandboxId: id });
			return sbx ? new VercelHandle(sbx) : null;
		} catch {
			return null;
		}
	},

	async killById(id, creds) {
		try {
			const Sandbox = await sdk(creds);
			await Sandbox.stop({ ...auth(creds), sandboxId: id });
			return true;
		} catch {
			return false;
		}
	},
};
