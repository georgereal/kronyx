/**
 * Shared harness context projection. This module owns the mechanical assembly
 * policy for harness-driven model requests; harness defaults adapt it through
 * the kernel's ContextPolicy seam. It is vscode-free so IDE and cloud use the
 * same compaction/projection behavior.
 *
 * Budgeting is measured in real tokens (gpt-tokenizer BPE), never chars
 * heuristics: the hard cap applies to system + tool schemas + messages, fixed
 * inputs are measured per invocation, and over-budget material is reduced in
 * graduated priority order rather than a single collapse. Retention rules
 * follow the context architecture: user inputs are never compacted, stale or
 * superseded tool evidence collapses to recovery pointers, and structured
 * execution state rides as its own component.
 */

import { canonicalJson, hashText } from "../../harness/core/canonical";
import { tasksOfRun } from "../../harness/core/taskLedger";
import type { ToolCall, ToolSpec } from "../../harness/core/contracts";
import type { HarnessState, Message } from "../../harness/core/projections";
import type { ProjectedContext } from "../../harness/core/policies/context";
import type { CallPurpose } from "../contracts/context";
import { countJsonTokens, countTokens } from "../budget/tokenCounter";
import { DEFAULT_PROJECTION_BUDGET, PRESSURE_SHARE, inputBudgetForWindow, type ProjectionBudget } from "../budget/allocate";
import { inferCallPurpose } from "../manager/purpose";

export { DEFAULT_PROJECTION_BUDGET, PRESSURE_SHARE, inputBudgetForWindow };
export type { ProjectionBudget };

/** Messages newer than this many are never compacted. */
export const KEEP_RECENT_MESSAGES = 12;
/** Old messages are compacted in whole chunks of this size, so the rendered prefix changes once per chunk, not every turn. */
export const COMPACT_CHUNK = 8;
/** Old assistant text longer than this is cut to a head plus an elision note. User inputs are never compacted — the canonical objective and constraints must survive verbatim. */
export const COMPACT_OVER_CHARS = 2000;
export const COMPACT_HEAD_CHARS = 600;
/** Tool results longer than this are digested once they are no longer recent. */
export const DIGEST_OVER_CHARS = 400;
/** Head of a digested tool result kept in context; the rest stays in the log. */
export const DIGEST_HEAD_CHARS = 600;
/** The most recent tool results are kept beyond digesting, but still capped — a single read_files or test run can be tens of KB and otherwise rides in context for several turns. */
export const KEEP_RECENT_RESULTS = 6;
/** Recent results longer than this are cut to head + tail with a log_slice pointer. */
export const RECENT_RESULT_CAP_CHARS = 6000;
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
	// Pin the last written plan so a post-recap model knows where it lives without re-hunting files.
	// Covers save_plan ("Plan saved to X") and a write_file landing a .md under a plans-ish dir.
	let planPath: string | undefined;
	for (const m of state.messages) {
		if (m.kind !== "tool") continue;
		if (m.name === "save_plan") {
			const hit = /Plan saved to (\S+)/.exec(m.output);
			if (hit) planPath = hit[1];
		} else if (m.name === "write_file") {
			const hit = /(?:Overwrote|Created) (\S+\.md)/.exec(m.output);
			if (hit && /(^|\/)plans?\//i.test(hit[1]!)) planPath = hit[1];
		}
	}
	const footer = planPath ? `\n\nActive plan: ${planPath} (read_plan or read_file fetches it — no need to search)` : "";
	return `Task board:\n${lines.join("\n")}${footer}`;
}

/* ------------------------------------------------------------------ */
/* Token measurement — the single measuring stick for enforcement and  */
/* manifests, so what the budgeter counts is what the manifest reports. */
/* ------------------------------------------------------------------ */

export function countMessageTokens(m: Message): number {
	if (m.kind === "tool") return countTokens(m.name) + countTokens(m.output) + 8;
	if (m.kind === "assistant") return countTokens(m.text) + countJsonTokens(m.toolCalls) + 8;
	return countTokens(m.text) + 4;
}

