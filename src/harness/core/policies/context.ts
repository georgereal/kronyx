/**
 * Context policy (vscode-free). Builds the normalized projection sent to the
 * model and owns the context-shaping details a provider/model may override:
 * digests, caps, compaction boundaries, and the task board snapshot. The kernel
 * never bypasses it — every request's messages come from `build`.
 */

import type { ToolSpec } from "../contracts";
import type { HarnessState, Message } from "../projections";

export interface ProjectedContext {
	system: string;
	tools: ToolSpec[];
	messages: Message[];
	prefixHash: string;
}

type ToolMessage = Extract<Message, { kind: "tool" }>;

export interface ContextPolicy {
	/** Full projection for a stateless request, or a first bind to server-side state. */
	build(state: HarnessState, tools: readonly ToolSpec[], system: string, runId?: string): ProjectedContext;
	/** Per-call cap applied to recent results and to delta sends. */
	capResult(m: ToolMessage): Message;
	/** Task board as text, or undefined when the run has no tasks. */
	taskBoard(state: HarnessState, runId?: string): string | undefined;
	/** Messages newer than this many are never compacted or covered by a recap. */
	keepRecentMessages: number;
	/** Projected-context size budget; the default recap policy uses it as the pressure trigger. */
	budgetChars: number;
}
