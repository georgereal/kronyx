/**
 * Context policy (vscode-free). Builds the normalized projection sent to the
 * model and owns the context-shaping details a provider/model may override:
 * digests, caps, compaction boundaries, and the task board snapshot. The kernel
 * never bypasses it — every request's messages come from `build`.
 */

import type { ToolSpec } from "../contracts";
import type { HarnessState, Message } from "../projections";
import type { ContextManifest, PayloadMode } from "../../../context/contracts/context";

export interface ProjectedContext {
	system: string;
	tools: ToolSpec[];
	messages: Message[];
	prefixHash: string;
	/** Measured input size (system + tool schemas + messages) in real tokens — the same measurement the budget enforcement used. */
	estimatedInputTokens?: number;
	/** Level-0 input measurement before graduated reduction — the utilization signal compaction triggers must use. */
	unreducedInputTokens?: number;
	/** True when even maximum reduction could not fit the input budget; recorded honestly in the manifest rather than silently dropped. */
	overBudget?: boolean;
	/** Graduated reduction level applied (0 = none). */
	reductionLevel?: number;
	/** Inferred call purpose for this projection. */
	purpose?: import("../../../context/contracts/context").CallPurpose;
}

type ToolMessage = Extract<Message, { kind: "tool" }>;

export interface ContextManifestRequest {
	state: HarnessState;
	tools: readonly ToolSpec[];
	system: string;
	turn: number;
	runId: string;
	sessionId?: string;
	messages: readonly Message[];
	payloadMode: PayloadMode;
	purpose?: import("../../../context/contracts/context").CallPurpose;
	providerId?: string;
	modelId?: string;
	compactionApplied?: boolean;
	compactionAuthority?: "local" | "provider" | "none";
	budgetPressure?: boolean;
	forcedCompaction?: boolean;
	/** Reserved output capacity of the active model, surfaced for manifest honesty. */
	outputReserveTokens?: number;
	/** Effective-context input tokens when the wire payload is a delta of it (server-side conversations); defaults to the wire measurement. */
	effectiveInputTokens?: number;
	/** Graduated reduction level the projection applied (0 = none). */
	reductionLevel?: number;
	/** True when the input could not fit the budget even at maximum reduction — a critical budget violation the manifest must record, never hide. */
	overBudget?: boolean;
}


export interface ContextPolicy {
	/** Full projection for a stateless request, or a first bind to server-side state. */
	build(state: HarnessState, tools: readonly ToolSpec[], system: string, runId?: string): ProjectedContext;
	/** Per-call cap applied to recent results and to delta sends. */
	capResult(m: ToolMessage): Message;
	/** Task board as text, or undefined when the run has no tasks. */
	taskBoard(state: HarnessState, runId?: string): string | undefined;
	/** Messages newer than this many are never compacted or covered by a recap. */
	keepRecentMessages: number;
	/** Usable input budget in real tokens (window minus output reserve minus safety margin); the hard cap the projection enforces. */
	budgetTokens: number;
	/** Output capacity reserved when the budget was computed — surfaced for manifest honesty. */
	outputReserveTokens: number;
	/** Build the per-invocation context manifest. Implementations are part of the injected context manager. */
	manifest?(request: ContextManifestRequest): ContextManifest | Promise<ContextManifest>;
}
