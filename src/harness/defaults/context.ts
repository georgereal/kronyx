/**
 * Context policy adapter (vscode-free). The mechanical projection/compaction
 * implementation lives in src/context/adapters/harnessProjection.ts so the IDE
 * and cloud harness use one shared context pipeline; this file exposes it
 * through the kernel ContextPolicy seam and owns harness-facing instructions.
 */

import type { ToolSpec } from "../core/contracts";
import type { HarnessState } from "../core/projections";
import type { ContextPolicy } from "../core/policies/context";
import {
	COMPACT_CHUNK,
	COMPACT_HEAD_CHARS,
	COMPACT_OVER_CHARS,
	DEFAULT_PROJECTION_BUDGET,
	DIGEST_HEAD_CHARS,
	DIGEST_OVER_CHARS,
	KEEP_RECENT_MESSAGES,
	KEEP_RECENT_RESULTS,
	RECENT_RESULT_CAP_CHARS,
	buildHarnessContextProjection,
	capResult,
	compactHistory,
	inputBudgetForWindow,
	prefixHash,
	taskBoard,
	type ProjectionBudget,
} from "../../context/adapters/harnessProjection";
import { createHarnessContextManager } from "../../context/adapters/harnessContextManager";

export type { ProjectedContext } from "../core/policies/context";
export {
	COMPACT_CHUNK,
	COMPACT_HEAD_CHARS,
	COMPACT_OVER_CHARS,
	DIGEST_HEAD_CHARS,
	DIGEST_OVER_CHARS,
	KEEP_RECENT_MESSAGES,
	KEEP_RECENT_RESULTS,
	RECENT_RESULT_CAP_CHARS,
	capResult,
	compactHistory,
	inputBudgetForWindow,
	prefixHash,
	taskBoard,
};

export const LOG_SLICE = "log_slice";
export const LOG_SLICE_SPEC: ToolSpec = {
	name: LOG_SLICE,
	description: "Return the session log events with seq from..to (inclusive). Use it to recover a tool result that was elided, by its seq.",
	inputSchema: {
		type: "object",
		properties: { from: { type: "integer", minimum: 1 }, to: { type: "integer", minimum: 1 } },
		required: ["from", "to"],
	},
};

export const SYSTEM_INSTRUCTIONS = [
	"You are the coding agent inside the Kronyx harness.",
	"Work through the task board: create tasks with ordered steps, prove each step with the tool-call ids that finished ok, and finish only when every task is done.",
	"Ledger ids (t1, s3) are internal bookkeeping — in anything the user reads, refer to tasks and steps by their content. If you must cite one, wrap it in braces ({t1}, {s3}) so it renders as the item's title.",
	"Match answer depth to the ask: a survey gets a concise map and an offer to go deeper on any section; write exhaustive detail only when asked.",
	"Format the final answer for scanning: short ## section headers, bold key terms, bullets over paragraphs — never a wall of text.",
	"Don't narrate board status or restate what you are about to do — the user watches the board and the tool calls live. Report outcomes and decisions, not intentions.",
	"When you finish a run, end the summary with a fenced ```suggestions block holding a JSON array of 2-4 short next steps the user might want — pending work, natural follow-ups, or decisions they may want to make. Each is something the user can pick to continue; write them as imperatives a user could hand back as a task. Omit the block only when nothing meaningful remains.",
	"Before redoing analysis, check what earlier work produced — list_plans/read_plan recall saved deliverables, and prior tool results stay recoverable via log_slice/recall_context. Reuse fresh findings instead of re-deriving them.",
	"Tool results may be elided to a stub that cites a seq. Recover the full text with log_slice.",
].join("\n");

export function buildContext(state: HarnessState, tools: readonly ToolSpec[], system = SYSTEM_INSTRUCTIONS, runId?: string, budget?: ProjectionBudget) {
	return buildHarnessContextProjection(state, tools, system, runId, budget);
}

/**
 * Today's behavior as the default ContextPolicy — a factory because the budget
 * scales with the model's context window: compacting at a fixed size throws
 * away most of a large-window model's usable context (and compaction amnesia
 * is a loop generator). resolveBehaviorProfile passes the token-measured
 * budget derived from the model's window and output reserve.
 */
export function makeContextPolicy(budget: ProjectionBudget = DEFAULT_PROJECTION_BUDGET): ContextPolicy {
	const manager = createHarnessContextManager(budget);
	return {
		build: (state, tools, system, runId) => manager.build(state, tools, system, runId),
		capResult: (message) => manager.capResult(message),
		taskBoard: (state, runId) => manager.taskBoard(state, runId),
		keepRecentMessages: manager.keepRecentMessages,
		budgetTokens: manager.budgetTokens,
		outputReserveTokens: manager.outputReserveTokens,
		manifest: (request) => manager.manifest(request),
	};
}

export const defaultContextPolicy: ContextPolicy = makeContextPolicy();
