import type { AgentMessage, AgentTool, AgentToolResultPart } from "@cline/shared";

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

export interface RecallOptions {
	/** Persisted prior-run transcripts (e.g. from the store), oldest → newest. */
	priorTranscripts?: () => readonly PriorTranscript[];
}

const cap = (text: string): string =>
	text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[${text.length - MAX_OUTPUT_CHARS} chars elided]` : text;

const messageText = (m: AgentMessage): string => JSON.stringify(m.content);

function findToolResult(messages: readonly AgentMessage[], toolCallId: string): AgentToolResultPart | undefined {
	for (const m of messages) {
		for (const p of m.content) {
			if (p.type === "tool-result" && p.toolCallId === toolCallId) return p;
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
		description:
			"Retrieve context elided by compaction or from earlier tasks in this session. " +
			"Use toolCallId to fetch a stubbed tool result's full output, or query to keyword-search the transcript. " +
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
				if (!part) return `No tool result with toolCallId "${input.toolCallId}" in this transcript.`;
				const out = typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");
				return cap(`tool-result ${part.toolName} (${input.toolCallId}):\n${out}`);
			}
			if (input.query?.trim()) {
				const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
				return cap(search(messages, terms));
			}
			return "Provide toolCallId (exact fetch) or query (keyword search).";
		},
	};
}
