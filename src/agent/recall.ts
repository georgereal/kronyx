import type { AgentMessage, AgentTool, AgentToolCallPart, AgentToolResultPart } from "@cline/shared";

const MAX_OUTPUT_CHARS = 8_000;
const SNIPPET_RADIUS = 200;
const MAX_HITS = 5;

export interface RecallInput {
	toolCallId?: string;
	query?: string;
	runIndex?: number;
}

export interface PriorTranscript {
	label: string;
	messages: readonly AgentMessage[];
}

/** One transcript chunk handed to the semantic ranker. */
export interface RecallChunk {
	idx: number;
	role: string;
	text: string;
}

/**
 * Embedding-backed ranker for recall_context queries. Returns hit indexes +
 * similarity scores (best first), or undefined when embeddings are unavailable
 * — the tool then falls back to keyword search.
 */
export type RecallScorer = (
	query: string,
	chunks: readonly RecallChunk[],
) => Promise<{ idx: number; score: number }[] | undefined>;

export interface RecallOptions {
	/** Persisted prior-run transcripts (e.g. from the store), oldest → newest. */
	priorTranscripts?: () => readonly PriorTranscript[];
	/** Optional semantic ranker; keyword search is the fallback. */
	scorer?: RecallScorer;
}

const cap = (text: string): string =>
	text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[${text.length - MAX_OUTPUT_CHARS} chars elided]` : text;

/**
 * Readable text for a message: text parts verbatim, tool calls/results as
 * compact labelled lines. Avoids JSON escaping (\n, \") in snippets.
 */
const messageText = (m: AgentMessage): string =>
	m.content
		.map((p) => {
			if (p.type === "text") return p.text;
			if (p.type === "tool-call") return `[call ${p.toolName}] ${JSON.stringify(p.input)}`;
			if (p.type === "tool-result") {
				const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
				return `[result ${p.toolName}] ${out}`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");

function findToolResult(messages: readonly AgentMessage[], toolCallId: string): AgentToolResultPart | undefined {
	for (const m of messages) {
		for (const p of m.content) {
			if (p.type === "tool-result" && p.toolCallId === toolCallId) return p;
		}
	}
	return undefined;
}

function findToolCall(messages: readonly AgentMessage[], toolCallId: string): AgentToolCallPart | undefined {
	for (const m of messages) {
		for (const p of m.content) {
			if (p.type === "tool-call" && p.toolCallId === toolCallId) return p;
		}
	}
	return undefined;
}

function search(messages: readonly AgentMessage[], terms: string[]): string {
	const hits: { idx: number; role: string; snippet: string }[] = [];
	messages.forEach((m, idx) => {
		const text = messageText(m);
		const lower = text.toLowerCase();
		const first = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
		if (first.length < terms.length) return;
		const pos = Math.min(...first);
		const snippet = text.slice(Math.max(0, pos - SNIPPET_RADIUS), pos + SNIPPET_RADIUS);
		hits.push({ idx, role: m.role, snippet });
	});
	if (!hits.length) return "No matches.";
	return hits
		.slice(-MAX_HITS)
		.map((h) => `--- message #${h.idx} (${h.role}) ---\n…${h.snippet}…`)
		.join("\n");
}

/**
 * `recall_context` tool: retrieves content that compaction pruned from the prompt
 * but kept in the canonical transcript — stubbed tool outputs by toolCallId, or
 * keyword search over the transcript (optionally a prior run's transcript).
 */
export function createRecallTool(opts: RecallOptions = {}): AgentTool<RecallInput, string> {
	return {
		name: "recall_context",
		executionMode: "parallel",
		description:
			"Retrieve context elided by compaction or from earlier tasks in this session. " +
			"Use toolCallId to fetch a stubbed tool result's full output, or query to search the transcript semantically. " +
			"runIndex selects a prior task's transcript (0 = oldest).",
		inputSchema: {
			type: "object",
			properties: {
				toolCallId: { type: "string", description: "toolCallId from an elided tool result." },
				query: { type: "string", description: "Space-separated terms; all must appear in a message." },
				runIndex: { type: "integer", minimum: 0, description: "Prior task transcript index (default: current)." },
			},
		},
		async execute(input, context) {
			const prior = opts.priorTranscripts?.() ?? [];
			const inRun = input.runIndex !== undefined;
			const messages: readonly AgentMessage[] = inRun ? (prior[input.runIndex!]?.messages ?? []) : (context.snapshot?.messages ?? []);
			if (!messages.length) {
				return inRun
					? `No transcript for runIndex ${input.runIndex} (${prior.length} prior run(s) stored).`
					: "No transcript available.";
			}
			if (input.toolCallId) {
				const part = findToolResult(messages, input.toolCallId);
				const call = findToolCall(messages, input.toolCallId);
				if (!part && !call) return `No tool call or result with toolCallId "${input.toolCallId}" in this transcript.`;
				const callText = call ? `call ${call.toolName} input: ${JSON.stringify(call.input)}\n` : "";
				if (!part) return cap(`${callText}(no result recorded)`);
				const out = typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");
				return cap(`${callText}tool-result ${part.toolName} (${input.toolCallId}):\n${out}`);
			}
			if (input.query?.trim()) {
				if (opts.scorer) {
					const chunks: RecallChunk[] = messages.map((m, idx) => ({ idx, role: m.role, text: messageText(m) }));
					const ranked = await opts.scorer(input.query, chunks).catch(() => undefined);
					if (ranked?.length) {
						return cap(
							ranked
								.filter((h) => chunks[h.idx] !== undefined)
								.slice(0, MAX_HITS)
								.map(
									(h) =>
										`--- message #${h.idx} (${chunks[h.idx].role}, score ${h.score.toFixed(2)}) ---\n` +
										`${chunks[h.idx].text.slice(0, 2 * SNIPPET_RADIUS + 800)}`,
								)
								.join("\n"),
						);
					}
					// Empty/undefined → keyword fallback still gets a shot.
				}
				const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
				return cap(search(messages, terms));
			}
			return "Provide toolCallId (exact fetch) or query (semantic search).";
		},
	};
}
