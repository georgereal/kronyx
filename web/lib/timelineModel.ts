/**
 * Pure timeline model — folds raw run_events into render items.
 * No React, no I/O: Timeline.tsx renders the result; tests exercise it directly.
 */

import type { RunEvent } from "./types";

export type StreamKind = "reasoning" | "assistant";

export interface StreamItem {
	kind: "stream";
	streamKind: StreamKind;
	text: string;
	done: boolean;
	key: string;
	runId?: string;
	at?: string;
	seq?: number;
	agentIndex?: number;
	iteration?: number;
	/** Final assistant reply that duplicates the run summary — hidden by the UI. */
	hidden?: boolean;
	/** Marks the lane's last assistant reply (gets the K bubble). */
	final?: boolean;
}

export interface ActionItem {
	kind: "action";
	name: string;
	input: unknown;
	output?: string;
	ok?: boolean;
	durationMs?: number;
	toolId?: string;
	path?: string;
	diff?: string;
	added?: number;
	removed?: number;
	liveOutput?: string;
	key: string;
	runId?: string;
	at?: string;
	seq?: number;
	agentIndex?: number;
	hidden?: boolean;
}

export interface TurnItem {
	kind: "turn";
	items: Item[];
	iteration?: number;
	done: boolean;
	key: string;
	runId?: string;
	at?: string;
	endAt?: string;
	seq?: number;
	agentIndex?: number;
	num?: number;
	fallbackMs?: number;
	hidden?: boolean;
}

export interface PermItem {
	kind: "perm";
	permId: string;
	tool: string;
	path: string;
	command: string;
	input: unknown;
	decision?: string;
	key: string;
	runId?: string;
	seq?: number;
	agentIndex?: number;
	hidden?: boolean;
}

export interface PreflightItem {
	kind: "preflight";
	checks: RunEvent[];
	key: string;
	runId?: string;
	seq?: number;
	agentIndex?: number;
	hidden?: boolean;
}

export interface EventItem {
	kind: "event";
	e: RunEvent;
	key: string;
	/** Durable-only records (agent-message) and lifecycle chatter the chat feed hides. */
	hidden?: boolean;
	/** Consecutive same-kind rows folded into this one ("compacted ×N"). */
	count?: number;
}

export type Item = StreamItem | ActionItem | TurnItem | PermItem | PreflightItem | EventItem;

/**
 * Quiet view: the chat keeps only what needs the user's eyes — assistant
 * replies, permission requests (interactive), and failures. Tool cards,
 * reasoning, plan/check/lifecycle events drop out.
 */
export const quietItem = (i: Item): boolean =>
	(i.kind === "stream" && i.streamKind === "assistant") ||
	i.kind === "perm" ||
	(i.kind === "event" && (i.e.event.ok === false || i.e.event.type === "run-failed"));

/** Bookkeeping events that don't end a streamed reasoning/assistant block. */
const TRANSPARENT = new Set(["usage", "info", "memory", "cloud-status", "setup", "check", "agent-message", "agent-message-chunk"]);

/**
 * Fold token-delta events into one stream item each. A delta stream stays
 * "open" until its final event (reasoning / assistant-text) replaces it —
 * so replays show one Thoughts card and one reply card, not 200 tokens.
 */
