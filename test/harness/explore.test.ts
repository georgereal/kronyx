import { describe, expect, it } from "vitest";
import type { ModelPort, ToolPort } from "../../src/harness/core/contracts";
import { EXPLORE_TOOL, withExplore } from "../../src/harness/tools/explore";

const base: ToolPort = {
	specs: () => [
		{ name: "read_file", description: "", inputSchema: {}, parallel: true },
		{ name: "write_file", description: "", inputSchema: {} },
	],
	execute: async (name) => ({ ok: true, output: `ran ${name}` }),
};

describe("explore_codebase on the harness (step 4)", () => {
	it("adds the explore tool only when read tools exist", () => {
		const model: ModelPort = { complete: async () => ({ text: "", toolCalls: [] }) };
		expect(withExplore(base, model).specs().map((s) => s.name)).toContain(EXPLORE_TOOL);
		const noReads: ToolPort = { specs: () => [{ name: "write_file", description: "", inputSchema: {} }], execute: base.execute };
		expect(withExplore(noReads, model).specs().map((s) => s.name)).not.toContain(EXPLORE_TOOL);
	});

	it("runs a read-only subagent and returns its answer", async () => {
		let turn = 0;
		const model: ModelPort = {
			complete: async () => {
				turn++;
				return turn === 1
					? { text: "", toolCalls: [{ callId: "r1", name: "read_file", input: { path: "a.ts" } }] }
					: { text: "The answer is in a.ts:3", toolCalls: [] };
			},
		};
		const result = await withExplore(base, model).execute(EXPLORE_TOOL, { question: "where is it?" });
		expect(result).toMatchObject({ ok: true });
		expect(result.output).toMatch(/a\.ts:3/);
	});

	it("returns partial findings when the subagent pauses on budget", async () => {
		// One read turn, then the subagent hits its turn limit — the parent still
		// gets a digest of what it managed to read instead of a bare failure.
		const model: ModelPort = {
			complete: async () => ({ text: "", toolCalls: [{ callId: "r1", name: "read_file", input: { path: "a.ts" } }] }),
		};
		const result = await withExplore(base, model, { maxTurns: 1 }).execute(EXPLORE_TOOL, { question: "where?" });
		expect(result.ok).toBe(true);
		expect(result.output).toMatch(/partial/i);
		expect(result.output).toContain("ran read_file");
	});

	it("refuses a call without a question", async () => {
		const model: ModelPort = { complete: async () => ({ text: "", toolCalls: [] }) };
		expect(await withExplore(base, model).execute(EXPLORE_TOOL, {})).toMatchObject({ ok: false });
	});

	it("passes other tool calls through to the base port", async () => {
		const model: ModelPort = { complete: async () => ({ text: "", toolCalls: [] }) };
		expect(await withExplore(base, model).execute("write_file", {})).toMatchObject({ ok: true, output: "ran write_file" });
	});
});
