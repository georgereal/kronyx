import { Sandbox } from "e2b";
import type { ExecResult, ProviderCreds, SandboxHandle, SandboxProvider } from "../provider";
import { PUBLIC_E2B_TEMPLATES } from "../templateCatalog";
import { swallow } from "../../lib/errlog";

const apiKey = (creds: ProviderCreds): string => creds.secrets.e2bApiKey ?? process.env.E2B_API_KEY ?? "";

class E2bHandle implements SandboxHandle {
	constructor(private readonly sbx: Sandbox) {}

	get id(): string {
		return (this.sbx as unknown as { sandboxId: string }).sandboxId;
	}

	/** Background handles for in-flight commands — interrupt() SIGKILLs them. */
	private activeCmds = new Set<{ pid: number }>();

	async run(command: string, opts: { cwd: string; timeoutMs?: number; onOutput?: (chunk: string) => void }): Promise<ExecResult> {
		const handle = await this.sbx.commands.run(command, {
			cwd: opts.cwd,
			timeoutMs: opts.timeoutMs,
			background: true,
			onStdout: opts.onOutput,
			onStderr: opts.onOutput,
		});
		this.activeCmds.add(handle);
		try {
			const r = await handle.wait();
			return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
		} catch (err) {
			// wait() throws CommandExitError on nonzero exit (and on kill) —
			// other providers return ExecResult, and callers rely on exitCode +
			// stderr (e.g. grep's exit 1 on no matches). Normalize.
			const e = err as { exitCode?: number; stdout?: string; stderr?: string };
			if (typeof e?.exitCode === "number") return { exitCode: e.exitCode, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
			throw err;
		} finally {
			this.activeCmds.delete(handle);
		}
	}

	async interrupt(): Promise<void> {
		await Promise.all([...this.activeCmds].map((h) => this.sbx.commands.kill(h.pid).catch(() => false)));
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
	capabilities: { pause: true, reconnect: true, orphanSweep: true, autoPause: true, resume: true, snapshot: true, fork: true },
	secretKeys: ["e2bApiKey"],

	validate(creds) {
		return apiKey(creds) ? null : "No E2B API key — set it in Settings → Secrets (or E2B_API_KEY).";
	},

	async create(creds, opts) {
		const key = apiKey(creds);
		// lifecycle.onTimeout: the provider-side idle/timeout policy — pauses
		// snapshot the VM instead of killing it, and survive worker restarts
		// (our in-process idle timer doesn't). autoResume wakes a paused VM on
		// inbound traffic (public URLs / browser_use).
		const lifecycle =
			opts.autoPause || opts.autoResume
				? { onTimeout: "pause" as const, ...(opts.autoResume ? { autoResume: true } : {}) }
				: undefined;
		const base = { apiKey: key, timeoutMs: opts.timeoutMs, ...(lifecycle ? { lifecycle } : {}) };
		const sbx = opts.template
			? await Sandbox.create(opts.template, base)
			: await Sandbox.create(base);
		return new E2bHandle(sbx);
	},

	async connect(id, creds) {
		try {
			return new E2bHandle(await Sandbox.connect(id, { apiKey: apiKey(creds) }));
		} catch {
			return null;
		}
	},

	async resume(id, creds, opts) {
		try {
			// onResume 'restore' replays the memory snapshot; 'reboot' cold-boots
			// from the disk snapshot — the worktree survives even when the
			// memory snapshot is unusable (envd unresponsive at pause).
			return new E2bHandle(
				await Sandbox.connect(id, { apiKey: apiKey(creds), onResume: opts?.memory === false ? "reboot" : "restore" }),
			);
		} catch {
			return null;
		}
	},

	async checkpointById(id, creds, opts) {
		try {
			const snap = await Sandbox.createSnapshot(id, {
				apiKey: apiKey(creds),
				...(opts?.mode ? { mode: opts.mode } : {}),
				...(opts?.name ? { name: opts.name } : {}),
			});
			return snap.snapshotId ?? null;
		} catch {
			return null;
		}
	},

	async deleteSnapshotById(id, creds) {
		try {
			return await Sandbox.deleteSnapshot(id, { apiKey: apiKey(creds) });
		} catch {
			return false;
		}
	},

	async forkById(id, creds, count, timeoutMs) {
		try {
			const results = await Sandbox.fork(id, { apiKey: apiKey(creds), count, ...(timeoutMs ? { timeoutMs } : {}) });
			return results.filter((r): r is Sandbox => !(r instanceof Error)).map((s) => new E2bHandle(s));
		} catch {
			return [];
		}
	},

	async getInfoById(id, creds) {
		try {
			const info = await Sandbox.getInfo(id, { apiKey: apiKey(creds) });
			return {
				state: info.state === "paused" ? "paused" : "running",
				templateId: info.templateId,
				name: info.name,
				envdUnresponsiveAtPause: (info as { envdUnresponsiveAtPause?: boolean }).envdUnresponsiveAtPause,
			};
		} catch (err) {
			if (err instanceof Error && /not found|not exist/i.test(err.message)) return { state: "gone" as const };
			return null;
		}
	},

	async pauseById(id, creds) {
		try {
			await Sandbox.pause(id, { apiKey: apiKey(creds) });
			return true;
		} catch (err) {
			// Already paused or gone is the goal state — returning false would
			// leave the row "active" and the janitor retries every sweep.
			if (err instanceof Error && /not found/i.test(err.message)) return true;
			swallow("e2b", "op")(err);
			return false;
		}
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

	async listTemplates(creds) {
		const res = await fetch("https://api.e2b.app/templates", {
			headers: { "X-API-KEY": apiKey(creds) },
			signal: AbortSignal.timeout(15_000),
		}).catch(swallow("e2b", "op"));
		const list = res?.ok ? ((await res.json().catch(swallow("e2b", "op", []))) as { templateID?: string; names?: string[]; public?: boolean }[]) : [];
		const account = (Array.isArray(list) ? list : [])
			.map((t) => ({ id: String(t.templateID ?? ""), names: t.names ?? [], public: !!t.public }))
			.filter((t) => t.id);
		// Public fleet isn't returned by the API but is creatable by name —
		// merge it in; account builds with the same slug win.
		const slugs = new Set(account.flatMap((t) => t.names.map((n) => n.split(":")[0])));
		return [...account, ...PUBLIC_E2B_TEMPLATES.filter((t) => !slugs.has(t.id))];
	},
};