export function countMessagesTokens(messages: readonly Message[]): number {
	let total = 0;
	for (const m of messages) total += countMessageTokens(m);
	return total;
}

/* ------------------------------------------------------------------ */
/* Purpose inference and tool-result categories.                        */
/* ------------------------------------------------------------------ */

export type ToolCategory = "evidence" | "repository" | "mutation" | "other";

export const READ_TOOLS = /^(read_file|read_files|open_file)$/;
export const WRITE_TOOLS = /^(write_file|edit_file|append_file|insert_lines|file_editor|apply_patch)/;
export const SEARCH_TOOLS = /^(search_files|grep|list_files|list_dir|glob|find_files)$/;

export function categorizeTool(name: string): ToolCategory {
	if (/^(run_command|run_tests?)$/.test(name)) return "evidence";
	if (WRITE_TOOLS.test(name)) return "mutation";
	if (READ_TOOLS.test(name) || SEARCH_TOOLS.test(name) || /^explore/.test(name)) return "repository";
	return "other";
}

/** Purpose-emphasized categories: the material the current kind of call must keep longest under pressure. */
const PURPOSE_EMPHASIS: Partial<Record<CallPurpose, ToolCategory[]>> = {
	debugging: ["evidence"],
	"test-analysis": ["evidence"],
	implementation: ["mutation", "repository"],
	exploration: ["repository"],
	review: ["mutation", "evidence"],
	verification: ["mutation", "evidence"],
};

export function inferHarnessPurpose(state: HarnessState): CallPurpose {
	const recentToolNames = state.messages.filter((m): m is Extract<Message, { kind: "tool" }> => m.kind === "tool").slice(-8).map((m) => m.name);
	const lastValidationFailed = state.verdicts.at(-1)?.ok === false || state.messages.some((m) => m.kind === "tool" && !m.ok && m.seq >= Math.max(0, state.lastSeq - 8));
	const tasks = state.ledger.order.map((id) => state.ledger.tasks[id]).filter(Boolean);
	const allDone = tasks.length > 0 && tasks.every((task) => task!.status === "done");
	return inferCallPurpose({ recentToolNames, lastValidationFailed, finalizing: allDone });
}

/* ------------------------------------------------------------------ */
/* Supersede/dedupe analysis.                                           */
/* ------------------------------------------------------------------ */

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function pathsOfInput(input: unknown): string[] {
	const o = asRecord(input);
	if (!o) return [];
	const out: string[] = [];
	for (const key of ["path", "file", "filePath", "rel", "target_file"]) if (typeof o[key] === "string") out.push(o[key] as string);
	if (Array.isArray(o.paths)) for (const p of o.paths) if (typeof p === "string") out.push(p);
	return [...new Set(out)];
}

/** callId → tool input, recovered from the assistant turns that issued the calls. */
function toolInputsByCallId(state: HarnessState): Map<string, unknown> {
	const map = new Map<string, unknown>();
	for (const m of state.messages) {
		if (m.kind !== "assistant") continue;
		for (const call of m.toolCalls) if (!map.has(call.callId)) map.set(call.callId, call.input);
	}
	return map;
}

/**
 * Seq numbers whose tool output is stale or redundant and must collapse to a
 * recovery pointer even inside the recent window:
 * - a file read superseded by a later read or successful write of the same path;
 * - a search/list result superseded by a later identical query.
 * The current workspace is authoritative; retaining stale file contents
 * actively misleads edits. Small outputs are exempt — the pointer costs as
 * much as the content and staleness risk is negligible below a few lines.
 */
const SUPERSEDE_MIN_CHARS = 240;

