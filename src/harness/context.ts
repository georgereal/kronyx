/**
 * Context projection (vscode-free). Builds each model request from the projection:
 *
 *   1. stable prefix: system instructions and tool specs. Byte-identical across tasks.
 *   2. messages: append-only history. Large tool results older than the most recent
 *      few are replaced by stubs citing their seq; the full output stays in the log
 *      and `log_slice` recovers it.
 *   3. task board: a snapshot of the ledger, placed last so the earlier messages
 *      keep their cached prefix when the board changes.
 */

import { canonicalJson, hashText } from "./canonical";
import { tasksOfRun } from "./taskLedger";
import type { ToolSpec } from "./contracts";
import type { ToolCall } from "./contracts";
import type { HarnessState, Message } from "./projections";

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
	"Before redoing analysis, check what earlier work produced — list_plans/read_plan recall saved deliverables, and prior tool results stay recoverable via log_slice/recall_context. Reuse fresh findings instead of re-deriving them.",
	"Tool results may be elided to a stub that cites a seq. Recover the full text with log_slice.",
].join("\n");

/** Messages newer than this many are never compacted. */
export const KEEP_RECENT_MESSAGES = 12;
/** Old messages are compacted in whole chunks of this size, so the rendered prefix changes once per chunk, not every turn. */
export const COMPACT_CHUNK = 8;
/** Old user and assistant text longer than this is cut to a head plus an elision note. */
export const COMPACT_OVER_CHARS = 2000;
export const COMPACT_HEAD_CHARS = 600;
/** Tool results longer than this are digested once they are no longer recent. */
export const DIGEST_OVER_CHARS = 400;
/** Head of a digested tool result kept in context; the rest stays in the log. */
export const DIGEST_HEAD_CHARS = 600;
/** The most recent tool results are always kept in full. */
export const KEEP_RECENT_RESULTS = 6;
/** Hard cap on the projected message size; older digests collapse to pointers until under it. */
export const CONTEXT_BUDGET_CHARS = 120_000;

export interface ProjectedContext {
	system: string;
	tools: ToolSpec[];
	messages: Message[];
	prefixHash: string;
}

export const prefixHash = (system: string, tools: readonly ToolSpec[]): string => hashText(system + canonicalJson(tools));

/** Task board as text, or undefined when there are no tasks. With runId, only that run's tasks. */
export function taskBoard(state: HarnessState, runId?: string): string | undefined {
	const { ledger } = state;
	const ids = runId === undefined ? ledger.order : tasksOfRun(ledger, runId);
	if (ids.length === 0) return undefined;
	const lines = ids.map((id) => {
		const task = ledger.tasks[id]!;
		const steps = task.steps.map((s) => `    - ${s.id} [${s.status}] ${s.text}`).join("\n");
		return `- ${task.id} [${task.status}] ${task.title}${steps ? `\n${steps}` : ""}`;
	});
	return `Task board:\n${lines.join("\n")}`;
}

const digestFor = (m: Extract<Message, { kind: "tool" }>, seq: number, headChars: number): string => {
	// Always leave at least ~150 chars elided so the digest is smaller than the original.
	const head = Math.min(headChars, Math.max(0, m.output.length - 150));
	const elided = m.output.length - head;
	const text = head > 0 ? `${m.output.slice(0, head)}\n` : "";
	return `${text}[tool result digest: ${m.name} returned ${m.output.length} chars at seq ${seq}; ${elided} chars elided. Recover the full text with log_slice from ${seq} to ${seq} or recall_context.]`;
};

const pointerFor = (m: Extract<Message, { kind: "tool" }>, seq: number): string =>
	`[tool result elided: ${m.name} returned ${m.output.length} chars at seq ${seq}. Recover it with log_slice from ${seq} to ${seq} or recall_context.]`;

const elision = (chars: number, seq: number): string =>
	`[... ${chars} chars elided at seq ${seq}. log_slice from ${seq} to ${seq} recovers the full message.]`;

