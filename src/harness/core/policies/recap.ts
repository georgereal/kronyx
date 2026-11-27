/**
 * Recap policy (vscode-free). Decides when a compaction brief is written and
 * emits it. The kernel consumes the trigger flags; the policy owns the rest.
 * Request strategies without local context (server-side conversations) simply
 * never call it.
 */

import type { EventBody, ModelPort } from "../contracts";
import type { HarnessState } from "../projections";
import type { ContextPolicy } from "./context";

export interface RecapCtx {
	model: ModelPort;
	emit(body: EventBody): Promise<void>;
	state: HarnessState;
	signal: AbortSignal;
	/** Last request's real input size — the pressure trigger. */
	lastInputTokens: number;
	/** A task just closed: compress its span. */
	taskDone: boolean;
	/** Host asked for compaction now. */
	forced: boolean;
	/** Resolved context policy (boundary + budget). */
	context: ContextPolicy;
}

export interface RecapPolicy {
	maybeRecap(ctx: RecapCtx): Promise<void>;
}
