/**
 * Request strategy (vscode-free): the lifecycle around one model call. The
 * default replays the full projection every turn; a capability strategy (e.g.
 * server-side conversations) may emit lifecycle events, send deltas, and sync
 * after the response is logged. Strategies propose nothing — they emit only
 * through ctx.emit so the durable record stays kernel-owned.
 */

import type { EventBody, ModelPort, ModelRequest, ModelResponse, ToolSpec } from "../contracts";
import type { HarnessState } from "../projections";
import type { HarnessBehavior } from "../behavior";

export interface StrategyCtx {
	/** Current projection — always fresh (bound to the loop's state). */
	readonly state: HarnessState;
	/** Specs normally offered to the model (pre-strip). Used to shape context. */
	offered: readonly ToolSpec[];
	/** Specs sent with this request ([] while stripped at the loop ladder's top). */
	tools: readonly ToolSpec[];
	system: string;
	turn: number;
	runId: string;
	/** Loop-owned emit; strategies append lifecycle events only through it. */
	emit(body: EventBody): Promise<void>;
	signal: AbortSignal;
	onReasoningDelta?: (text: string) => void;
	onTextDelta?: (text: string) => void;
	/** Resolved behavior for context shaping and recap triggers. */
	behavior: HarnessBehavior;
	model: ModelPort;
	/** Recap trigger inputs — the loop resets its own flags before call(). */
	recap: { lastInputTokens: number; taskDone: boolean; forced: boolean };
	/** The model call itself, bound by the loop. */
	complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface RequestTurn {
	response: ModelResponse;
	boardHash?: string;
}

export interface RequestStrategy {
	/** Runs the request lifecycle up to a response (bind/delta/send or full projection). */
	call(ctx: StrategyCtx): Promise<RequestTurn>;
	/** After the model.response event is logged (e.g. mark the server copy synced). */
	committed?(ctx: StrategyCtx, turn: RequestTurn): Promise<void>;
}
