import { describe, expect, it } from "vitest";
import type { LoopDetectorConfig, ModelPort, ModelRequest, ModelResponse, ToolCall, ToolPort, ToolResult, ToolSpec, VerifierPort } from "../../src/harness/contracts";
import { MemoryEventLog } from "../../src/harness/eventLog";
import { HarnessLoop, type HarnessLimits } from "../../src/harness/loop";
import { project } from "../../src/harness/projections";

/** A model that replays a fixed script of responses, one per call. Any extra call fails the test. */
function scriptedModel(script: Array<Partial<ModelResponse> & { calls?: ToolCall[] }>) {
	const requests: ModelRequest[] = [];
	const model: ModelPort = {
		async complete(request) {
			requests.push(request);
			const next = script.shift();
			if (!next) throw new Error("model called more times than scripted");
			return { text: next.text ?? "", toolCalls: next.calls ?? next.toolCalls ?? [], usage: next.usage ?? { inputTokens: 100, outputTokens: 10, cachedTokens: 0 } };
		},
	};
	return { model, requests, remaining: () => script.length };
}

const call = (callId: string, name: string, input: unknown): ToolCall => ({ callId, name, input });
const finish = (text = "done") => ({ text, calls: [] as ToolCall[] });
const acting = (...calls: ToolCall[]) => ({ text: "", calls });

function fakeTools(specs: ToolSpec[] = [], handler: (name: string, input: unknown) => ToolResult | Promise<ToolResult> = () => ({ ok: true, output: "ok" })) {
	const tools: ToolPort = {
		specs: () => specs,
		execute: async (name, input) => handler(name, input),
	};
	return tools;
}

const passingVerifier: VerifierPort = { check: async () => ({ ok: true, detail: "suite passed" }) };
const failingVerifier: VerifierPort = { check: async () => ({ ok: false, detail: "suite failed" }) };

function harness(opts: { script: Array<Partial<ModelResponse> & { calls?: ToolCall[] }>; verifier?: VerifierPort; tools?: ToolPort; limits?: Partial<HarnessLimits>; loop?: Partial<LoopDetectorConfig> }) {
	const scripted = scriptedModel(opts.script);
	const log = new MemoryEventLog(() => 1);
	const loop = new HarnessLoop({ runId: "run-1", log, model: scripted.model, tools: opts.tools ?? fakeTools(), verifier: opts.verifier, limits: opts.limits, loop: opts.loop });
	return { loop, log, scripted };
}

const createTask = (id: string, deps: string[] = []) =>
	call(`c-${id}`, "task_create", { id, title: id, acceptance: { kind: "command", command: "true" }, dependsOn: deps, steps: [{ id: "s1", text: `${id} work` }] });
const noopSpec: ToolSpec = { name: "noop", description: "", inputSchema: {} };
const stepUpdate = (taskId: string, stepId: string, status: string, callIds: string[], callId: string) => call(callId, "task_step_update", { taskId, stepId, status, callIds });
/** Creates a task, proves its one step with a successful tool call, then tries to finish the task. */
const finishTaskScript = (id: string) => [
	acting(createTask(id)),
	acting(call(`${id}-w`, "noop", {})),
	acting(stepUpdate(id, "s1", "in_progress", [], `${id}-s1a`)),
	acting(stepUpdate(id, "s1", "done", [`${id}-w`], `${id}-s1b`)),
	acting(setStatus(id, "in_progress")),
	acting(setStatus(id, "done")),
];
const setStatus = (id: string, status: string, callId = `s-${id}-${status}`) => call(callId, "task_update", { id, status });

describe("HarnessLoop: happy path", () => {
	it("creates a task, proves its step with a tool call, verifies and completes it, then finishes", async () => {
		const { loop, log, scripted } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec]),
			script: [...finishTaskScript("parser"), finish("parser is done")],
		});
		const outcome = await loop.run("add a parser");
		expect(outcome).toMatchObject({ status: "completed" });
		expect(scripted.remaining()).toBe(0);
		expect(loop.projection.ledger.tasks.parser?.status).toBe("done");
		expect(loop.projection.ledger.verified).toEqual(["parser"]);
		expect(loop.projection.run.status).toBe("completed");
		expect((await log.read()).map((e) => e.type)).toContain("verifier.result");
	});

	it("keeps the live projection equal to a replay of the log", async () => {
		const { loop, log } = harness({ verifier: passingVerifier, tools: fakeTools([noopSpec]), script: [...finishTaskScript("a"), finish()] });
		await loop.run("go");
		expect(loop.projection).toEqual(project(await log.read()));
	});
});

