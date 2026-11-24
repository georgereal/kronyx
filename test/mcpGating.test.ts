import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { AgentTool } from "@cline/shared";
import { assembleToolSet } from "../src/agent/toolSet";
import type { AgentMode, ProviderSettings, RunnerHost } from "../src/agent/runner";
import { createMcpTools } from "../src/tools/mcpTools";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fakeMcpServer.mjs");
const settings: ProviderSettings = { providerId: "openai", baseUrl: "https://x.test/v1", modelId: "m", apiKey: "k", maxIterations: 3 };
const readTool = (): AgentTool<any, string> => ({ name: "read_file", description: "r", inputSchema: { type: "object", properties: {} }, executionMode: "parallel", execute: async () => "ok" });

function hostFor(mode: AgentMode, tools: AgentTool<any, string>[], confirm: () => Promise<boolean>): RunnerHost {
	return {
		workspaceRoot: "/tmp/ws",
		isDirty: () => false,
		relativePath: (p) => p,
		currentMode: () => mode,
		emit: () => {},
		tools: async () => tools,
		ideTools: true,
		approvals: { confirm: async () => confirm() },
	};
}

describe("MCP tools under mode gating", () => {
	it("hides MCP writes in ask/plan, keeps readOnlyHint tools, and routes writes by mode", async () => {
		const mcp = await createMcpTools({ servers: [{ name: "fake", command: process.execPath, args: [fixture] }] });
		try {
			const echo = mcp.tools.find((t) => t.name === "mcp_fake_echo")!;
			const status = mcp.tools.find((t) => t.name === "mcp_fake_status")!;
			const input = { text: "hi" };

			const ask = await assembleToolSet(hostFor("ask", [readTool(), echo, status], async () => true), settings, "t", () => {});
			expect(ask.tools.map((t) => t.name)).not.toContain("mcp_fake_echo");
			expect(ask.tools.map((t) => t.name)).toContain("mcp_fake_status");
			expect(await ask.pipeline.runPre({ name: "mcp_fake_echo", input })).toMatchObject({ kind: "deny" });
			expect(await ask.pipeline.runPre({ name: "mcp_fake_status", input: {} })).toEqual({ kind: "allow" });

			const plan = await assembleToolSet(hostFor("plan", [readTool(), echo, status], async () => true), settings, "t", () => {});
			expect(plan.tools.map((t) => t.name)).not.toContain("mcp_fake_echo");

			let asked = 0;
			const code = await assembleToolSet(hostFor("code", [readTool(), echo, status], async () => { asked++; return false; }), settings, "t", () => {});
			expect(code.tools.map((t) => t.name)).toContain("mcp_fake_echo");
			expect(await code.pipeline.runPre({ name: "mcp_fake_echo", input })).toMatchObject({ kind: "deny" });
			expect(asked).toBe(1);

			const smart = await assembleToolSet(hostFor("smart", [readTool(), echo, status], async () => false), settings, "t", () => {});
			expect(await smart.pipeline.runPre({ name: "mcp_fake_echo", input })).toEqual({ kind: "allow" });
		} finally {
			await mcp.close();
		}
	}, 30_000);
});
