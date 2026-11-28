/**
 * Tool port over the host's existing tools (vscode-free). Keeps the permission
 * decision and approval path of the current runner: a deny is a refused result,
 * an ask needs an explicit confirmation, and hidden tools are not offered.
 */

import type { AgentTool } from "@cline/shared";
import type { ToolPort, ToolResult, ToolSpec } from "../core/contracts";

export type Decision = "allow" | "ask" | "deny";

export interface HarnessToolPortOptions {
	// biome-ignore lint/suspicious/noExplicitAny: tool inputs vary per tool
	tools: readonly AgentTool<any, string>[];
	/** Tools withheld from the model (for example write tools in ask and plan modes). */
	hidden: ReadonlySet<string>;
	check(name: string, input: unknown, callId?: string): Promise<Decision>;
	confirm(name: string, input: unknown, callId?: string): Promise<boolean>;
}

export function createHarnessToolPort(opts: HarnessToolPortOptions): ToolPort {
	const visible = opts.tools.filter((t) => !opts.hidden.has(t.name));
	return {
		specs: (): ToolSpec[] => visible.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, parallel: t.executionMode === "parallel" })),
		async execute(name, input, callId): Promise<ToolResult> {
			const tool = visible.find((t) => t.name === name);
			if (!tool) return { ok: false, output: `Unknown or unavailable tool ${name}.` };
			const decision = await opts.check(name, input, callId);
			if (decision === "deny") return { ok: false, output: `Denied by permission rules: ${name}.` };
			if (decision === "ask" && !(await opts.confirm(name, input, callId))) return { ok: false, output: `${name} needs approval, and it was not granted.` };
			try {
				const out = await tool.execute(input as never, { agentId: "harness", iteration: 0, ...(callId ? { toolCallId: callId } : {}) });
				return { ok: true, output: typeof out === "string" ? out : JSON.stringify(out) };
			} catch (err) {
				return { ok: false, output: `tool error: ${err instanceof Error ? err.message : String(err)}` };
			}
		},
	};
}
