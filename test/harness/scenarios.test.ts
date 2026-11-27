/**
 * M10 scripted scenario suite. Each scenario drives the whole harness with an
 * adversarial scripted model and asserts the harness, not the model, corrects it.
 * No network, no real provider: this runs in CI.
 */
import { describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, ModelResponse, ToolCall, ToolPort, ToolSpec, VerifierPort } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop, type HarnessLimits } from "../../src/harness/core/loop";
import { project } from "../../src/harness/core/projections";

const noop: ToolSpec = { name: "noop", description: "", inputSchema: {} };
const tools = (fail = false): ToolPort => ({
	specs: () => [noop],
	execute: async (name, input) => {
		if (name !== noop.name) return { ok: false, output: `Unknown or unavailable tool ${name}.` };
		return fail ? { ok: false, output: `${name} failed for ${JSON.stringify(input)}` } : { ok: true, output: `ran ${JSON.stringify(input)}` };
	},
});
const pass: VerifierPort = { check: async () => ({ ok: true, detail: "passed" }) };
const fail: VerifierPort = { check: async () => ({ ok: false, detail: "suite red" }) };

/** Scripted model: each step is consumed once; running out fails the test. */
function scripted(steps: Array<Partial<ModelResponse>>): { model: ModelPort; requests: ModelRequest[]; left: () => number } {
	const queue = [...steps];
	const requests: ModelRequest[] = [];
	return {
		requests,
		left: () => queue.length,
		model: {
			async complete(req) {
				requests.push(req);
				const next = queue.shift();
				if (!next) throw new Error("scenario model called more times than scripted");
				return { text: next.text ?? "", toolCalls: next.toolCalls ?? [], ...(next.usage ? { usage: next.usage } : {}) };
			},
		},
	};
}

const call = (callId: string, name: string, input: unknown): ToolCall => ({ callId, name, input });
const acting = (...toolCalls: ToolCall[]): Partial<ModelResponse> => ({ toolCalls });
const finish = (text = "done"): Partial<ModelResponse> => ({ text, toolCalls: [] });

async function run(opts: { steps: Array<Partial<ModelResponse>>; verifier?: VerifierPort; toolPort?: ToolPort; limits?: Partial<HarnessLimits> }) {
	const m = scripted(opts.steps);
	const log = new MemoryEventLog(() => 1);
	const loop = new HarnessLoop({ runId: "scenario", log, model: m.model, tools: opts.toolPort ?? tools(), verifier: opts.verifier, limits: opts.limits });
	const outcome = await loop.run("scenario task");
	return { outcome, loop, log, left: m.left, requests: m.requests };
}

const createTask = (id: string, steps: string[]) =>
	call(`create-${id}`, "task_create", { id, title: id, acceptance: { kind: "command", command: "npm test" }, steps: steps.map((text, i) => ({ id: `s${i + 1}`, text })) });

describe("scenario: loops", () => {
	it("breaks an identical-call loop, and the model finishes after tools are stripped", async () => {
		const repeats = [1, 2, 3, 4, 5].map((i) => acting(call(`r${i}`, "noop", { same: true })));
		const r = await run({ steps: [...repeats, finish("gave up repeating")] });
		expect(r.outcome.status).toBe("completed");
		expect(r.left()).toBe(0);
		// Strikes persist until a call makes progress; finishing alone does not clear them.
		expect(r.loop.projection.strikes).toBe(3);
	});

	it("pauses a model that keeps looping past the strip level, with the detector named", async () => {
		const repeats = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => acting(call(`r${i}`, "noop", { same: true })));
		const r = await run({ steps: repeats });
		expect(r.outcome.status).toBe("paused");
		expect(r.outcome.reason).toMatch(/^loop \(/);
	});
});

describe("scenario: premature completion", () => {
	it("refuses a finish while a signaled step is open, then the harness closes the board itself", async () => {
		const r = await run({
			verifier: pass,
			toolPort: tools(),
			steps: [
				acting(
					call("create", "task_create", {
						id: "parser",
						title: "parser",
						acceptance: { kind: "command", command: "npm test" },
						steps: [
							{ id: "s1", text: "write parser", signal: { tool: "noop" } },
							{ id: "s2", text: "review the result" },
						],
					}),
				),
				finish("all done"),
				acting(call("w", "noop", { x: 1 })),
				finish("parser complete"),
			],
		});
		expect(r.outcome.status).toBe("completed");
		const events = await r.log.read();
		expect(events.some((e) => e.type === "stop.refused")).toBe(true);
		// s1 closed on its signal with the real callId; s2 was covered by the passing acceptance check.
		const s1 = events.find((e) => e.type === "step.updated" && e.stepId === "s1" && e.to === "done");
		expect(s1?.type === "step.updated" && s1.callIds).toEqual(["w"]);
		expect(events.some((e) => e.type === "verifier.result" && e.ok)).toBe(true);
		expect(r.loop.projection.ledger.tasks.parser?.status).toBe("done");
	});

	it("marks the task blocked after repeated failed finishes instead of looping", async () => {
		const r = await run({ verifier: fail, limits: { maxRefusals: 2 }, steps: [acting(createTask("a", ["x"])), finish(), finish(), finish()] });
		expect(r.outcome).toMatchObject({ status: "completed" });
		expect(r.loop.projection.ledger.tasks.a?.status).toBe("blocked");
	});
});

