/**
 * Recap compaction (vscode-free). When the compaction boundary advances by a
 * chunk, the model writes a brief of everything before it (plus the previous
 * recap). The brief is stored as a context.recap event, so recovery keeps it,
 * and the older messages it covers are dropped from the request.
 */

import type { ModelPort, Usage } from "./contracts";
import { emptyLedger } from "./taskLedger";
import type { Message } from "./projections";

export const RECAP_SYSTEM = [
	"You write a brief for the SAME agent to continue this coding task. It is not a narrative of the transcript.",
	"In at most 300 words of compact prose cover: what was being done and its live state; intentions and next steps;",
	"remaining work and the criteria for completion; files read or changed, with paths; errors and their resolutions;",
	"and pointers to details the agent can recover with log_slice by seq. An earlier recap, if present, comes first and must be kept.",
].join(" ");

const LINE_CAP = 1500;

export function transcriptOf(prior: string | undefined, chunk: readonly Message[]): string {
	const lines = chunk.map((m) => {
		switch (m.kind) {
			case "user":
				return `user (seq ${m.seq}): ${m.text}`;
			case "assistant":
				return `assistant (seq ${m.seq}): ${m.text}${m.toolCalls.length ? ` [calls: ${m.toolCalls.map((c) => c.name).join(", ")}]` : ""}`;
			case "tool":
				return `tool ${m.name} ${m.ok ? "ok" : "failed"} (seq ${m.seq}): ${m.output.slice(0, LINE_CAP)}`;
			case "system":
				return `system: ${m.text}`;
		}
	});
	return [prior ? `Earlier recap:\n${prior}` : "", ...lines].filter(Boolean).join("\n");
}

/** One model call (no tools) that returns the brief. Undefined when the model returns nothing. */
export async function makeRecap(
	model: ModelPort,
	prior: string | undefined,
	chunk: readonly Message[],
	signal?: AbortSignal,
): Promise<{ text: string; usage?: Usage } | undefined> {
	const response = await model.complete({
		turn: 0,
		system: RECAP_SYSTEM,
		messages: [{ kind: "user", text: transcriptOf(prior, chunk), seq: 0 }],
		ledger: emptyLedger(),
		tools: [],
		signal,
	});
	const text = response.text.trim();
	return text ? { text, ...(response.usage ? { usage: response.usage } : {}) } : undefined;
}
