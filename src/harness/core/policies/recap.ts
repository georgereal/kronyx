/**
 * Recap policy (vscode-free). Decides when a compaction brief is written and
 * emits it. The kernel consumes the trigger flags; the policy owns the rest.
 * Request strategies without local context (server-side conversations) simply
 * never call it.
 */

import type { EventBody, ModelPort, ModelRequest } from "../contracts";
import type { HarnessState } from "../projections";
import type { ContextPolicy } from "./context";

export interface RecapCtx {
	model: ModelPort;
	emit(body: EventBody): Promise<void>;
	state: HarnessState;
	/** Run identity used in durable compaction ids when available. */
	runId?: string;
	signal: AbortSignal;
	/** Last request's real input size — the pressure trigger. */
	lastInputTokens: number;
	/** A task just closed: compress its span. */
	taskDone: boolean;
	/** Host asked for compaction now. */
	forced: boolean;
	/** Resolved context policy (boundary + budget). */
	context: ContextPolicy;
	/** Observability hook invoked immediately before an auxiliary recap model call. */
	onModelRequest?: (request: Pick<ModelRequest, "system" | "messages">) => Promise<void>;
}

export interface RecapPolicy {
	maybeRecap(ctx: RecapCtx): Promise<void>;
}