export function fold(events: RunEvent[]): Item[] {
	const items: Item[] = [];
	type MutableStream = StreamItem & { absorbed?: boolean };
	interface Lane {
		openReasoning: MutableStream | null;
		openAssistant: MutableStream | null;
		lastAssistant: MutableStream | null;
	}
	const lanes = new Map<number, Lane>();
	const lane = (ai: number): Lane => {
		let l = lanes.get(ai);
		if (!l) lanes.set(ai, (l = { openReasoning: null, openAssistant: null, lastAssistant: null }));
		return l;
	};
	for (const e of events) {
		const ai = e.event.agentIndex ?? 0;
		const l = lane(ai);
		const t = e.event.type;
		if (t === "reasoning-delta" || t === "assistant-delta") {
			const isR = t === "reasoning-delta";
			let s: MutableStream | null = isR ? l.openReasoning : l.openAssistant;
			if (!s || s.done || (!isR && l.lastAssistant?.absorbed)) {
				s = { kind: "stream", streamKind: isR ? "reasoning" : "assistant", text: "", done: false, key: `s${e.runId}-${e.seq}`, runId: e.runId, at: e.at, seq: e.seq, agentIndex: ai };
				items.push(s);
				if (isR) l.openReasoning = s;
				else {
					l.openAssistant = s;
					l.lastAssistant = s;
				}
			}
			s.text += String(e.event.text ?? "");
			continue;
		}
		if (t === "reasoning" || t === "assistant-text") {
			const isR = t === "reasoning";
			const text = String(e.event.text ?? "");
			const iter = e.event.iteration as number | undefined;
			if (isR && l.openAssistant) {
				l.openAssistant.done = true;
				l.openAssistant = null;
			}
			if (!isR && l.openReasoning) {
				l.openReasoning.done = true;
				l.openReasoning = null;
			}
			const open = isR
				? l.openReasoning && !l.openReasoning.done
					? l.openReasoning
					: null
				: l.lastAssistant && !l.lastAssistant.absorbed
					? l.lastAssistant
					: null;
			if (open) {
				open.text = text || open.text;
				open.done = true;
				open.iteration = iter;
				if (isR) l.openReasoning = null;
				else open.absorbed = true;
			} else if (text.trim()) {
				items.push({
					kind: "stream",
					streamKind: isR ? "reasoning" : "assistant",
					text,
					done: true,
					key: `s${e.runId}-${e.seq}`,
					runId: e.runId,
					at: e.at,
					seq: e.seq,
					agentIndex: ai,
					iteration: iter,
				});
			}
			continue;
		}
		if (TRANSPARENT.has(t)) {
			items.push({ kind: "event", e, key: `e${e.runId}-${e.seq}` });
			continue;
		}
		if (l.openReasoning && t !== "reasoning-delta") {
			l.openReasoning.done = true;
			l.openReasoning = null;
		}
		if (l.openAssistant && t !== "assistant-delta") {
			l.openAssistant.done = true;
			l.openAssistant = null;
		}
		items.push({ kind: "event", e, key: `e${e.runId}-${e.seq}` });
	}
	return items;
}

/**
 * Pair raw events into action items: tool-started + tool-finished → one
 * action card; file-changed attaches to the matching edit action by path;
 * permission-request + permission-resolved → one approval card.
 */
export function pair(items: Item[]): Item[] {
	const out: Item[] = [];
	const actions = new Map<string, ActionItem>();
	const perms = new Map<string, PermItem>();
	let openPreflight: PreflightItem | null = null;
	for (const item of items) {
		if (item.kind !== "event") {
			openPreflight = null;
			out.push(item);
			continue;
		}
		const ev = item.e.event;
		const ai = ev.agentIndex ?? 0;
		if (ev.type === "check" && String(ev.command ?? "").startsWith("preflight:")) {
			if (!openPreflight || openPreflight.runId !== item.e.runId) {
				openPreflight = { kind: "preflight", checks: [], key: item.key, runId: item.e.runId, seq: item.e.seq };
				out.push(openPreflight);
			}
			openPreflight.checks.push(item.e);
			continue;
		}
		openPreflight = null;
		if (ev.type === "tool-started") {
			const inp = (ev.input ?? {}) as Record<string, unknown>;
			const a: ActionItem = {
				kind: "action",
				name: String(ev.name),
				input: ev.input,
				toolId: String(ev.id ?? ""),
				path: inp.path ? String(inp.path) : inp.file ? String(inp.file) : undefined,
				key: item.key,
				runId: item.e.runId,
				at: item.e.at,
				seq: item.e.seq,
				agentIndex: ai,
			};
			if (a.toolId) actions.set(`${ai}:${a.toolId}`, a);
			out.push(a);
			continue;
		}
		if (ev.type === "tool-finished") {
			const a = actions.get(`${ai}:${String(ev.id ?? "")}`);
			if (a) {
				a.output = String(ev.output ?? "");
				a.ok = ev.ok !== false;
				a.durationMs = Number(ev.durationMs ?? 0);
				continue;
			}
		}
		if (ev.type === "file-changed") {
			const path = String(ev.path ?? "");
			const a = [...actions.values()].reverse().find((x) => x.agentIndex === ai && x.path === path && !x.diff);
			if (a) {
				a.diff = String(ev.diff ?? "");
				a.added = Number(ev.added ?? 0);
				a.removed = Number(ev.removed ?? 0);
				continue;
			}
			if (Number(ev.added ?? 0) + Number(ev.removed ?? 0) === 0) continue;
		}
		if (ev.type === "tool-output-delta") {
			const a = [...actions.values()].reverse().find((x) => x.agentIndex === ai && x.name === "run_command" && x.output === undefined);
			if (a) a.liveOutput = (a.liveOutput ?? "") + String(ev.text ?? "");
			continue;
		}
		if (ev.type === "permission-request") {
			const p: PermItem = {
				kind: "perm",
				permId: String(ev.id ?? ev.permId ?? ""),
				tool: String(ev.tool ?? ""),
				path: String(ev.path ?? ""),
				command: String(ev.command ?? ""),
				input: ev.input,
				key: item.key,
				runId: item.e.runId,
				seq: item.e.seq,
				agentIndex: ai,
			};
			perms.set(`${ai}:${p.permId}`, p);
			out.push(p);
			continue;
		}
		if (ev.type === "permission-resolved" || ev.type === "permission-response") {
			const p = perms.get(`${ai}:${String(ev.id ?? ev.permId ?? "")}`);
			if (p) {
				p.decision = String(ev.decision ?? "");
				continue;
			}
		}
		out.push(item);
	}
	return out;
}

