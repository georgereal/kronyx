/**
 * recall_context on the harness path (vscode-free). Searches the session log,
 * which holds every run of the session, so earlier tasks are reachable. Returns
 * a full tool output by toolCallId, or keyword matches with snippets by query.
 */

import type { SessionEvent, ToolPort, ToolResult, ToolSpec } from "../core/contracts";
import type { EventLog } from "../core/eventLog";

export const RECALL_TOOL = "recall_context";
const MAX_OUTPUT = 8000;
const MAX_HITS = 5;
const SNIPPET_RADIUS = 200;

const SPEC: ToolSpec = {
	name: RECALL_TOOL,
	description:
		"Retrieve earlier material: a full tool result by toolCallId, or matches across earlier messages, tool results and tasks. " +
		"scope 'session' (default) searches this session's log; scope 'runs' searches indexed digests of earlier runs — their prompts, task outcomes and final reports — including previous sessions. runId and task narrow run-scope hits.",
	inputSchema: {
		type: "object",
		properties: {
			toolCallId: { type: "string", description: "The toolCallId (or seq number) of an earlier tool result to fetch in full." },
			query: { type: "string", description: "Terms to search for — matched semantically when embeddings are available, else all must appear in one message." },
			scope: { type: "string", enum: ["session", "runs"], description: "'session' (default): this session's log. 'runs': indexed digests of earlier runs, across sessions." },
			runId: { type: "string", description: "With scope 'runs': restrict to one run's digest." },
			task: { type: "string", description: "With scope 'runs': restrict to one task's entry (task id like 't2' or title text)." },
		},
	},
};

const textOf = (e: SessionEvent): string => {
	switch (e.type) {
		case "user.input":
			return e.text;
		case "model.response":
			return e.text;
		case "tool.finished":
			return `${e.name}: ${e.output}`;
		default:
			return "";
	}
};

/** One transcript chunk handed to the semantic ranker (same shape as agent recall). */
export interface RecallChunk {
	idx: number;
	role: string;
	text: string;
}

/** Embedding-backed ranker; returns hit indexes + scores (best first), or undefined → keyword fallback. */
export type RecallScorer = (query: string, chunks: RecallChunk[]) => Promise<{ idx: number; score: number }[] | undefined>;

/** One indexed run-memory hit (a run digest or per-task entry). */
export interface RunSearchHit {
	label: string;
	text: string;
	score: number;
}

/** Searches persisted run digests (IDE: sqlite chunks; cloud: mongo vectors). undefined → run memory unavailable. */
export type RunSearch = (query: string, filter: { runId?: string; task?: string }) => Promise<RunSearchHit[] | undefined>;

export function searchLog(events: readonly SessionEvent[], terms: string[]): string {
	const hits: string[] = [];
	for (const e of events) {
		const text = textOf(e);
		if (!text) continue;
		const lower = text.toLowerCase();
		const positions = terms.map((t) => lower.indexOf(t.toLowerCase()));
		if (positions.some((p) => p < 0)) continue;
		const at = Math.min(...positions);
		const snippet = text.slice(Math.max(0, at - SNIPPET_RADIUS), at + SNIPPET_RADIUS);
		hits.push(`--- seq ${e.seq} (${e.type}) ---\n...${snippet}...`);
	}
	if (hits.length === 0) return "No matches.";
	return hits.slice(-MAX_HITS).join("\n").slice(0, MAX_OUTPUT);
}

async function searchSemantic(events: readonly SessionEvent[], query: string, scorer: RecallScorer): Promise<string | undefined> {
	const chunks: RecallChunk[] = [];
	const chunkEvents: SessionEvent[] = [];
	for (const e of events) {
		const text = textOf(e);
		if (text.trim()) {
			chunks.push({ idx: chunks.length, role: `${e.type}#${e.seq}`, text });
			chunkEvents.push(e);
		}
	}
	const eventsByChunk = chunkEvents;
	const ranked = (await scorer(query, chunks).catch(() => undefined)) ?? [];
	const hits = ranked
		.filter((h) => eventsByChunk[h.idx] !== undefined)
		.slice(0, MAX_HITS)
		.map((h) => {
			const e = eventsByChunk[h.idx]!;
			const text = textOf(e);
			return `--- seq ${e.seq} (${e.type}, score ${h.score.toFixed(2)}) ---\n...${text.slice(0, 2 * SNIPPET_RADIUS + 800)}...`;
		});
	return hits.length ? hits.join("\n").slice(0, MAX_OUTPUT) : undefined;
}

export function withRecall(base: ToolPort, log: EventLog, scorer?: RecallScorer, searchRuns?: RunSearch): ToolPort {
	return {
		specs: () => [...base.specs().filter((s) => s.name !== RECALL_TOOL), SPEC],
		async execute(name, input, callId): Promise<ToolResult> {
			if (name !== RECALL_TOOL) return base.execute(name, input, callId);
			const args = (input ?? {}) as { toolCallId?: unknown; query?: unknown; scope?: unknown; runId?: unknown; task?: unknown; runIndex?: unknown };
			const events = await log.read();
			if (typeof args.toolCallId === "string" && args.toolCallId) {
				// The model sees seq numbers in digests, not callIds — accept both.
				const seqMatch = /^(?:seq\s*)?(\d+)$/i.exec(args.toolCallId);
				const bySeq = seqMatch ? Number(seqMatch[1]) : undefined;
				const finished = events.find((e) => e.type === "tool.finished" && (e.callId === args.toolCallId || e.seq === bySeq));
				if (!finished || finished.type !== "tool.finished") return { ok: false, output: `No tool result with toolCallId ${args.toolCallId}.` };
				return { ok: true, output: finished.output.slice(0, MAX_OUTPUT) };
			}
			if (typeof args.query === "string" && args.query.trim()) {
				const runsScope = args.scope === "runs" || typeof args.runId === "string" || typeof args.task === "string" || args.runIndex !== undefined;
				if (runsScope) {
					if (!searchRuns) return { ok: false, output: "Run memory is not indexed in this environment — use scope 'session'." };
					const hits = await searchRuns(args.query, {
						runId: typeof args.runId === "string" ? args.runId : undefined,
						task: typeof args.task === "string" ? args.task : undefined,
					}).catch(() => undefined);
					if (!hits?.length) return { ok: true, output: "No run-memory matches." };
					const body = hits.map((h) => `--- ${h.label} (score ${h.score.toFixed(2)}) ---\n${h.text}`).join("\n");
					return { ok: true, output: body.slice(0, MAX_OUTPUT) };
				}
				if (scorer) {
					const semantic = await searchSemantic(events, args.query, scorer);
					if (semantic) return { ok: true, output: semantic };
				}
				const terms = args.query.trim().split(/\s+/);
				return { ok: true, output: searchLog(events, terms) };
			}
			return { ok: false, output: "recall_context needs a toolCallId or a query." };
		},
	};
}
