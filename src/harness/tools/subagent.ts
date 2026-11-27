/**
 * Subagents (vscode-free). A subagent is a nested HarnessLoop with its own log,
 * its own model port, and only the tools its contract allows. Only a capped
 * summary and the seqs of its successful tool calls return to the parent; the
 * subagent's full transcript stays in its own log.
 *
 * Policy: sequential (one at a time) and depth 1 (a subagent cannot spawn one).
 */

import type { ModelPort, ToolPort, ToolSpec, Usage } from "../core/contracts";
import { MemoryEventLog } from "../core/eventLog";
import { HarnessLoop, type HarnessLimits } from "../core/loop";

export interface SubagentContract {
	objective: string;
	/** Tool names the subagent may use. Anything else is refused. */
	tools: string[];
	maxTurns: number;
	maxInputTokens: number;
}

export interface SubagentResult {
	status: "completed" | "paused" | "failed";
	reason?: string;
	summary: string;
	evidence: number[];
	/** Tokens the subagent spent; the parent counts them against its own budget. */
	usage?: Usage;
}

export const SUBAGENT_SUMMARY_CAP = 2000;

const cap = (text: string): string => (text.length > SUBAGENT_SUMMARY_CAP ? `${text.slice(0, SUBAGENT_SUMMARY_CAP)}...[truncated]` : text);

/** Tools limited to an allowlist. Calls outside it fail as results, not as crashes. */
export function restrictTools(tools: ToolPort, allow: readonly string[]): ToolPort {
	const allowed = new Set(allow);
	return {
		specs: () => tools.specs().filter((t: ToolSpec) => allowed.has(t.name)),
		execute: async (name, input, callId) => (allowed.has(name) ? tools.execute(name, input, callId) : { ok: false, output: `tool ${name} is not allowed for this subagent` }),
	};
}

export class SubagentRunner {
	private busy = false;

	constructor(
		private readonly deps: { model: ModelPort; tools: ToolPort },
		private readonly depth = 0,
	) {}

	async run(contract: SubagentContract): Promise<SubagentResult> {
		if (this.depth >= 1) throw new Error("subagents cannot spawn subagents (depth limit 1)");
		if (this.busy) throw new Error("only one subagent runs at a time");
		if (contract.tools.length === 0) throw new Error("a subagent needs at least one allowed tool");
		this.busy = true;
		try {
			const log = new MemoryEventLog();
			const limits: Partial<HarnessLimits> = { maxTurns: contract.maxTurns, maxInputTokens: contract.maxInputTokens, maxRefusals: 0 };
			const loop = new HarnessLoop({
				runId: `sub-${Date.now()}`,
				log,
				model: this.deps.model,
				tools: restrictTools(this.deps.tools, contract.tools),
				limits,
			});
			const outcome = await loop.run(contract.objective);
			const events = await log.read();
			const lastAssistant = [...loop.projection.messages].reverse().find((m) => m.kind === "assistant");
			const evidence = events.flatMap((e) => (e.type === "tool.finished" && e.ok ? [e.seq] : []));
			// A paused/failed run often ends on a tool-call-only turn with no summary
			// text — fall back to a capped digest of what it did manage to read so
			// the parent gets partial findings instead of nothing.
			const summaryText =
				(lastAssistant?.kind === "assistant" ? lastAssistant.text : "") ||
				(() => {
					const reads = events.filter((e) => e.type === "tool.finished" && e.ok).slice(-3);
					return reads.length ? `Partial findings (run ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}):\n${reads.map((e) => (e as { name: string; output: string }).name + ": " + String((e as { output: string }).output).slice(0, 600)).join("\n---\n")}` : "";
				})();
			const usage = events.reduce<Usage>(
				(acc, e) => {
					const u = e.type === "model.response" || e.type === "context.recap" || e.type === "tool.finished" || e.type === "task.created" ? e.usage : undefined;
					return u ? { inputTokens: acc.inputTokens + u.inputTokens, outputTokens: acc.outputTokens + u.outputTokens, cachedTokens: acc.cachedTokens + u.cachedTokens } : acc;
				},
				{ inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
			);
			return {
				status: outcome.status,
				...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
				summary: cap(summaryText),
				evidence,
				...(usage.inputTokens + usage.outputTokens > 0 ? { usage } : {}),
			};
		} finally {
			this.busy = false;
		}
	}
}
