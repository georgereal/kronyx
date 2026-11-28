import { describe, expect, it } from "vitest";
import type { ModelPort, ToolPort } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { runHarness } from "../../src/harness/core/runner";
import type { RunViewEvent } from "../../src/agent/runner";

/** One scripted task through the IDE path (runHarness → view events) with a fake transport. */
async function runScripted(steps: Array<{ text?: string; calls?: Array<{ callId: string; name: string; input: unknown }> }>, toolPort: ToolPort, debug = false) {
	const queue = [...steps];
	const model: ModelPort = {
		complete: async () => {
			const next = queue.shift() ?? { text: "done" };
			return { text: next.text ?? "", toolCalls: next.calls ?? [], usage: { inputTokens: 20, outputTokens: 4, cachedTokens: 0 } };
		},
	};
	const events: RunViewEvent[] = [];
	const outcome = await runHarness({ runId: "parity", log: new MemoryEventLog(() => 1), model, tools: toolPort, emit: (e) => events.push(e), nudgeWrites: false, debug }, "task");
	return { outcome, events, left: queue.length };
}

const readTool: ToolPort = {
	specs: () => [{ name: "read_file", description: "", inputSchema: {}, parallel: true }],
	execute: async (name, input) => ({ ok: true, output: `${name} ${JSON.stringify(input)}` }),
};

describe("parity: IDE view events from a harness run (step 9)", () => {
	it("a read-and-answer task emits run-started, tool events with a turn, usage, assistant text and run-finished", async () => {
		const r = await runScripted([{ calls: [{ callId: "c1", name: "read_file", input: { path: "a.ts" } }] }, { text: "found it" }], readTool);
		expect(r.outcome.status).toBe("completed");
		expect(r.left).toBe(0);
		const types = r.events.map((e) => e.type);
		expect(types[0]).toBe("run-started");
		expect(types).toContain("tool-started");
		expect(types).toContain("tool-finished");
		expect(types).toContain("usage");
		expect(r.events.find((e) => e.type === "tool-started")).toMatchObject({ id: "c1", name: "read_file", iteration: 1 });
		expect(r.events.find((e) => e.type === "assistant-text")).toMatchObject({ text: "found it" });
		expect(r.events.at(-1)).toMatchObject({ type: "run-finished", status: "completed" });
	});

	it("a task with steps emits task-board snapshots that end with the step done (debug mode)", async () => {
		const tools: ToolPort = {
			specs: () => [{ name: "noop", description: "", inputSchema: {} }],
			execute: async () => ({ ok: true, output: "ok" }),
		};
		const r = await runScripted(
			[
				{ calls: [{ callId: "t", name: "task_create", input: { id: "a", title: "Parser", acceptance: { kind: "command", command: "npm test" }, steps: [{ id: "s1", text: "write" }] } }] },
				{ calls: [{ callId: "w", name: "noop", input: {} }] },
				{ calls: [{ callId: "s", name: "task_step_update", input: { taskId: "a", stepId: "s1", status: "in_progress", callIds: [] } }] },
				{ calls: [{ callId: "d", name: "task_step_update", input: { taskId: "a", stepId: "s1", status: "done", callIds: ["w"] } }] },
				{ text: "finished the parser" },
			],
			tools,
			true,
		);
		const boards = r.events.filter((e) => e.type === "task-board");
		expect(boards.length).toBeGreaterThan(0);
		const last = boards.at(-1);
		expect(last).toMatchObject({ type: "task-board", tasks: [{ id: "a", steps: [{ id: "s1", status: "done" }] }] });
	});

	it("emits no task-board events without debug", async () => {
		const tools: ToolPort = {
			specs: () => [],
			execute: async () => ({ ok: true, output: "ok" }),
		};
		const r = await runScripted(
			[
				{ calls: [{ callId: "t", name: "task_create", input: { id: "a", title: "P", steps: [] } }] },
				{ text: "done" },
			],
			tools,
		);
		expect(r.events.filter((e) => e.type === "task-board")).toEqual([]);
	});

	it("a refused write shows as a failed tool-finished, and the run still finishes", async () => {
		const r = await runScripted(
			[
				{ calls: [{ callId: "x", name: "task_step_update", input: { taskId: "nope", stepId: "s", status: "done", callIds: [] } }] },
				{ text: "could not" },
			],
			readTool,
		);
		expect(r.events.find((e) => e.type === "tool-finished" && e.id === "x")).toMatchObject({ ok: false });
		expect(r.outcome.status).toBe("completed");
	});
});