/**
 * Bucket contiguous stream/action items into per-iteration "turns".
 * `usage` events render as null — they pass through without breaking a turn.
 */
export function group(items: Item[]): Item[] {
	const out: Item[] = [];
	let turn: TurnItem | null = null;
	const stepNums = new Map<string, number>();
	const close = () => {
		if (!turn) return;
		turn.done = turn.items.every((i) =>
			i.kind === "action" ? i.output !== undefined : i.kind === "stream" ? i.done : true,
		);
		const rid = turn.runId ?? "";
		turn.num = (stepNums.get(rid) ?? 0) + 1;
		stepNums.set(rid, turn.num);
		out.push(turn);
		turn = null;
	};
	for (const it of items) {
		if (it.kind === "event" && it.e.event.type === "usage") continue;
		const member = it.kind === "stream" || it.kind === "action";
		if (!member) {
			close();
			out.push(it);
			continue;
		}
		if (turn && it.kind === "stream") {
			const iterDiff = turn.iteration !== undefined && it.iteration !== undefined && it.iteration !== turn.iteration;
			const didWork = turn.items.some(
				(i) => i.kind === "action" || (i.kind === "stream" && i.streamKind === it.streamKind && i.done),
			);
			if (iterDiff || didWork) close();
		}
		if (!turn) {
			turn = {
				kind: "turn",
				items: [],
				done: false,
				key: `t-${it.key}`,
				runId: it.runId,
				seq: it.seq,
				agentIndex: it.agentIndex,
				at: it.at,
			};
		}
		turn.items.push(it);
		if (turn.iteration === undefined && it.kind === "stream") turn.iteration = it.iteration;
		if (it.at) {
			turn.at ??= it.at;
			turn.endAt = it.at;
		}
		if (it.seq !== undefined) turn.seq = Math.max(turn.seq ?? 0, it.seq);
		if (it.kind === "action") turn.fallbackMs = (turn.fallbackMs ?? 0) + (it.durationMs ?? 0);
	}
	close();
	return out;
}