function compactText(text: string, seq: number): string {
	if (text.length <= COMPACT_OVER_CHARS) return text;
	return `${text.slice(0, COMPACT_HEAD_CHARS)}\n${elision(text.length - COMPACT_HEAD_CHARS, seq)}`;
}

function compactCalls(calls: ToolCall[], seq: number): ToolCall[] {
	return calls.map((c) => {
		const size = canonicalJson(c.input).length;
		if (size <= COMPACT_OVER_CHARS) return c;
		return { ...c, input: { elided: `${size} chars of arguments at seq ${seq}; log_slice from ${seq} to ${seq} recovers them.` } };
	});
}

/**
 * Compacts old user and assistant messages. Messages before the boundary are
 * compacted; the boundary moves in whole chunks, so an old message's rendering
 * changes once and then stays fixed, which keeps the cached prefix stable.
 * Nothing is lost: the full text stays in the log and log_slice returns it.
 */
export function compactHistory(messages: readonly Message[]): Message[] {
	const boundary = Math.max(0, Math.floor((messages.length - KEEP_RECENT_MESSAGES) / COMPACT_CHUNK) * COMPACT_CHUNK);
	return messages.map((m, i) => {
		if (i >= boundary) return m;
		if (m.kind === "user") return { ...m, text: compactText(m.text, m.seq) };
		if (m.kind === "assistant") return { ...m, text: compactText(m.text, m.seq), toolCalls: compactCalls(m.toolCalls, m.seq) };
		return m;
	});
}

export function estimateChars(messages: readonly Message[]): number {
	let total = 0;
	for (const m of messages) {
		if (m.kind === "tool") total += m.output.length + m.name.length + 32;
		else if (m.kind === "assistant") total += m.text.length + canonicalJson(m.toolCalls).length;
		else total += m.text.length;
	}
	return total;
}

export function buildContext(state: HarnessState, tools: readonly ToolSpec[], system = SYSTEM_INSTRUCTIONS, runId?: string): ProjectedContext {
	const toolMessages = state.messages.filter((m): m is Extract<Message, { kind: "tool" }> => m.kind === "tool");
	const recentSeqs = new Set(toolMessages.slice(-KEEP_RECENT_RESULTS).map((m) => m.seq));
	const originalLength = new Map(toolMessages.map((m) => [m.seq, m.output.length]));
	// Old tool results become digests: a head plus a pointer into the session log.
	// The full output is never dropped — log_slice and recall_context recover it by seq.
	const digest = (headChars: number): Message[] =>
		state.messages.map((m) => {
			if (m.kind !== "tool" || recentSeqs.has(m.seq)) return m;
			const len = originalLength.get(m.seq) ?? m.output.length;
			if (len <= DIGEST_OVER_CHARS) return m;
			return { ...m, output: headChars === 0 ? pointerFor(m, m.seq) : digestFor(m, m.seq, headChars) };
		});
	const assemble = (digested: readonly Message[]): Message[] => {
		const compacted = compactHistory(digested);
		// Messages covered by a recap are replaced by it; the recap boundary sits on a chunk edge, so the prefix stays stable.
		const messages: Message[] = state.recap
			? [{ kind: "system", text: `Recap of earlier work in this session:\n${state.recap.text}` }, ...compacted.slice(state.recap.covers)]
			: compacted;
		const board = taskBoard(state, runId);
		return board ? [...messages, { kind: "system", text: board }] : messages;
	};
	let digested = digest(DIGEST_HEAD_CHARS);
	let messages = assemble(digested);
	// Hard budget: if the projection is still too large, collapse old digests to bare pointers.
	if (estimateChars(messages) > CONTEXT_BUDGET_CHARS) {
		digested = digest(0);
		messages = assemble(digested);
	}
	return {
		system,
		tools: [...tools],
		messages,
		prefixHash: prefixHash(system, tools),
	};
}
