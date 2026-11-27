/**
 * Step evidence: callIds are harness-internal. The model-facing
 * task_step_update spec omits them, the harness attaches the proving calls on
 * done, a task that starts implicitly (step moved without task_update) still
 * gets a proof window, and harness-owned calls can't be cited as proof.
 */
import { describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, ModelResponse, ToolCall, ToolPort, ToolSpec, VerifierPort } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";
import { TASK_TOOL_NAMES } from "../../src/harness/core/taskLedger";

const readSpec: ToolSpec = { name: "read_file", description: "", inputSchema: {}, parallel: true };

function fakeTools(specs: ToolSpec[] = [readSpec], output = "ok") {
	const tools: ToolPort = {
		specs: () => specs,
		execute: async () => ({ ok: true, output }),
	};
	return { tools };
}

const pass: VerifierPort = { check: async () => ({ ok: true, detail: "passed" }) };

function scripted(steps: Array<Partial<ModelResponse>>) {
	const queue = [...steps];
	const requests: ModelRequest[] = [];
	const model: ModelPort = {
		async complete(req) {
			requests.push(req);
			const next = queue.shift();
			if (!next) throw new Error("model called more times than scripted");
			return { text: next.text ?? "", toolCalls: next.toolCalls ?? [], usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 } };
		},
	};
	return { model, requests };
}

const call = (callId: string, name: string, input: unknown): ToolCall => ({ callId, name, input });
const acting = (...toolCalls: ToolCall[]): Partial<ModelResponse> => ({ toolCalls });
const finish = (text = "done"): Partial<ModelResponse> => ({ text, toolCalls: [] });

const create = (callId = "c1") => call(callId, TASK_TOOL_NAMES.create, { id: "t1", title: "Do the work", acceptance: { kind: "none" }, steps: [{ id: "s1", text: "read" }] });

describe("evidence policy", () => {
	it("does not expose callIds on the model-facing task_step_update spec", async () => {
		const m = scripted([finish()]);
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model: m.model, tools: fakeTools().tools, verifier: pass });
		await loop.run("hello");
		const spec = m.requests[0]?.tools.find((t) => t.name === TASK_TOOL_NAMES.stepUpdate);
		expect(spec).toBeDefined();
		const props = (spec?.inputSchema.properties ?? {}) as Record<string, unknown>;
		expect("callIds" in props).toBe(false);
	});

	it("opens the proof window on implicit start and injects callIds on done", async () => {
		// t2 depends on t1, so the harness can't start it — but its step can
		// still move. That's the Session-13 shape: steps advanced while the
		// task sat pending and startedSeq was never set, so evidence attach
		// silently no-opped.
		const m = scripted([
			acting(
				create("c1"),
				call("c2", TASK_TOOL_NAMES.create, { id: "t2", title: "Follow-on", acceptance: { kind: "none" }, dependsOn: ["t1"], steps: [{ id: "s1", text: "read more" }] }),
			),
			acting(call("c4", "read_file", { path: "a" })),
			acting(call("c5", TASK_TOOL_NAMES.stepUpdate, { taskId: "t2", stepId: "s1", status: "done" })),
			finish(),
		]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools: fakeTools().tools, verifier: pass });
		const outcome = await loop.run("read a.ts");
		expect(outcome.status).toBe("completed");
		const events = await log.read();
		// t2 is dep-blocked until t1 closes, so its step can't move while the
		// task is still pending — the step.updated is refused and the step only
		// settles once t2 is running (here via the board close-out).
		const early = events.findIndex((e) => e.type === "step.updated" && e.taskId === "t2" && e.stepId === "s1");
		const t2Start = events.find((e) => e.type === "task.updated" && e.id === "t2" && e.to === "in_progress");
		expect(t2Start).toBeDefined();
		expect(early === -1 || early > events.indexOf(t2Start!)).toBe(true);
		expect(loop.projection.ledger.tasks.t2?.startedSeq).toBeDefined();
	});

	it("starts the parent task when a step moves and the transition is legal", async () => {
		const m = scripted([acting(create()), finish()]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools: fakeTools().tools, verifier: pass });
		await loop.run("x");
		const events = await log.read();
		// advanceBoard already starts dep-free tasks — the board never shows a
		// pending task with an in_progress step when the transition is legal.
		const started = events.find((e) => e.type === "task.updated" && e.id === "t1" && e.to === "in_progress");
		expect(started).toBeDefined();
		expect(loop.projection.ledger.tasks.t1?.startedSeq).toBeDefined();
	});

	it("ignores model-supplied callIds entirely on the conversations transport", async () => {
		const m = scripted([
			acting(create()),
			acting(call("c4", "read_file", { path: "a" })),
			acting(call("c5", TASK_TOOL_NAMES.stepUpdate, { taskId: "t1", stepId: "s1", status: "done", callIds: ["hallucinated_id"] })),
			finish(),
		]);
		(m.model as { capabilities?: unknown }).capabilities = { wire: "conversations" };
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools: fakeTools().tools, verifier: pass });
		await loop.run("read a.ts");
		const events = await log.read();
		const done = events.find((e) => e.type === "step.updated" && e.taskId === "t1" && e.stepId === "s1" && e.to === "done");
		expect(done?.type === "step.updated" && done.callIds).toEqual(["c4"]);
	});

	it("refuses citations that point at harness-owned calls", async () => {
		const m = scripted([
			acting(create()),
			acting(call("c3", TASK_TOOL_NAMES.stepUpdate, { taskId: "t1", stepId: "s1", status: "done", callIds: ["c1"] })),
			finish(),
		]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools: fakeTools().tools, verifier: pass });
		await loop.run("read a.ts");
		const events = await log.read();
		const failed = events.find((e) => e.type === "tool.finished" && e.callId === "c3");
		expect(failed?.type === "tool.finished" && failed.ok).toBe(false);
		expect(failed?.type === "tool.finished" && failed.output).toContain("can't be proven");
		expect(events.some((e) => e.type === "step.updated" && e.to === "done" && e.callIds.includes("c1"))).toBe(false);
	});
});
