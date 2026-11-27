/**
 * explore_codebase on the harness path (vscode-free). Wraps a tool port and adds
 * one tool that runs a read-only harness subagent with its own context. Only the
 * subagent's capped summary and evidence seqs return to the parent.
 */

import type { ModelPort, ToolPort, ToolResult, ToolSpec } from "../core/contracts";
import { SubagentRunner } from "./subagent";

export const EXPLORE_TOOL = "explore_codebase";
export const EXPLORE_READ_TOOLS = ["read_file", "list_files", "search_files", "list_plans", "read_plan"] as const;

const EXPLORE_SPEC: ToolSpec = {
	name: EXPLORE_TOOL,
	description:
		"Delegate a read-only codebase investigation to a subagent with its own clean context window. Use for open-ended questions that need searching and reading across many files. Give it a self-contained question; it sees no conversation history.",
	inputSchema: {
		type: "object",
		properties: { question: { type: "string", description: "Self-contained investigation question for the subagent." } },
		required: ["question"],
	},
};

export function withExplore(base: ToolPort, model: ModelPort, opts: { maxTurns?: number; maxInputTokens?: number } = {}): ToolPort {
	const runner = new SubagentRunner({ model, tools: base });
	const reads = new Set<string>(EXPLORE_READ_TOOLS);
	return {
		specs: () => {
			const offered = base.specs().filter((s) => s.name !== EXPLORE_TOOL);
			return reads.size && offered.some((s) => reads.has(s.name)) ? [...offered, EXPLORE_SPEC] : offered;
		},
		async execute(name, input, callId): Promise<ToolResult> {
			if (name !== EXPLORE_TOOL) return base.execute(name, input, callId);
			const question = (input as { question?: unknown } | null)?.question;
			if (typeof question !== "string" || !question.trim()) return { ok: false, output: "explore_codebase needs a question string." };
			const readTools = EXPLORE_READ_TOOLS.filter((t) => base.specs().some((s) => s.name === t));
			if (readTools.length === 0) return { ok: false, output: "explore_codebase is unavailable: no read tools in this run." };
			try {
				const result = await runner.run({
					objective: question,
					tools: [...readTools],
					maxTurns: opts.maxTurns ?? 12,
					maxInputTokens: opts.maxInputTokens ?? 200_000,
				});
				const evidence = result.evidence.length ? `\n(evidence: ${result.evidence.length} successful read calls)` : "";
				// A paused/budget-hit subagent still returns what it found — mark it
				// partial rather than failing the call outright.
				const partial = result.status !== "completed" ? `(partial — subagent ${result.status}${result.reason ? `: ${result.reason}` : ""})\n` : "";
				return { ok: result.status === "completed" || Boolean(result.summary), output: `${partial}${result.summary || result.reason || "No answer."}${evidence}`, ...(result.usage ? { usage: result.usage } : {}) };
			} catch (err) {
				return { ok: false, output: `explore_codebase failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		},
	};
}
