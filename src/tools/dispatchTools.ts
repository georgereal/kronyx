import type { AgentTool } from "@cline/shared";

/**
 * Deferred tool schemas: heavyweight, rarely-used tools stay OUT of the
 * per-request tool list (their JSON schemas cost tokens on every turn) and are
 * reached through this single `use_tool` dispatcher instead — the same lazy
 * loading pattern MCP clients use (names + one-liners up front, full schema
 * fetched on demand). Only auxiliary tools belong here: file/write tools stay
 * loaded so the beforeTool permission flow sees them directly.
 */
export const DEFERRED_TOOLS = new Set(["browser_use", "switch_environment", "fetch_url", "load_skill"]);

const firstLine = (s: string): string => s.split("\n").find((l) => l.trim())?.trim() ?? "";

export interface UseToolInput {
	name: string;
	input?: Record<string, unknown>;
}

export function createDispatchTool(deferred: readonly AgentTool<any, string>[]): AgentTool<UseToolInput, string> {
	const byName = new Map(deferred.map((t) => [t.name, t]));
	const catalog = deferred.map((t) => `- ${t.name}: ${firstLine(String(t.description ?? ""))}`).join("\n");
	return {
		name: "use_tool",
		executionMode: "sequential",
		description:
			"Access a tool whose schema isn't loaded upfront. Call with just \"name\" to get the tool's description and inputSchema, then call again with \"name\" and \"input\" to run it.\nAvailable tools:\n" +
			catalog,
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Deferred tool name from the catalog." },
				input: { type: "object", description: "Arguments for the tool (see its inputSchema)." },
			},
			required: ["name"],
		},
		async execute(input, context) {
			const tool = byName.get(input.name);
			if (!tool) return `Unknown tool "${input.name}". Available: ${[...byName.keys()].join(", ") || "(none)"}.`;
			if (input.input === undefined) {
				return JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
			}
			try {
				const out = await tool.execute(input.input, context);
				return typeof out === "string" ? out : JSON.stringify(out);
			} catch (err) {
				return `Tool "${input.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
