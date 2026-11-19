import type { AgentTool } from "@cline/shared";
import type { ProviderSettings } from "../agent/runner";
import { InProcessSubagent } from "../agent/subagents";

/**
 * `explore_codebase`: a read-only subagent with its own context window. The
 * child does the searching/reading; only its bounded answer re-enters the
 * parent's context — complements recall_context (pull) by never letting
 * exploration chatter into the transcript in the first place. Works over the
 * same tool objects as the parent, so it functions identically against a
 * remote (E2B) sandbox.
 */
const EXPLORE_TOOL_NAMES = new Set(["read_file", "list_files", "search_files", "list_plans", "read_plan"]);
const MAX_ITERATIONS = 12;
const OUTPUT_CAP = 6_000;

export interface ExploreToolOptions {
	settings: ProviderSettings;
	/** The parent's tool list — filtered to read-only names internally. */
	tools: readonly AgentTool<any, string>[];
	onEvent?: (text: string) => void;
}

export interface ExploreInput {
	question: string;
}

const EXPLORE_PROMPT = `You are a read-only code exploration agent. Investigate the repository and answer the question directly.

Rules:
- You cannot modify anything — read_file, list_files, search_files only.
- Be efficient: start with list_files/search_files to locate candidates, then read_file the regions that matter (start_line/end_line on large files).
- Answer concisely with file paths and line references. If the answer isn't in the repo, say so plainly.`;

export function createExploreTool(opts: ExploreToolOptions): AgentTool<ExploreInput, string> {
	return {
		name: "explore_codebase",
		executionMode: "sequential",
		description:
			"Delegate a read-only codebase investigation to a subagent with its own clean context window. " +
			"Use for open-ended questions that need searching and reading across many files — the subagent " +
			"does the exploration and returns a concise answer with file/line references, keeping this " +
			"transcript free of search noise. Give it a self-contained question; it sees no conversation history.",
		inputSchema: {
			type: "object",
			properties: {
				question: { type: "string", description: "Self-contained investigation question for the subagent." },
			},
			required: ["question"],
		},
		async execute(input) {
			const readTools = opts.tools.filter((t) => EXPLORE_TOOL_NAMES.has(t.name));
			if (!readTools.length) return "explore_codebase unavailable: no read tools in this context.";
			opts.onEvent?.(`explore_codebase started: ${input.question.slice(0, 120)}`);
			try {
				const sub = new InProcessSubagent({
					settings: opts.settings,
					tools: readTools,
					systemPrompt: EXPLORE_PROMPT,
					maxIterations: MAX_ITERATIONS,
					onEvent: opts.onEvent,
				});
				const handle = await sub.start(input.question);
				const text = await sub.result(handle);
				return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n…[answer truncated]` : text;
			} catch (err) {
				return `Exploration failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