export function supersededResultSeqs(state: HarnessState): Set<number> {
	const inputs = toolInputsByCallId(state);
	const tools = state.messages.filter((m): m is Extract<Message, { kind: "tool" }> => m.kind === "tool");
	const latestRead = new Map<string, number>();
	const latestWrite = new Map<string, number>();
	const latestSearch = new Map<string, number>();
	for (const m of tools) {
		if (!m.ok) continue;
		const input = inputs.get(m.callId);
		if (READ_TOOLS.test(m.name)) {
			for (const p of pathsOfInput(input)) latestRead.set(p, Math.max(latestRead.get(p) ?? 0, m.seq));
		} else if (WRITE_TOOLS.test(m.name)) {
			for (const p of pathsOfInput(input)) latestWrite.set(p, Math.max(latestWrite.get(p) ?? 0, m.seq));
		} else if (SEARCH_TOOLS.test(m.name)) {
			latestSearch.set(`${m.name}:${canonicalJson(input ?? null)}`, Math.max(latestSearch.get(`${m.name}:${canonicalJson(input ?? null)}`) ?? 0, m.seq));
		}
	}
	const superseded = new Set<number>();
	for (const m of tools) {
		if (m.output.length < SUPERSEDE_MIN_CHARS) continue;
		const input = inputs.get(m.callId);
		if (READ_TOOLS.test(m.name)) {
			const paths = pathsOfInput(input);
			if (paths.length > 0 && paths.every((p) => (latestRead.get(p) ?? 0) > m.seq || (latestWrite.get(p) ?? 0) > m.seq)) superseded.add(m.seq);
		} else if (SEARCH_TOOLS.test(m.name) && m.ok) {
			if ((latestSearch.get(`${m.name}:${canonicalJson(input ?? null)}`) ?? 0) > m.seq) superseded.add(m.seq);
		}
	}
	return superseded;
}

/* ------------------------------------------------------------------ */
/* Structured execution-state component.                                */
/* ------------------------------------------------------------------ */

const EXEC_STATE_CAP = 1400;

/**
 * Concise structured state the interaction tail cannot carry honestly:
 * harness-verified validation outcomes, unresolved failures, and the change
 * map. Rendered fresh every turn beside the board — trailing position, so the
 * cached prefix is untouched.
 */
export function executionStateNote(state: HarnessState): string | undefined {
	const sections: string[] = [];
	// Validation: latest verdict per command — the harness's own checks are authoritative.
	const latestVerdicts = new Map<string, { ok: boolean; seq: number }>();
	for (const v of state.verdicts) latestVerdicts.set(v.command, { ok: v.ok, seq: v.seq });
	if (latestVerdicts.size) {
		const rows = [...latestVerdicts.entries()].slice(-4).map(([command, v]) => `${v.ok ? "passed" : "FAILED"} — \`${command}\` (seq ${v.seq})`);
		sections.push(`Validation: ${rows.join("; ")}`);
	}
	// Open issues: failed tool calls the same tool+target has not since resolved.
	const inputs = toolInputsByCallId(state);
	const keyOf = (name: string, input: unknown): string => {
		const paths = pathsOfInput(input);
		return paths.length ? `${name}:${paths.join(",")}` : name;
	};
	const resolved = new Set<string>();
	const tools = state.messages.filter((m): m is Extract<Message, { kind: "tool" }> => m.kind === "tool");
	for (const m of tools) if (m.ok) resolved.add(keyOf(m.name, inputs.get(m.callId)));
	const open = tools.filter((m) => !m.ok && !resolved.has(keyOf(m.name, inputs.get(m.callId)))).slice(-4);
	if (open.length) {
		sections.push(`Unresolved failures: ${open.map((m) => `${m.name} at seq ${m.seq} — recover with log_slice`).join("; ")}`);
	}
	// Change map: successful writes, last-write-wins path order.
	const written = new Map<string, number>();
	for (const m of tools) {
		if (!m.ok || !WRITE_TOOLS.test(m.name)) continue;
		for (const p of pathsOfInput(inputs.get(m.callId))) written.set(p, m.seq);
	}
	if (written.size) sections.push(`Files modified: ${[...written.keys()].slice(-14).join(", ")}`);
	if (!sections.length) return undefined;
	const text = `Execution state:\n${sections.map((s) => `- ${s}`).join("\n")}`;
	return text.length <= EXEC_STATE_CAP ? text : `${text.slice(0, EXEC_STATE_CAP - 80)}\n[… execution state truncated; detail recoverable from the ledger]`;
}

