import { describe, expect, it } from "vitest";
import type { ModelPort, ToolPort } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";
import { project } from "../../src/harness/core/projections";
import { boardOf } from "../../src/harness/core/runner";

const tools: ToolPort = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };
const model: ModelPort = { complete: async () => ({ text: "ok", toolCalls: [] }) };

describe("harness controls (step 7)", () => {
	it("clearing context empties what the model sees on replay, and keeps the log", async () => {
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model, tools });
		await loop.run("first task");
		expect(loop.projection.messages.length).toBeGreaterThan(0);
		await log.append({ type: "context.cleared", runId: "r" });
		const replayed = project(await log.read());
		expect(replayed.messages).toEqual([]);
		expect((await log.read()).some((e) => e.type === "user.input")).toBe(true);
	});

	it("compact now is refused when no run is active", () => {
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model, tools });
		expect(loop.requestCompact()).toBe(false);
	});
});

describe("task board (step 8)", () => {
	it("snapshots tasks in creation order with their steps", async () => {
		const log = new MemoryEventLog(() => 1);
		let turn = 0;
		const scripted: ModelPort = {
			complete: async () => {
				turn++;
				return turn === 1
					? { text: "", toolCalls: [{ callId: "c", name: "task_create", input: { id: "a", title: "Parser", acceptance: { kind: "command", command: "true" }, steps: [{ id: "s1", text: "write it" }] } }] }
					: { text: "", toolCalls: [] };
			},
		};
		const loop = new HarnessLoop({ runId: "r", log, model: scripted, tools });
		await loop.run("x");
		// The harness advances the board itself, then marks the task blocked at
		// close-out: no verifier exists here, so the acceptance can never pass.
		expect(boardOf(loop.projection)).toEqual([
			{ id: "a", title: "Parser", status: "blocked", steps: [{ id: "s1", text: "write it", status: "in_progress", callIds: [] }] },
		]);
	});
});
