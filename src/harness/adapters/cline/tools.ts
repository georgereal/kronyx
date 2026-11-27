import type { ToolDefinition } from "@cline/shared";
import type { ModelRequest } from "../../core/contracts";

export function toClineTools(tools: ModelRequest["tools"]): ToolDefinition[] {
	return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