/* ------------------------------------------------------------------ */
/* Message compaction transforms.                                       */
/* ------------------------------------------------------------------ */

const digestFor = (m: Extract<Message, { kind: "tool" }>, seq: number, headChars: number): string => {
	// Always leave at least ~150 chars elided so the digest is smaller than the original.
	const head = Math.min(headChars, Math.max(0, m.output.length - 150));
	const elided = m.output.length - head;
	const text = head > 0 ? `${m.output.slice(0, head)}\n` : "";
	return `${text}[tool result digest: ${m.name} returned ${m.output.length} chars at seq ${seq}; ${elided} chars elided. Recover the full text with log_slice from ${seq} to ${seq} or recall_context.]`;
};

const pointerFor = (m: Extract<Message, { kind: "tool" }>, seq: number): string =>
	`[tool result elided: ${m.name} returned ${m.output.length} chars at seq ${seq}. Recover it with log_slice from ${seq} to ${seq} or recall_context.]`;

const supersededPointerFor = (m: Extract<Message, { kind: "tool" }>, seq: number): string =>
	`[superseded tool result: ${m.name} at seq ${seq} — a newer read/write of the same target exists; the current workspace is authoritative. Recover the historical output with log_slice from ${seq} to ${seq}.]`;

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
 * Compacts old assistant messages. User inputs are NEVER compacted: the
 * canonical objective and explicit constraints are permanent retention-class
 * context, and weakening them is the one compaction failure mode the
 * architecture forbids. The boundary moves in whole chunks, so an old
 * message's rendering changes once and then stays fixed, keeping the cached
 * prefix stable. Nothing is lost: full text stays in the log and log_slice
 * returns it.
 */
export function compactHistory(messages: readonly Message[]): Message[] {
	const boundary = Math.max(0, Math.floor((messages.length - KEEP_RECENT_MESSAGES) / COMPACT_CHUNK) * COMPACT_CHUNK);
	return messages.map((m, i) => {
		if (i >= boundary || m.kind !== "assistant") return m;
		return { ...m, text: compactText(m.text, m.seq), toolCalls: compactCalls(m.toolCalls, m.seq) };
	});
}

/** A tool result over the cap keeps its head and tail, with a log_slice pointer to the full text. */
export const capResult = (m: Extract<Message, { kind: "tool" }>, capChars = RECENT_RESULT_CAP_CHARS): Message =>
	m.output.length <= capChars
		? m
		: {
				...m,
				output: `${m.output.slice(0, Math.floor(capChars * 0.7))}\n[... ${m.output.length - Math.floor(capChars * 0.7) - Math.floor(capChars * 0.13)} chars elided at seq ${m.seq}. log_slice from ${m.seq} to ${m.seq} recovers the full result.]\n${m.output.slice(-Math.floor(capChars * 0.13))}`,
			};

/* ------------------------------------------------------------------ */
/* Projection assembly with graduated, purpose-aware budget reduction.  */
/* ------------------------------------------------------------------ */

interface ReductionLevel {
	/** Digest head for old results; 0 collapses them to bare pointers. */
	digestHead: number;
	/** Whether purpose-emphasized categories keep their digests at this level. */
	protectEmphasized: boolean;
	/** Recent-window size and per-result cap. */
	keepRecentResults: number;
	recentCapChars: number;
}

const REDUCTION_LEVELS: ReductionLevel[] = [
	{ digestHead: DIGEST_HEAD_CHARS, protectEmphasized: true, keepRecentResults: KEEP_RECENT_RESULTS, recentCapChars: RECENT_RESULT_CAP_CHARS },
	{ digestHead: 0, protectEmphasized: true, keepRecentResults: KEEP_RECENT_RESULTS, recentCapChars: RECENT_RESULT_CAP_CHARS },
	{ digestHead: 0, protectEmphasized: false, keepRecentResults: 3, recentCapChars: 2500 },
	{ digestHead: 0, protectEmphasized: false, keepRecentResults: 2, recentCapChars: 1200 },
];

