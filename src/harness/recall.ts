/**
 * recall_context on the harness path (vscode-free). Searches the session log,
 * which holds every run of the session, so earlier tasks are reachable. Returns
 * a full tool output by toolCallId, or keyword matches with snippets by query.
 */

import type { SessionEvent, ToolPort, ToolResult, ToolSpec } from "./contracts";
import type { EventLog } from "./eventLog";

export const RECALL_TOOL = "recall_context";
const MAX_OUTPUT = 8000;
const MAX_HITS = 5;
const SNIPPET_RADIUS = 200;

const SPEC: ToolSpec = {
	name: RECALL_TOOL,
	description:
		"Retrieve earlier material from this session's log: a full tool result by toolCallId, or keyword matches (space-separated terms, all must appear) across earlier messages and tool results, including earlier tasks.",
	inputSchema: {
		type: "object",
		properties: {
			toolCallId: { type: "string", description: "The toolCallId (or seq number) of an earlier tool result to fetch in full." },
			query: { type: "string", description: "Space-separated terms; all must appear in one message." },
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

export function withRecall(base: ToolPort, log: EventLog): ToolPort {
	return {
		specs: () => [...base.specs(), SPEC],
		async execute(name, input): Promise<ToolResult> {
			if (name !== RECALL_TOOL) return base.execute(name, input);
			const args = (input ?? {}) as { toolCallId?: unknown; query?: unknown };
			const events = await log.read();
			if (typeof args.toolCallId === "string" && args.toolCallId) {
				// The model sees seq numbers in digests, not callIds — accept both.
				const bySeq = /^\d+$/.test(args.toolCallId) ? Number(args.toolCallId) : undefined;
				const finished = events.find((e) => e.type === "tool.finished" && (e.callId === args.toolCallId || e.seq === bySeq));
				if (!finished || finished.type !== "tool.finished") return { ok: false, output: `No tool result with toolCallId ${args.toolCallId}.` };
				return { ok: true, output: finished.output.slice(0, MAX_OUTPUT) };
			}
			if (typeof args.query === "string" && args.query.trim()) {
				const terms = args.query.trim().split(/\s+/);
				return { ok: true, output: searchLog(events, terms) };
			}
			return { ok: false, output: "recall_context needs a toolCallId or a query." };
		},
	};
}
