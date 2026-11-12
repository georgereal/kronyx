import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ProviderCreds, SandboxHandle, SandboxProvider } from "../provider";

/**
 * Docker provider — runs session sandboxes as containers on the worker's
 * Docker host (or a remote one via dockerHost / DOCKER_HOST, e.g. ssh://).
 * Shared-host isolation — trusted workloads only.
 */
const DEFAULT_IMAGE = "node:22";

const dockerEnv = (creds: ProviderCreds): NodeJS.ProcessEnv => ({
	...process.env,
	...(creds.secrets.dockerHost ? { DOCKER_HOST: creds.secrets.dockerHost } : {}),
});

function cli(
	creds: ProviderCreds,
	args: string[],
	opts: { input?: string | Uint8Array; timeoutMs?: number; onChild?: (c: ChildProcess) => void } = {},
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = execFile(
			"docker",
			args,
			{ env: dockerEnv(creds), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout, stderr) => {
				resolve({ exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
			},
		);
		opts.onChild?.(child);
		child.stdin?.end(opts.input);
	});
}

class DockerHandle implements SandboxHandle {
	constructor(
		private readonly creds: ProviderCreds,
		readonly id: string,
	) {}

	private activeCmds = new Set<ChildProcess>();

	async run(command: string, opts: { cwd: string; timeoutMs?: number }): Promise<ExecResult> {
		let child: ChildProcess | undefined;
		const r = await cli(this.creds, ["exec", "-w", opts.cwd, this.id, "sh", "-c", command], {
			timeoutMs: (opts.timeoutMs ?? 120_000) + 5_000,
			onChild: (c) => {
				child = c;
				this.activeCmds.add(c);
			},
		});
		if (child) this.activeCmds.delete(child);
		return r;
	}

	async interrupt(): Promise<void> {
		for (const c of this.activeCmds) c.kill("SIGKILL");
		// The exec'd process inside the container runs as `sh` — kill it too
		// (the container's only other process is `sleep infinity`).
		void cli(this.creds, ["exec", this.id, "pkill", "-9", "sh"], { timeoutMs: 10_000 }).catch(() => {});
	}

	async readFile(path: string): Promise<string> {
		const r = await cli(this.creds, ["exec", this.id, "sh", "-c", 'cat "$1"', "_", path]);
		if (r.exitCode !== 0) throw new Error(`readFile failed: ${r.stderr || r.stdout}`);
		return r.stdout;
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const input = typeof content === "string" ? content : Buffer.from(content).toString("base64");
		const cmd = typeof content === "string" ? 'cat > "$1"' : 'base64 -d > "$1"';
		const r = await cli(this.creds, ["exec", "-i", this.id, "sh", "-c", cmd, "_", path], { input });
		if (r.exitCode !== 0) throw new Error(`writeFile failed: ${r.stderr || r.stdout}`);
	}
}

export const dockerProvider: SandboxProvider = {
	name: "docker",
	capabilities: { pause: true, reconnect: true, orphanSweep: true },
	secretKeys: ["dockerHost"],

	validate(creds) {
		// Configured = explicit host, or a reachable local socket. Otherwise the
		// provider is off — no docker CLI calls on machines without Docker.
		if (creds.secrets.dockerHost || process.env.DOCKER_HOST) return null;
		for (const sock of ["/var/run/docker.sock", join(homedir(), ".docker", "run", "docker.sock")]) {
			if (existsSync(sock)) return null;
		}
		return "Docker not configured — no socket, DOCKER_HOST, or dockerHost secret.";
	},

	async create(creds, opts) {
		const image = opts.template || creds.secrets.dockerImage || DEFAULT_IMAGE;
		const name = `kronyx-${randomUUID().slice(0, 12)}`;
		const r = await cli(creds, ["run", "-d", "--name", name, "--label", "kronyx=1", image, "sleep", "infinity"], { timeoutMs: 300_000 });
		if (r.exitCode !== 0) throw new Error(`docker run failed: ${r.stderr || r.stdout}`);
		return new DockerHandle(creds, name);
	},

	async connect(id, creds) {
		const r = await cli(creds, ["inspect", "-f", "{{.State.Running}}", id], { timeoutMs: 15_000 });
		return r.exitCode === 0 && r.stdout.trim() === "true" ? new DockerHandle(creds, id) : null;
	},

	async pauseById(id, creds) {
		return (await cli(creds, ["pause", id], { timeoutMs: 15_000 })).exitCode === 0;
	},

	async killById(id, creds) {
		return (await cli(creds, ["rm", "-f", id], { timeoutMs: 30_000 })).exitCode === 0;
	},

	async listLive(creds) {
		const r = await cli(creds, ["ps", "--filter", "label=kronyx=1", "--format", "{{.Names}} {{.CreatedAt}}"], { timeoutMs: 15_000 });
		if (r.exitCode !== 0) return [];
		return r.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [id, ...rest] = line.split(" ");
				return { id, startedAt: rest.join(" ") || undefined };
			});
	},
};