describe("HarnessLoop: steering", () => {
	it("refuses a finish while a signaled step is open, then the harness closes the board once it fires", async () => {
		const { loop, log } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec]),
			script: [
				acting(call("c-a", "task_create", { id: "a", title: "a", acceptance: { kind: "command", command: "true" }, steps: [{ id: "s1", text: "work", signal: { tool: "noop" } }] })),
				finish("all done"),
				acting(call("w", "noop", {})),
				finish("now done"),
			],
		});
		const outcome = await loop.run("do a");
		expect(outcome.status).toBe("completed");
		const events = await log.read();
		expect(events.some((e) => e.type === "stop.refused")).toBe(true);
		expect(loop.projection.messages.some((m) => m.kind === "system" && m.text.includes("Open work remains: a"))).toBe(true);
		// The signal match cited the real tool call as evidence.
		const done = events.find((e) => e.type === "step.updated" && e.stepId === "s1" && e.to === "done");
		expect(done?.type === "step.updated" && done.callIds).toEqual(["w"]);
		expect(loop.projection.ledger.tasks.a?.status).toBe("done");
	});

	it("closes out an open task itself at finish: acceptance covers unsignaled steps", async () => {
		const { loop, log } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec]),
			script: [acting(createTask("a")), finish("done")],
		});
		const outcome = await loop.run("do a");
		expect(outcome.status).toBe("completed");
		const events = await log.read();
		expect(events.some((e) => e.type === "stop.refused")).toBe(false);
		expect(events.some((e) => e.type === "verifier.result" && e.ok)).toBe(true);
		expect(loop.projection.ledger.tasks.a?.status).toBe("done");
	});

	it("marks the task blocked after repeated failed finishes instead of looping", async () => {
		const { loop, log } = harness({
			verifier: failingVerifier,
			limits: { maxRefusals: 2 },
			script: [acting(createTask("a")), finish(), finish(), finish()],
		});
		const outcome = await loop.run("do a");
		expect(outcome).toMatchObject({ status: "completed" });
		expect(loop.projection.ledger.tasks.a?.status).toBe("blocked");
		const events = await log.read();
		expect(events.some((e) => e.type === "task.updated" && e.id === "a" && e.to === "blocked")).toBe(true);
	});

	it("rejects marking a task done without a verifier configured", async () => {
		const { loop } = harness({ script: [acting(createTask("a")), acting(setStatus("a", "in_progress")), acting(setStatus("a", "done")), finish()] , limits: { maxRefusals: 0 } });
		const outcome = await loop.run("x");
		expect(loop.projection.ledger.tasks.a?.status).toBe("in_progress");
		const result = loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "s-a-done");
		expect(result).toMatchObject({ ok: false });
		expect(outcome.status).toBe("paused");
	});

	it("keeps a task open when its acceptance check fails", async () => {
		const { loop } = harness({
			verifier: failingVerifier,
			limits: { maxRefusals: 0 },
			tools: fakeTools([noopSpec]),
			script: [...finishTaskScript("a"), finish()],
		});
		await loop.run("x");
		expect(loop.projection.ledger.tasks.a?.status).toBe("in_progress");
		expect(loop.projection.ledger.verified).toEqual([]);
		const failed = loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "s-a-done");
		expect(failed).toMatchObject({ ok: false });
		expect(failed?.kind === "tool" && failed.output).toMatch(/suite failed/);
	});

	it("rejects deleting a completed task and leaves it in the ledger", async () => {
		const { loop } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec]),
			script: [...finishTaskScript("a"), acting(call("rm", "task_remove", { id: "a" })), finish()],
		});
		await loop.run("x");
		expect(loop.projection.ledger.order).toEqual(["a"]);
		const rm = loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "rm");
		expect(rm).toMatchObject({ ok: false });
	});

	it("reports an invalid tool input as a result, not a crash", async () => {
		const { loop } = harness({ verifier: passingVerifier, script: [acting(call("bad", "task_create", { id: "" })), finish()] });
		const outcome = await loop.run("x");
		expect(outcome.status).toBe("completed");
		const bad = loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "bad");
		expect(bad).toMatchObject({ ok: false });
	});
});