/** Whitespace-insensitive compare for summary-vs-reply dedupe. */
export function normText(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** Summary texts per run, from run-finished.text / run-completed.summary. */
export function summaryTexts(events: RunEvent[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const e of events) {
		const t = e.event.type;
		if (t !== "run-finished" && t !== "run-completed") continue;
		const rid = e.runId ?? "";
		const text = String(e.event.summary ?? e.event.text ?? "");
		if (rid && text.trim() && !m.has(rid)) m.set(rid, normText(text));
	}
	return m;
}

/**
 * Full pipeline: fold → pair → dedupe → mark non-final assistants → hide
 * durable-only records and lifecycle chatter → mark summary-duplicate replies.
 * Returns the flat item list; callers group()/lane-filter as needed.
 */
export function buildTimeline(events: RunEvent[]): Item[] {
	const items = pair(fold(events));
	// Dedupe display-level repeats: retry runs often replay identical replies.
	const seen: Item[] = [];
	const seenSigs = new Set<string>();
	for (const b of items) {
		const sig =
			b.kind === "stream"
				? `s:${b.streamKind}:${normText(b.text).slice(0, 120)}`
				: b.kind === "event"
					? `e:${b.e.runId}:${b.e.seq}`
					: `${b.kind}:${b.key}`;
		if (b.kind !== "event" && seenSigs.has(sig)) continue;
		seenSigs.add(sig);
		seen.push(b);
	}
	// An assistant stream that has later stream/action items in its lane is
	// mid-run narration — demote it to a small note; only the lane's last
	// reply gets the K bubble.
	const lastActIdx = new Map<string, number>();
	seen.forEach((b, i) => {
		if (b.kind === "stream" || b.kind === "action") lastActIdx.set(`${b.runId ?? ""}:${b.agentIndex ?? 0}`, i);
	});
	const summaries = summaryTexts(events);
	for (let i = 0; i < seen.length; i++) {
		const b = seen[i];
		if (b.kind === "stream" && b.streamKind === "assistant") {
			b.final = i === lastActIdx.get(`${b.runId ?? ""}:${b.agentIndex ?? 0}`);
			const sum = b.runId ? summaries.get(b.runId) : undefined;
			if (b.done && sum && normText(b.text) === sum) b.hidden = true;
		}
		if (b.kind === "event") {
			const t = b.e.event.type;
			// Durable transcript records — replay/resume only, never display.
			if (t === "agent-message" || t === "agent-message-chunk") b.hidden = true;
			// Lifecycle/setup chatter lives in the header Status log +
			// RunStatusLine — the feed keeps only signal-bearing events.
			// Passed checks are noise (the result card rolls up the count);
			// failed checks stay visible.
			else if (t === "cloud-status" || t === "setup") b.hidden = true;
			else if (t === "check" && b.e.event.ok !== false) b.hidden = true;
			else if (t === "info") {
				const meta = b.e.event.meta as { kind?: string } | undefined;
				if (meta?.kind !== "context_compaction" && meta?.kind !== "sandbox_recreated") b.hidden = true;
			}
		}
	}
	// Preflight cards duplicate the header Environment panel — drop them.
	const visible = seen.filter((i) => !i.hidden && i.kind !== "preflight");
	// Roll up context-compaction lines per run — a thrashing run emits one per
	// turn, interleaved with tool rows, so the first notice absorbs the rest:
	// it shows the latest stats and a ×N count.
	const isCompaction = (i: Item) => i.kind === "event" && (i.e.event.meta as { kind?: string } | undefined)?.kind === "context_compaction";
	const firstByRun = new Map<string, EventItem>();
	const out: Item[] = [];
	for (const i of visible) {
		if (i.kind === "event" && isCompaction(i)) {
			const rid = i.e.runId ?? "";
			const first = firstByRun.get(rid);
			if (first) {
				first.e = i.e;
				first.count = (first.count ?? 1) + 1;
				continue;
			}
			firstByRun.set(rid, i);
		}
		out.push(i);
	}
	return out;
}

/** Turn is mergeable into a "Worked" block: finished, no failures, no final reply. */
export function turnMergeable(t: TurnItem): boolean {
	if (!t.done) return false;
	return t.items.every(
		(i) =>
			(i.kind === "action" && i.output !== undefined && i.ok !== false) ||
			(i.kind === "stream" && i.done && !(i.streamKind === "assistant" && i.final)) ||
			i.kind === "event",
	);
}

/** Aggregate stats for a merged "Worked" block. */
export function workedStats(turns: TurnItem[]): { secs: number; actions: number; files: number; added: number; removed: number; fails: number } {
	let ms = 0;
	let actions = 0;
	let added = 0;
	let removed = 0;
	let fails = 0;
	const fileSet = new Set<string>();
	for (const t of turns) {
		const s = Date.parse(t.at ?? "");
		const e = Date.parse(t.endAt ?? "");
		ms += !Number.isNaN(s) && !Number.isNaN(e) && e > s ? e - s : t.fallbackMs ?? 0;
		for (const i of t.items) {
			if (i.kind !== "action") continue;
			actions++;
			if (i.ok === false) fails++;
			// Only actions that changed a file (paired file-changed) count —
			// reads/searches carry a path input but aren't file changes.
			if (i.diff !== undefined || (i.added ?? 0) + (i.removed ?? 0) > 0)
				fileSet.add(i.path ?? i.key);
			added += i.added ?? 0;
			removed += i.removed ?? 0;
		}
	}
	return { secs: Math.round(ms / 1000), actions, files: fileSet.size, added, removed, fails };
}

/** Merge contiguous mergeable turns into WorkedBlock items (kind "worked").
 *  Stream-only turns (the final reply, standalone Thoughts) unwrap to their
 *  streams so they render as normal bubbles/rows, not step cards. */
export type WorkedItem = { kind: "worked"; turns: TurnItem[]; key: string };
export function groupWorked(items: Item[]): (Item | WorkedItem)[] {
	const out: (Item | WorkedItem)[] = [];
	let buf: TurnItem[] = [];
	const flush = () => {
		if (!buf.length) return;
		if (buf.length === 1) out.push(buf[0]);
		else out.push({ kind: "worked", turns: buf, key: `w-${buf[0].key}` });
		buf = [];
	};
	for (const it of items) {
		if (it.kind === "turn" && it.items.length > 0 && it.items.every((x) => x.kind === "stream")) {
			flush();
			for (const s of it.items) out.push(s);
			continue;
		}
		if (it.kind === "turn" && turnMergeable(it)) {
			buf.push(it);
			continue;
		}
		flush();
		out.push(it);
	}
	flush();
	return out;
}

// ---------- concise tool labels ----------

const TOOL_META: Record<string, { icon: string; verb: string }> = {
	read_file: { icon: "📄", verb: "Read" },
	write_file: { icon: "📝", verb: "Wrote" },
	edit_file: { icon: "✏️", verb: "Edited" },
	append_file: { icon: "📝", verb: "Appended" },
	insert_lines: { icon: "📝", verb: "Inserted" },
	file_editor: { icon: "✏️", verb: "Edited" },
	run_command: { icon: "▶", verb: "Ran" },
	search_files: { icon: "🔍", verb: "Searched" },
	list_files: { icon: "📁", verb: "Listed" },
	browser_use: { icon: "🌐", verb: "Browsed" },
	load_skill: { icon: "🧩", verb: "Loaded skill" },
	use_tool: { icon: "🔧", verb: "Used" },
	save_plan: { icon: "📋", verb: "Saved plan" },
	switch_environment: { icon: "🔀", verb: "Switched env" },
	recall_context: { icon: "🧠", verb: "Recalled" },
	memory_write: { icon: "🧠", verb: "Remembered" },
};

export function toolMeta(name: string): { icon: string; verb: string } {
	if (TOOL_META[name]) return TOOL_META[name];
	if (name.startsWith("mcp_")) return { icon: "🔌", verb: name.slice(4).replace(/_/g, " ") };
	return { icon: "🔧", verb: name.replace(/_/g, " ") };
}

function trunc(s: string, n = 48): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Short target for the collapsed tool row: path, pattern, command, or first arg. */
export function toolTarget(item: ActionItem): string {
	const inp = (item.input ?? {}) as Record<string, unknown>;
	if (item.name === "run_command") return trunc(String(inp.command ?? inp.cmd ?? ""), 64);
	if (item.path) {
		const p = item.path;
		return p.includes("/") ? p.split("/").pop()! : p;
	}
	const base = (s: string) => {
		const p = s.includes("/") ? s.split("/").pop()! : s;
		return trunc(p, 56);
	};
	const fileIn = String(inp.path ?? inp.file ?? "");
	if (fileIn) return base(fileIn);
	const target = String(inp.query ?? inp.pattern ?? inp.url ?? inp.slug ?? inp.name ?? "");
	if (target) return trunc(target, 56);
	const s = typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {});
	return trunc(s === "{}" ? "" : s, 56);
}

