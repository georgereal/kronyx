import { describe, expect, it } from "vitest";
import type { ModelPort, ToolPort } from "../../src/harness/contracts";
import { MemoryEventLog } from "../../src/harness/eventLog";
import { HarnessLoop } from "../../src/harness/loop";

const tools: ToolPort = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };

describe("zero-tool nudge on the harness (step 5)", () => {
	it("nudges a write-mode run that made no tool calls exactly once, then lets it finish", async () => {
		const log = new MemoryEventLog(() => 1);
		let turn = 0;
		const model: ModelPort = {
			complete: async () => {
				turn++;
				return { text: turn === 1 ? "I would do it" : "now done", toolCalls: [] };
			},
		};
		const loop = new HarnessLoop({ runId: "r", log, model, tools, nudgeWrites: true });
		expect(await loop.run("add a parser")).toMatchObject({ status: "completed" });
		const nudges = (await log.read()).filter((e) => e.type === "steer.note" && e.rule === "nudge.proceed");
		expect(nudges).toHaveLength(1);
	});

	it("does not nudge a conversational run (nudgeWrites off)", async () => {
		const log = new MemoryEventLog(() => 1);
		const model: ModelPort = { complete: async () => ({ text: "hi", toolCalls: [] }) };
		await new HarnessLoop({ runId: "r", log, model, tools }).run("hi");
		expect((await log.read()).some((e) => e.type === "steer.note")).toBe(false);
	});
});
