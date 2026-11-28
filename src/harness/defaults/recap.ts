/**
 * Recap compaction (vscode-free). When the compaction boundary advances by a
 * chunk, the model writes a brief of everything before it (plus the previous
 * recap). The brief is stored as a context.recap event, so recovery keeps it,
 * and the older messages it covers are dropped from the request.
 */

import type { ModelPort, Usage } from "../core/contracts";
import type { RecapPolicy } from "../core/policies/recap";
import { emptyLedger } from "../core/taskLedger";
import type { Message } from "../core/projections";

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

/**
 * Today's trigger logic as the default RecapPolicy: the manual Compact control
 * or context pressure (the last request exceeding the projected-context
 * budget). Task completion alone does NOT trigger a recap — for large-window
 * models that compacts far below the window, and the recap drops the verbatim
 * file contents the model then re-reads, feeding repeat-read loops. A failed
 * recap is not fatal — older messages stay stubbed.
 */
export const defaultRecapPolicy: RecapPolicy = {
	async maybeRecap(ctx) {
		const pressured = ctx.lastInputTokens * 4 > ctx.context.budgetChars;
		if (!ctx.forced && !pressured) return;
		const boundary = Math.max(0, ctx.state.messages.length - ctx.context.keepRecentMessages);
		const covered = ctx.state.recap?.covers ?? 0;
		if (boundary <= covered) return;
		let recap: Awaited<ReturnType<typeof makeRecap>>;
		try {
			recap = await makeRecap(ctx.model, ctx.state.recap?.text, ctx.state.messages.slice(covered, boundary), ctx.signal);
		} catch (err) {
			await ctx.emit({ type: "steer.note", rule: "context.recap", text: `compaction failed — continuing without it (${err instanceof Error ? err.message : String(err)})` });
			return;
		}
		if (!recap) return;
		await ctx.emit({ type: "context.recap", covers: boundary, text: recap.text, ...(recap.usage ? { usage: recap.usage } : {}) });
	},
};