describe("HarnessLoop: budgets and terminal states", () => {
	it("pauses at the turn limit and resumes with a fresh window", async () => {
		const { loop, scripted } = harness({
			limits: { maxTurns: 2 },
			script: [acting(call("c1", "noop", {})), acting(call("c2", "noop", {})), finish("resumed and finished")],
			tools: fakeTools([{ name: "noop", description: "", inputSchema: {} }]),
		});
		expect(await loop.run("x")).toMatchObject({ status: "paused", reason: "max_turns" });
		expect(await loop.resume()).toMatchObject({ status: "completed" });
		expect(scripted.remaining()).toBe(0);
	});

	it("pauses when the input budget is spent and warns once at 80%", async () => {
		const { loop, log } = harness({
			limits: { maxInputTokens: 1000 },
			script: [
				{ text: "", calls: [call("c1", "noop", {})], usage: { inputTokens: 850, outputTokens: 1, cachedTokens: 0 } },
				{ text: "", calls: [call("c2", "noop", {})], usage: { inputTokens: 200, outputTokens: 1, cachedTokens: 0 } },
			],
			tools: fakeTools([{ name: "noop", description: "", inputSchema: {} }]),
		});
		expect(await loop.run("x")).toMatchObject({ status: "paused", reason: "input_budget" });
		const warnings = (await log.read()).filter((e) => e.type === "budget.warning");
		expect(warnings).toHaveLength(1);
	});

	it("treats a failing external tool as a result the model can react to", async () => {
		const { loop } = harness({
			script: [acting(call("c1", "fetch", {})), finish("handled the error")],
			tools: fakeTools([{ name: "fetch", description: "", inputSchema: {} }], () => {
				throw new Error("network down");
			}),
		});
		expect(await loop.run("x")).toMatchObject({ status: "completed" });
		const failed = loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "c1");
		expect(failed).toMatchObject({ ok: false });
	});

	it("fails the run when the model port throws", async () => {
		const model: ModelPort = {
			async complete() {
				throw new Error("provider 500");
			},
		};
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model, tools: fakeTools() });
		expect(await loop.run("x")).toMatchObject({ status: "failed", reason: "provider 500" });
		expect(loop.projection.run.status).toBe("failed");
	});

	it("refuses a second run while one is in progress", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const model: ModelPort = {
			async complete() {
				await gate;
				return { text: "ok", toolCalls: [] };
			},
		};
		const loop = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model, tools: fakeTools() });
		const first = loop.run("one");
		await expect(loop.run("two")).rejects.toThrow(/already in progress/);
		release();
		await first;
	});

	it("rejects a tool that tries to use a reserved task-ledger name", () => {
		expect(() => new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model: scriptedModel([]).model, tools: fakeTools([{ name: "task_create", description: "", inputSchema: {} }]) })).toThrow(/reserved/);
	});
});

describe("HarnessLoop: steering integration (M4)", () => {
	it("refuses a task_step_update to done that cites no tool calls, and the model sees why", async () => {
		const { loop } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec]),
			limits: { maxRefusals: 0 },
			script: [acting(createTask("a")), acting(stepUpdate("a", "s1", "done", [], "bad")), finish()],
		});
		await loop.run("x");
		const bad = loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "bad");
		expect(bad).toMatchObject({ ok: false });
		expect(bad?.kind === "tool" && bad.output).toMatch(/step\.grounding|callIds/);
	});

	it("pauses when a beforeModel rule denies, without calling the model", async () => {
		const { scripted } = harness({ script: [finish()] });
		const registry = new (await import("../../src/harness/steering")).SteeringRegistry();
		registry.add("beforeModel", { id: "stop-here", point: "beforeModel", order: 0, decide: () => ({ kind: "deny", reason: "budget frozen" }) });
		const paused = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model: scripted.model, tools: fakeTools(), steering: registry });
		expect(await paused.run("x")).toMatchObject({ status: "paused", reason: "budget frozen" });
	});

	it("fails the run with the rule id when an onStop rule throws", async () => {
		const registry = new (await import("../../src/harness/steering")).SteeringRegistry();
		registry.add("onStop", { id: "explodes", point: "onStop", order: 0, decide: () => { throw new Error("bad rule"); } });
		const { loop } = harness({ script: [finish()] });
		const broken = new HarnessLoop({ runId: "r", log: new MemoryEventLog(() => 1), model: (loop as unknown as { deps: { model: ModelPort } }).deps.model, tools: fakeTools(), steering: registry });
		const outcome = await broken.run("x");
		expect(outcome.status).toBe("failed");
		expect(outcome.reason).toMatch(/explodes/);
	});
});

