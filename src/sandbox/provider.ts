import { dockerProvider } from "./providers/docker";
import { e2bProvider } from "./providers/e2b";
import { kubernetesProvider } from "./providers/kubernetes";
import { vercelProvider } from "./providers/vercel";

/**
 * Provider-agnostic sandbox backend.
 *
 * A SandboxProvider owns lifecycle (create/connect/pause/kill + id-based ops
 * for the janitor); a SandboxHandle is a live remote environment that runs
 * commands and reads/writes files. To add a backend (Codespaces, Daytona,
 * Fly, …): implement this interface in `providers/` and register it below.
 * Per-provider auth resolves from user settings — declare the keys in
 * `secretKeys` so run-event masking covers them.
 */

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface SandboxHandle {
	readonly id: string;
	/**
	 * Run a shell command; resolves with exit code + captured output.
	 * `onOutput` streams stdout/stderr chunks live where the backend supports
	 * it (e2b); other providers may ignore it — the result still carries all
	 * output at completion.
	 */
	run(command: string, opts: { cwd: string; timeoutMs?: number; onOutput?: (chunk: string) => void }): Promise<ExecResult>;
	/** Read a text file; rejects when missing/unreadable. */
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	/** Extend/override lifetime from now; unsupported on some providers. */
	setTimeout?(timeoutMs: number): Promise<void>;
	/**
	 * Best-effort interrupt: kill the currently running foreground command(s)
	 * so an in-flight run() resolves promptly (exitCode 130). Optional —
	 * providers without process control leave it undefined.
	 */
	interrupt?(): Promise<void>;
}

/** Credentials + settings data handed to providers (mirrors worker UserSettings). */
export interface ProviderCreds {
	secrets: Record<string, string>;
	data: Record<string, unknown>;
}

export interface SandboxProvider {
	readonly name: string;
	readonly capabilities: {
		/** Idle-pause/suspend support (e2b betaPause, docker pause). */
		pause: boolean;
		/** Reconnect by id to a previously created sandbox. */
		reconnect: boolean;
		/** Provider-side listing for janitor orphan cleanup. */
		orphanSweep: boolean;
		/** Provider-side auto-pause on timeout (survives our restarts). */
		autoPause?: boolean;
		/** Resume a paused sandbox — memory restore or disk-only cold boot. */
		resume?: boolean;
		/** Full-disk snapshot checkpoints (createSnapshot). */
		snapshot?: boolean;
		/** Fork a running sandbox into N copies (multi-slice VMs). */
		fork?: boolean;
	};
	/** Secret keys this provider consumes — masked in run events. */
	readonly secretKeys: string[];
	/** Error string when required credentials/config are missing, else null. */
	validate(creds: ProviderCreds): string | null;
	create(creds: ProviderCreds, opts: { template?: string; timeoutMs?: number; autoPause?: boolean; autoResume?: boolean }): Promise<SandboxHandle>;
	/** Reconnect to a live (or resumable) sandbox by id; null when gone. */
	connect(id: string, creds: ProviderCreds): Promise<SandboxHandle | null>;
	/**
	 * Resume a paused sandbox by id. `memory:false` cold-boots from the disk
	 * snapshot — the repo/worktree survives even when the memory snapshot is
	 * unusable (envd was unresponsive at pause, or a plain resume 409s).
	 * Null when the sandbox is gone.
	 */
	resume?(id: string, creds: ProviderCreds, opts?: { memory?: boolean }): Promise<SandboxHandle | null>;
	/** Checkpoint of a live sandbox → persisted snapshot ID, or null.
	 *  `mode:'filesystem'` persists disk only (smaller/faster; sandboxes
	 *  created from it cold-boot). `name` makes it a named snapshot template —
	 *  reusing a name assigns the build to the existing template. */
	checkpointById?(id: string, creds: ProviderCreds, opts?: { mode?: "full" | "filesystem"; name?: string }): Promise<string | null>;
	/** Delete a persisted snapshot/template (quota + storage hygiene). */
	deleteSnapshotById?(id: string, creds: ProviderCreds): Promise<boolean>;
	/** Fork a running sandbox into `count` copies; returns their handles.
	 *  `timeoutMs` sets the forked VMs' TTL — E2B otherwise applies a short
	 *  API default that can kill long slices mid-run. */
	forkById?(id: string, creds: ProviderCreds, count: number, timeoutMs?: number): Promise<SandboxHandle[]>;
	/** Id-based ops used by the janitor (no live handle). */
	pauseById?(id: string, creds: ProviderCreds): Promise<boolean>;
	/** Remote state probe — lets the janitor/events verify instead of trusting
	 *  the local DB row. "gone" = the sandbox no longer exists.
	 *  `envdUnresponsiveAtPause`: the stored snapshot can't memory-resume —
	 *  resume with `memory:false` instead of condemning it. */
	getInfoById?(id: string, creds: ProviderCreds): Promise<{ state: "running" | "paused" | "gone"; templateId?: string; name?: string; envdUnresponsiveAtPause?: boolean } | null>;
	killById(id: string, creds: ProviderCreds): Promise<boolean>;
	listLive?(creds: ProviderCreds): Promise<{ id: string; startedAt?: string }[]>;
	/** Templates usable with this account — public fleet plus account-built images. */
	listTemplates?(creds: ProviderCreds): Promise<{ id: string; names: string[]; public: boolean }[]>;
}

export const providers: Record<string, SandboxProvider> = {
	e2b: e2bProvider,
	docker: dockerProvider,
	kubernetes: kubernetesProvider,
	vercel: vercelProvider,
};

export function getProvider(name: string | null | undefined): SandboxProvider {
	const p = providers[name ?? "e2b"];
	if (!p) throw new Error(`Unknown sandbox provider "${name}" — expected one of: ${Object.keys(providers).join(", ")}`);
	return p;
}
