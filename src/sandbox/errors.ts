/**
 * Sandbox-death classification — vscode-free, shared by the tool layer and
 * the worker executor so both agree on what "the VM is gone" looks like.
 *
 * Thrown tool errors reach the agent as tool-result text (`@cline/agents`
 * converts them), so death also needs a side-channel: `delegatingHandle`
 * sets `live.dead` when a call rejects with a death signature and the
 * executor recovers the run on a fresh VM.
 */

/** Marker error for a dead/unreachable VM — distinct from a task error. */
export class SandboxDeadError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = "SandboxDeadError";
	}
}

const DEATH_RE = /sandbox (was )?not found|connection to sandbox|killed or reached its|sandbox died/i;

/** The VM is gone (EOL/killed) — distinct from a task error; recoverable by recreate+reclone. */
export function isSandboxDeath(err: unknown): boolean {
	if (err instanceof SandboxDeadError) return true;
	const m = err instanceof Error ? err.message : String(err);
	return DEATH_RE.test(m);
}