describe("HarnessLoop: loop controller (M5)", () => {
	const loopCfg = { repeatThreshold: 3, resultThreshold: 10, alternationThreshold: 3, window: 10 };

	it("escalates warn, block, strip on repeated identical calls, then finishes once tools are stripped", async () => {
		const calls = [1, 2, 3, 4, 5].map((i) => call(`r${i}`, "noop", { path: "a" }));
		const { loop, log, scripted } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec]),
			loop: loopCfg,
			script: [...calls.map((c) => acting(c)), finish("stopped repeating")],
		});
		const outcome = await loop.run("x");
		expect(outcome.status).toBe("completed");
		expect(scripted.remaining()).toBe(0);
		const levels = (await log.read()).filter((e) => e.type === "loop.verdict").map((e) => (e.type === "loop.verdict" ? e.level : ""));
		expect(levels).toEqual(["warn", "block", "strip"]);
		const blocked = loop.projection.messages.find((m) => m.kind === "tool" && m.callId === "r4");
		expect(blocked).toMatchObject({ ok: false });
	});

	it("pauses with reason loop when the model keeps going after the strip level", async () => {
		const calls = [1, 2, 3, 4, 5, 6, 7].map((i) => acting(call(`r${i}`, "noop", { path: "a" })));
		const { loop } = harness({ verifier: passingVerifier, tools: fakeTools([noopSpec]), loop: loopCfg, script: calls });
		expect(await loop.run("x")).toMatchObject({ status: "paused", reason: "loop (repeat)" });
	});

	it("flags a stuck call that keeps returning the same result", async () => {
		const calls = [1, 2, 3].map((i) => acting(call(`s${i}`, "noop", { path: "a" })));
		const { loop, log } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec], () => ({ ok: true, output: "same" })),
			loop: { repeatThreshold: 10, resultThreshold: 3, alternationThreshold: 3, window: 10 },
			script: [...calls, finish()],
		});
		await loop.run("x");
		const reasons = (await log.read()).filter((e) => e.type === "loop.verdict");
		expect(reasons.length).toBeGreaterThan(0);
	});

	it("flags A-B-A-B alternation", async () => {
		const a = (i: number) => acting(call(`a${i}`, "noop", { path: "a" }));
		const b = (i: number) => acting(call(`b${i}`, "noop", { path: "b" }));
		const { loop, log } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec]),
			loop: { repeatThreshold: 10, resultThreshold: 10, alternationThreshold: 3, window: 10 },
			script: [a(1), b(1), a(2), b(2), a(3), b(3), finish()],
		});
		await loop.run("x");
		const verdicts = (await log.read()).filter((e) => e.type === "loop.verdict");
		expect(verdicts.some((e) => e.type === "loop.verdict" && e.reason === "alternation")).toBe(true);
	});

	it("clears strikes after progress, so a later repeat starts at warn again", async () => {
		const { loop, log } = harness({
			verifier: passingVerifier,
			tools: fakeTools([noopSpec]),
			loop: loopCfg,
			script: [
				acting(call("p1", "noop", { path: "a" })),
				acting(call("p2", "noop", { path: "a" })),
				acting(call("p3", "noop", { path: "a" })),
				acting(call("q1", "noop", { path: "b" })),
				acting(call("p4", "noop", { path: "a" })),
				finish(),
			],
		});
		await loop.run("x");
		const levels = (await log.read()).filter((e) => e.type === "loop.verdict").map((e) => (e.type === "loop.verdict" ? e.level : ""));
		expect(levels).toEqual(["warn", "none", "warn"]);
	});
});
