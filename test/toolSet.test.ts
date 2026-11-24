import { describe, expect, it } from "vitest";
import type { AgentTool } from "@cline/shared";
import { assembleToolSet } from "../src/agent/toolSet";
import type { AgentMode, ProviderSettings, RunnerHost } from "../src/agent/runner";

const tool = (name: string, executionMode: "parallel" | "sequential"): AgentTool<any, string> => ({
	name,
	description: name,
	inputSchema: { type: "object", properties: {} },
	executionMode,
	execute: async () => "ok",
});

const settings: ProviderSettings = { providerId: "openai", baseUrl: "https://x.test/v1", modelId: "m", apiKey: "k", maxIterations: 3 };

function hostFor(mode: AgentMode, tools: AgentTool<any, string>[], ideTools = true): RunnerHost {
	return {
		workspaceRoot: "/tmp/ws",
		isDirty: () => false,
		relativePath: (p) => p,
		currentMode: () => mode,
		emit: () => {},
		tools: async () => tools,
		ideTools,
	};
}

const modesOf = (tools: AgentTool<any, string>[]) => Object.fromEntries(tools.map((t) => [t.name, t.executionMode]));

describe("assembleToolSet execution policy", () => {
	const tools = [tool("read_file", "parallel"), tool("list_files", "parallel"), tool("search_symbols", "parallel"), tool("write_file", "parallel"), tool("run_command", "parallel")];

	it("keeps pure reads parallel in ask and plan, and makes writes ordered boundaries", async () => {
		for (const mode of ["ask", "plan"] as const) {
			const { tools: out } = await assembleToolSet(hostFor(mode, tools), settings, "task", () => {});
			expect(modesOf(out)).toMatchObject({ read_file: "parallel", list_files: "parallel", search_symbols: "parallel" });
			// Plan mode keeps write_file visible — the write-mode guard scopes it
			// to .kronyx/** and the temp dir. Ask hides all write tools.
			expect(out.find((t) => t.name === "write_file")?.executionMode).toBe(mode === "plan" ? "sequential" : undefined);
			// Plan mode also keeps run_command visible — its calls fall through to
			// the approval stage so a read-only command can be confirmed by the user.
			expect(out.find((t) => t.name === "run_command")?.executionMode).toBe(mode === "plan" ? "sequential" : undefined);
		}
	});

	it("honors parallel markers in write modes", async () => {
		const { tools: out } = await assembleToolSet(hostFor("code", tools), settings, "task", () => {});
		expect(modesOf(out)).toMatchObject({ read_file: "parallel", write_file: "parallel", run_command: "parallel" });
	});

	it("keeps the strict ordering and no progress tool on non-IDE hosts (cloud worker)", async () => {
		for (const mode of ["ask", "plan"] as const) {
			const { tools: out } = await assembleToolSet(hostFor(mode, tools, false), settings, "task", () => {});
			expect(modesOf(out)).toMatchObject({ read_file: "sequential", list_files: "sequential" });
			expect(out.find((t) => t.name === "update_progress")).toBeUndefined();
		}
		const { tools: code } = await assembleToolSet(hostFor("code", tools, false), settings, "task", () => {});
		expect(code.find((t) => t.name === "update_progress")).toBeUndefined();
	});

	it("exposes update_progress on IDE hosts", async () => {
		const { tools: out } = await assembleToolSet(hostFor("code", tools), settings, "task", () => {});
		expect(out.find((t) => t.name === "update_progress")?.executionMode).toBe("sequential");
	});

	it("forces a non-read parallel tool to sequential in plan mode", async () => {
		const rogue = tool("update_thing", "parallel");
		const { tools: out } = await assembleToolSet(hostFor("plan", [rogue]), settings, "task", () => {});
		expect(modesOf(out).update_thing).toBe("sequential");
	});
});