export function buildHarnessContextProjection(state: HarnessState, tools: readonly ToolSpec[], system: string, runId?: string, budget: ProjectionBudget = DEFAULT_PROJECTION_BUDGET): ProjectedContext {
	const fixedTokens = countTokens(system) + countJsonTokens(tools);
	const messageBudget = Math.max(0, budget.inputTokens - fixedTokens);
	const purpose = inferHarnessPurpose(state);
	const emphasized = new Set(PURPOSE_EMPHASIS[purpose] ?? []);
	const superseded = supersededResultSeqs(state);
	const toolMessages = state.messages.filter((m): m is Extract<Message, { kind: "tool" }> => m.kind === "tool");

	const assembleAt = (level: ReductionLevel): Message[] => {
		const recentSeqs = new Set(toolMessages.slice(-level.keepRecentResults).map((m) => m.seq));
		const digested = state.messages.map((m) => {
			if (m.kind !== "tool") return m;
			if (superseded.has(m.seq)) return { ...m, output: supersededPointerFor(m, m.seq) };
			if (recentSeqs.has(m.seq)) return capResult(m, level.recentCapChars);
			const len = m.output.length;
			if (len <= DIGEST_OVER_CHARS) return m;
			const protect = level.protectEmphasized && emphasized.has(categorizeTool(m.name));
			if (level.digestHead === 0 && !protect) return { ...m, output: pointerFor(m, m.seq) };
			return { ...m, output: digestFor(m, m.seq, level.digestHead) };
		});
		const compacted = compactHistory(digested);
		// Messages covered by a recap are replaced by it; the recap boundary sits on a chunk edge, so the prefix stays stable.
		// User inputs of the active task are never compacted away (retention matrix: canonical user
		// requirements always retained) — anything a task-closeout recap covered belongs to a finished
		// task and stays compacted, but a pressure recap must not swallow the active objective or
		// steering constraints. They are re-injected verbatim right after the recap.
		let messages: Message[];
		if (state.recap) {
			const retained = compacted
				.slice(0, state.recap.covers)
				.filter((m, i) => m.kind === "user" && i >= state.closeoutCovers);
			messages = [
				{ kind: "system", text: `Recap of earlier work in this session:\n${state.recap.text}` },
				...retained,
				...compacted.slice(state.recap.covers),
			];
		} else {
			messages = compacted;
		}
		// Structured execution state, then the board — trailing system components in canonical order.
		const note = executionStateNote(state);
		if (note) messages.push({ kind: "system", text: note });
		const board = taskBoard(state, runId);
		if (board) messages.push({ kind: "system", text: board });
		return messages;
	};

	let reductionLevel = 0;
	let messages = assembleAt(REDUCTION_LEVELS[0]!);
	let messageTokens = countMessagesTokens(messages);
	// Pressure decisions measure the level-0 cost — before graduated reduction.
	// Otherwise the lossy hard collapse would mask utilization and preempt the
	// higher-quality recap compaction the pressure trigger exists to fire.
	const unreducedInputTokens = fixedTokens + messageTokens;
	while (messageTokens > messageBudget && reductionLevel < REDUCTION_LEVELS.length - 1) {
		reductionLevel++;
		messages = assembleAt(REDUCTION_LEVELS[reductionLevel]!);
		messageTokens = countMessagesTokens(messages);
	}
	const estimatedInputTokens = fixedTokens + messageTokens;
	return {
		system,
		tools: [...tools],
		messages,
		prefixHash: prefixHash(system, tools),
		estimatedInputTokens,
		unreducedInputTokens,
		overBudget: estimatedInputTokens > budget.inputTokens,
		reductionLevel,
		purpose,
	};
}