const FILE_TOOLS = new Set(["read_file", "list_files", "search_files"]);

/** Full workspace path for read/list/search rows ("." lists the repo root); undefined for other tools. */
export function toolPath(item: ActionItem): string | undefined {
	if (!FILE_TOOLS.has(item.name)) return undefined;
	const inp = (item.input ?? {}) as Record<string, unknown>;
	const p = String(inp.path ?? inp.file ?? "").trim();
	if (item.name === "list_files") return p && p !== "." ? p : "repo root";
	return p || undefined;
}

/** Result summary for read/list/search rows, e.g. "3 lines", "2 entries", "2 matches". */
export function toolDetail(item: ActionItem): string {
	const lines = (item.output ?? "").split("\n").filter((l) => l.trim());
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	if (!lines.length) return "";
	if (item.name === "read_file") {
		const n = lines.filter((l) => /^\s*\d+\|/.test(l)).length;
		return n ? plural(n, "line", "lines") : "";
	}
	if (item.name === "list_files") return plural(lines.length, "entry", "entries");
	if (item.name === "search_files") return plural(lines.filter((l) => /:\d+:/.test(l)).length, "match", "matches");
	return "";
}

/** One-line label for the collapsed tool row, e.g. "Read store.ts". */
export function toolLabel(item: ActionItem): string {
	const { verb } = toolMeta(item.name);
	const target = toolTarget(item);
	return target ? `${verb} ${target}` : verb;
}