describe("scenario: forgotten and ungrounded steps", () => {
	it("refuses a step done with no evidence and tells the model why", async () => {
		const r = await run({
			verifier: pass,
			steps: [acting(createTask("a", ["x"])), acting(call("bad", "task_step_update", { taskId: "a", stepId: "s1", status: "done", callIds: [] })), finish()],
		});
		const bad = r.loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "bad");
		expect(bad).toMatchObject({ ok: false });
	});

	it("refuses a step that cites a failed tool call", async () => {
		const r = await run({
			verifier: pass,
			toolPort: tools(true),
			steps: [
				acting(createTask("a", ["x"])),
				acting(call("w", "noop", { x: 1 })),
				acting(call("s", "task_step_update", { taskId: "a", stepId: "s1", status: "in_progress", callIds: [] })),
				acting(call("cite", "task_step_update", { taskId: "a", stepId: "s1", status: "done", callIds: ["w"] })),
				finish(),
			],
		});
		const cite = r.loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "cite");
		expect(cite).toMatchObject({ ok: false });
	});
});

describe("scenario: malformed input", () => {
	it("reports bad tool arguments as results and keeps the run alive", async () => {
		const r = await run({
			steps: [acting(call("bad1", "task_create", { id: "" })), acting(call("bad2", "task_update", "not-an-object")), finish()],
		});
		expect(r.outcome.status).toBe("completed");
		const bad = r.loop.projection.messages.filter((m) => m.kind === "tool" && (m.callId === "bad1" || m.callId === "bad2"));
		expect(bad.every((m) => m.kind === "tool" && !m.ok)).toBe(true);
	});

	it("refuses a call to a tool the harness does not offer", async () => {
		const r = await run({ steps: [acting(call("ghost", "does_not_exist", {})), finish()] });
		const ghost = r.loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "ghost");
		expect(ghost).toMatchObject({ ok: false });
	});
});

describe("scenario: budgets", () => {
	it("auto-extends the input allowance and continues when the budget is spent", async () => {
		const r = await run({
			limits: { maxInputTokens: 500 },
			steps: [
				{ toolCalls: [call("c1", "noop", { a: 1 })], usage: { inputTokens: 600, outputTokens: 1, cachedTokens: 0 } },
				finish(),
			],
		});
		expect(r.outcome).toMatchObject({ status: "completed" });
		expect(r.left()).toBe(0);
	});
});

describe("scenario: crash mid-run", () => {
	it("a replayed projection matches the live one after a run with every event kind", async () => {
		const r = await run({
			verifier: pass,
			steps: [acting(createTask("a", ["x"])), acting(call("w", "noop", { x: 1 })), acting(call("s", "task_step_update", { taskId: "a", stepId: "s1", status: "in_progress", callIds: [] })), finish()],
		});
		expect(project(await r.log.read())).toEqual(r.loop.projection);
	});
});

describe("scenario: verifier", () => {
	it("a failing acceptance command keeps the task open and the run does not finish it", async () => {
		const r = await run({
			verifier: fail,
			limits: { maxRefusals: 0 },
			steps: [
				acting(createTask("a", ["x"])),
				acting(call("w", "noop", { x: 1 })),
				acting(call("s1", "task_step_update", { taskId: "a", stepId: "s1", status: "in_progress", callIds: [] })),
				acting(call("s2", "task_step_update", { taskId: "a", stepId: "s1", status: "done", callIds: ["w"] })),
				acting(call("t1", "task_update", { id: "a", status: "in_progress" })),
				acting(call("t2", "task_update", { id: "a", status: "done" })),
				finish(),
			],
		});
		expect(r.loop.projection.ledger.tasks.a?.status).toBe("in_progress");
		expect(r.outcome.status).toBe("paused");
	});
});
