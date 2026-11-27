/**
 * Harness-owned board: the planner pass writes the checklist, signals complete
 * steps on matching tool calls, and close-out verifies what remains. The model
 * never calls task tools.
 */
import { describe, expect, it } from "vitest";
import type { ModelPort, ModelRequest, ModelResponse, ToolCall, ToolPort, ToolSpec, VerifierPort } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";
import { fallbackPlan, makePlan, parsePlan } from "../../src/harness/defaults/planning";

const readSpec: ToolSpec = { name: "read_file", description: "", inputSchema: {}, parallel: true };
const noopSpec: ToolSpec = { name: "noop", description: "", inputSchema: {} };

function fakeTools(specs: ToolSpec[] = [], output = "ok") {
	const executed: string[] = [];
	const tools: ToolPort = {
		specs: () => specs,
		execute: async (name) => {
			executed.push(name);
			return { ok: true, output };
		},
	};
	return { tools, executed };
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
			return { text: next.text ?? "", toolCalls: next.toolCalls ?? [], usage: next.usage ?? { inputTokens: 100, outputTokens: 10, cachedTokens: 0 } };
		},
	};
	return { model, requests, left: () => queue.length };
}

const call = (callId: string, name: string, input: unknown): ToolCall => ({ callId, name, input });
const acting = (...toolCalls: ToolCall[]): Partial<ModelResponse> => ({ toolCalls });
const finish = (text = "done"): Partial<ModelResponse> => ({ text, toolCalls: [] });

const PLAN_JSON = JSON.stringify({
	tasks: [
		{
			id: "t1",
			title: "Read and change",
			acceptance: { kind: "command", command: "npm test" },
			steps: [
				{ id: "s1", text: "read the files", signal: { tool: "read_file" } },
				{ id: "s2", text: "review the diff" },
			],
		},
	],
});

describe("planner", () => {
	it("parses a valid plan and coerces reviewer acceptance to none", () => {
		const plan = parsePlan(JSON.stringify({ tasks: [{ id: "A", title: "T", acceptance: { kind: "reviewer", rubric: "x" }, steps: [{ id: "s", text: "do", signal: { tool: "noop", path: "src/**" } }] }] }));
		expect(plan?.tasks).toHaveLength(1);
		expect(plan?.tasks[0]?.acceptance).toEqual({ kind: "none" });
		expect(plan?.tasks[0]?.steps[0]?.signal).toEqual({ tool: "noop", path: "src/**" });
	});

	it("returns null on garbage and clamps to the task cap", () => {
		expect(parsePlan("no json here")).toBeNull();
		// An empty tasks array is the reuse signal, not garbage.
		expect(parsePlan('{"tasks":[]}')).toEqual({ tasks: [], continueIds: [] });
		// {"continue":[...]} adopts prior tasks without minting new ones.
		expect(parsePlan('{"continue":["t2","t3"],"tasks":[]}')).toEqual({ tasks: [], continueIds: ["t2", "t3"] });
		const many = JSON.stringify({ tasks: Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, title: "x", acceptance: { kind: "none" }, steps: [{ id: "s", text: "y" }] })) });
		expect(parsePlan(many)?.tasks).toHaveLength(4);
	});

	it("makePlan falls back to a single none-acceptance task when the model fails", async () => {
		const model: ModelPort = {
			complete: async () => {
				throw new Error("provider down");
			},
		};
		const plan = await makePlan(model, "do a thing");
		expect(plan.tasks).toHaveLength(1);
		expect(plan.tasks[0]?.acceptance).toEqual({ kind: "none" });
	});

	it("fallbackPlan always produces one closable task", () => {
		const [task] = fallbackPlan("fix the bug");
		expect(task?.acceptance.kind).toBe("none");
		expect(task?.steps.length).toBeGreaterThan(0);
	});

	it("adds the read-only rules to the planner prompt when writable is false", async () => {
		const m = scripted([{ text: PLAN_JSON, toolCalls: [] }]);
		const plan = await makePlan(m.model, "explain the code", { writable: false });
		expect(plan.tasks).toHaveLength(1);
		expect(m.requests[0]?.system).toContain("READ-ONLY");
		const writableRun = scripted([{ text: PLAN_JSON, toolCalls: [] }]);
		await makePlan(writableRun.model, "fix the bug");
		expect(writableRun.requests[0]?.system).not.toContain("READ-ONLY");
	});

	it("passes the existing board to the planner and honors a reuse answer", async () => {
		const m = scripted([{ text: '{"tasks":[]}', toolCalls: [] }]);
		const plan = await makePlan(m.model, "redo the same task", { board: "Task board:\n- t1 [in_progress] Survey" });
		expect(plan.tasks).toEqual([]);
		const msg = m.requests[0]?.messages[0];
		expect(msg?.kind === "user" && msg.text).toContain("PLANS FROM EARLIER RUNS");
		// Without a board to reuse, an empty answer still falls back to a plan.
		const fresh = scripted([{ text: '{"tasks":[]}', toolCalls: [] }]);
		expect((await makePlan(fresh.model, "do a thing")).tasks).toHaveLength(1);
	});
});

describe("harness-owned board", () => {
	it("the planner writes the board before the first model turn; the model never sees task tools", async () => {
		const m = scripted([{ text: PLAN_JSON, toolCalls: [] }, acting(call("r", "read_file", { path: "a.ts" })), finish("done")]);
		const log = new MemoryEventLog(() => 1);
		const { tools } = fakeTools([readSpec]);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		const outcome = await loop.run("read a.ts and review", undefined, undefined, { plan: true });
		expect(outcome.status).toBe("completed");
		// First model call is the planner (no tools offered); the run's calls come after.
		expect(m.requests[0]?.tools).toEqual([]);
		expect(m.requests[1]?.tools.map((t) => t.name)).not.toContain("task_create");
		const events = await log.read();
		const created = events.find((e) => e.type === "task.created");
		expect(created?.type === "task.created" && created.task.id).toBe("t1");
		// Planner usage rode on the first task.created.
		expect(created?.type === "task.created" && created.usage?.inputTokens).toBe(100);
		// s1 closed on its signal with the real callId; s2 was covered by acceptance.
		const s1 = events.find((e) => e.type === "step.updated" && e.stepId === "s1" && e.to === "done");
		expect(s1?.type === "step.updated" && s1.callIds).toEqual(["r"]);
		expect(loop.projection.ledger.tasks.t1?.status).toBe("done");
	});

	it("does not plan on resume or when plan is off", async () => {
		const m = scripted([finish("done")]);
		const log = new MemoryEventLog(() => 1);
		const { tools } = fakeTools();
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		await loop.run("just chat");
		const events = await log.read();
		expect(events.some((e) => e.type === "task.created")).toBe(false);
	});

	it("remaps ids into the session id space across runs", async () => {
		const m = scripted([
			{ text: PLAN_JSON, toolCalls: [] },
			acting(call("r1", "read_file", { path: "a" })),
			finish(),
			{ text: PLAN_JSON, toolCalls: [] },
			acting(call("r2", "read_file", { path: "b" })),
			finish(),
		]);
		const log = new MemoryEventLog(() => 1);
		const { tools } = fakeTools([readSpec]);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		await loop.run("first", undefined, undefined, { plan: true });
		await loop.run("second", undefined, undefined, { plan: true });
		const ids = (await log.read()).flatMap((e) => (e.type === "task.created" ? [e.task.id] : []));
		expect(ids).toEqual(["t1", "t2"]);
	});

	it("a continuation ask never adopts a prior run's plan — new runs own only their own tasks", async () => {
		const log = new MemoryEventLog(() => 1);
		await log.append({
			type: "task.created",
			runId: "r1",
			task: {
				id: "t1",
				title: "Survey the codebase",
				acceptance: { kind: "none" },
				dependsOn: [],
				status: "pending",
				steps: [
					{ id: "s1", text: "list the tree", status: "pending", callIds: [] },
					{ id: "s2", text: "read the modules", status: "pending", callIds: [] },
				],
				evidence: [],
			},
		});
		const m = scripted([{ text: '{"continue":["t1"],"tasks":[]}', toolCalls: [] }, acting(call("x", "read_file", { path: "a" })), finish("done")]);
		const { tools } = fakeTools([readSpec]);
		const loop = new HarnessLoop({ runId: "r2", log, model: m.model, tools, verifier: pass });
		await loop.recover();
		const outcome = await loop.run("redo the same task", undefined, undefined, { plan: true });
		expect(outcome.status).toBe("completed");
		// The planner saw the earlier run's plan grouped under its run id.
		expect(m.requests[0]?.messages[0]?.kind === "user" && m.requests[0].messages[0].text).toContain("Run r1");
		const events = await log.read();
		// The prior board is context for the planner, never executable scope:
		// continue ids are ignored, t1 stays owned by r1, and the run completes
		// with an empty board of its own.
		expect(events.some((e) => e.type === "task.adopted")).toBe(false);
		expect(events.filter((e) => e.type === "task.created")).toHaveLength(1);
		expect(events.some((e) => e.type === "steer.note" && e.rule === "plan.reuse")).toBe(true);
		expect(loop.projection.ledger.tasks.t1?.runId).toBe("r1");
	});

	it("an empty planner answer never adopts earlier tasks", async () => {
		const log = new MemoryEventLog(() => 1);
		const stale = { id: "t1", title: "old run", acceptance: { kind: "none" as const }, dependsOn: [], status: "pending" as const, steps: [], evidence: [] };
		const recent = { id: "t2", title: "recent run", acceptance: { kind: "none" as const }, dependsOn: [], status: "pending" as const, steps: [], evidence: [] };
		await log.append({ type: "task.created", runId: "r1", task: stale });
		await log.append({ type: "task.created", runId: "r2", task: recent });
		const m = scripted([{ text: '{"tasks":[]}', toolCalls: [] }, finish("done")]);
		const { tools } = fakeTools([readSpec]);
		const loop = new HarnessLoop({ runId: "r3", log, model: m.model, tools, verifier: pass });
		await loop.recover();
		await loop.run("continue", undefined, undefined, { plan: true });
		const events = await log.read();
		expect(events.some((e) => e.type === "task.adopted")).toBe(false);
		expect(events.some((e) => e.type === "steer.note" && e.rule === "plan.reuse")).toBe(true);
		// Both stay owned by their own runs — neither enters r3's board.
		expect(loop.projection.ledger.tasks.t1?.runId).toBe("r1");
		expect(loop.projection.ledger.tasks.t2?.runId).toBe("r2");
	});

	it("a seeded step closes when the model cites the call that proves it", async () => {
		const m = scripted([
			acting(call("r1", "read_file", { path: "a" })),
			acting(call("d1", "task_step_update", { taskId: "t1", stepId: "s1", status: "done", callIds: ["r1"] })),
			finish("done"),
		]);
		const { tools } = fakeTools([readSpec]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		await loop.run("read a", undefined, undefined, { seed: [{ title: "Read a", steps: ["read a.ts"] }] });
		const step = loop.projection.ledger.tasks.t1?.steps[0];
		expect(step?.status).toBe("done");
		expect(step?.callIds).toEqual(["r1"]);
	});

	it("a done step the model finds wrong is failed with a reason and replaced — the replacement carries the work", async () => {
		const m = scripted([
			acting(call("r1", "read_file", { path: "a" })),
			acting(call("d1", "task_step_update", { taskId: "t1", stepId: "s1", status: "done", callIds: ["r1"] })),
			acting(call("f1", "task_step_update", { taskId: "t1", stepId: "s1", status: "failed", reason: "a was the wrong file", replacement: { id: "s3", text: "read c" } })),
			acting(call("r2", "read_file", { path: "b" })),
			acting(call("d2", "task_step_update", { taskId: "t1", stepId: "s2", status: "done", callIds: ["r2"] })),
			acting(call("r3", "read_file", { path: "c" })),
			acting(call("d3", "task_step_update", { taskId: "t1", stepId: "s3", status: "done", callIds: ["r3"] })),
			finish("done"),
		]);
		const { tools } = fakeTools([readSpec]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		await loop.run("read files", undefined, undefined, { seed: [{ title: "Read", steps: ["read a", "read b"] }] });
		const task = loop.projection.ledger.tasks.t1;
		expect(task?.steps.map((s) => [s.id, s.status])).toEqual([
			["s1", "failed"],
			["s2", "done"],
			["s3", "done"],
		]);
		expect(task?.steps[0]?.reason).toBe("a was the wrong file");
		expect(task?.status).toBe("done");
	});

	it("a done step gets the successful calls since it started attached — the model never copies ids", async () => {
		const m = scripted([acting(call("r1", "read_file", { path: "a" })), acting(call("d1", "task_step_update", { taskId: "t1", stepId: "s1", status: "done" })), finish("done")]);
		const { tools } = fakeTools([readSpec]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		await loop.run("read a", undefined, undefined, { seed: [{ title: "Read a", steps: ["read a.ts"] }] });
		expect(loop.projection.ledger.tasks.t1?.steps[0]).toMatchObject({ status: "done", callIds: ["r1"] });
	});

	it("a done step with no successful call since it started is refused until the work is done", async () => {
		const m = scripted([
			acting(call("d0", "task_step_update", { taskId: "t1", stepId: "s1", status: "done" })),
			acting(call("r1", "read_file", { path: "a" })),
			acting(call("d1", "task_step_update", { taskId: "t1", stepId: "s1", status: "done" })),
			finish("done"),
		]);
		const { tools } = fakeTools([readSpec]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		await loop.run("read a", undefined, undefined, { seed: [{ title: "Read a", steps: ["read a.ts"] }] });
		const refusal = (await log.read()).find((e) => e.type === "tool.finished" && e.callId === "d0");
		expect(refusal?.type === "tool.finished" && refusal.ok).toBe(false);
		expect(loop.projection.ledger.tasks.t1?.steps[0]).toMatchObject({ status: "done", callIds: ["r1"] });
	});

	it("work done while an earlier step is open proves the next step too — the window is the task's", async () => {
		const m = scripted([
			acting(call("r1", "read_file", { path: "a" }), call("r2", "read_file", { path: "b" })),
			acting(call("d1", "task_step_update", { taskId: "t1", stepId: "s1", status: "done" })),
			acting(call("d2", "task_step_update", { taskId: "t1", stepId: "s2", status: "done" })),
			finish("done"),
		]);
		const { tools } = fakeTools([readSpec]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		await loop.run("read a and b", undefined, undefined, { seed: [{ title: "Read", steps: ["read a", "read b"] }] });
		const steps = loop.projection.ledger.tasks.t1?.steps ?? [];
		expect(steps.map((s) => [s.status, s.callIds])).toEqual([
			["done", ["r1", "r2"]],
			["done", ["r1", "r2"]],
		]);
	});

	it("a signaled step that activates after its proof ran closes on that earlier call", async () => {
		const PLAN = JSON.stringify({
			tasks: [
				{
					id: "t1",
					title: "Two reads",
					acceptance: { kind: "none" },
					steps: [
						{ id: "s1", text: "read a", signal: { tool: "read_file", path: "a" } },
						{ id: "s2", text: "read b", signal: { tool: "read_file", path: "b" } },
					],
				},
			],
		});
		const m = scripted([
			{ text: PLAN, toolCalls: [] },
			acting(call("r1", "read_file", { path: "b" })),
			acting(call("r2", "read_file", { path: "a" })),
			finish("done"),
		]);
		const { tools } = fakeTools([readSpec]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		await loop.run("read a and b", undefined, undefined, { plan: true });
		const steps = loop.projection.ledger.tasks.t1?.steps ?? [];
		expect(steps.map((s) => [s.status, s.callIds])).toEqual([
			["done", ["r2"]],
			["done", ["r1"]],
		]);
	});

	it("the model's own check run never counts — the harness runs its check once for the task", async () => {
		let checks = 0;
		const verifier: VerifierPort = { check: async () => (checks++, { ok: true, detail: "passed" }) };
		const m = scripted([
			acting(call("c1", "run_command", { command: "npm run typecheck" })),
			acting(call("d1", "task_step_update", { taskId: "t1", stepId: "s1", status: "done" })),
			acting(call("u1", "task_update", { id: "t1", status: "done" })),
			finish("done"),
		]);
		const { tools } = fakeTools([{ name: "run_command", description: "", inputSchema: {} }]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier });
		await loop.run("check it", undefined, undefined, { seed: [{ title: "Check", steps: ["run the check"], acceptance: { kind: "command", command: "npm run typecheck" } }] });
		expect(checks).toBe(1);
		expect(loop.projection.ledger.tasks.t1?.status).toBe("done");
	});

	it("a check that passed earlier in the run proves a later task's acceptance, whenever it ran", async () => {
		let checks = 0;
		const verifier: VerifierPort = { check: async () => (checks++, { ok: true, detail: "passed" }) };
		const PLAN = JSON.stringify({
			tasks: [
				{ id: "A", title: "First", acceptance: { kind: "none" }, dependsOn: [], steps: [{ id: "s1", text: "check it" }] },
				{ id: "B", title: "Second", acceptance: { kind: "command", command: "npm run typecheck" }, dependsOn: ["A"], steps: [{ id: "s1", text: "read it" }] },
			],
		});
		const m = scripted([
			{ text: PLAN, toolCalls: [] },
			acting(call("c1", "run_command", { command: "npm run typecheck" })),
			acting(call("d1", "task_step_update", { taskId: "t1", stepId: "s1", status: "done" })),
			acting(call("r2", "read_file", { path: "a" })),
			acting(call("d2", "task_step_update", { taskId: "t2", stepId: "s1", status: "done" })),
			finish("done"),
		]);
		const { tools } = fakeTools([readSpec, { name: "run_command", description: "", inputSchema: {} }]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier });
		await loop.run("two tasks", undefined, undefined, { plan: true });
		expect(loop.projection.ledger.tasks.t2?.status).toBe("done");
		expect(checks).toBe(1);
	});

	it("a harness check that ran after the last write proves a later task's acceptance too", async () => {
		let checks = 0;
		const verifier: VerifierPort = { check: async () => (checks++, { ok: true, detail: "passed" }) };
		const PLAN = JSON.stringify({
			tasks: [
				{ id: "A", title: "Write", acceptance: { kind: "command", command: "npm run typecheck" }, dependsOn: [], steps: [{ id: "s1", text: "write it" }] },
				{ id: "B", title: "Write again", acceptance: { kind: "command", command: "npm run typecheck" }, dependsOn: ["A"], steps: [{ id: "s1", text: "write again" }] },
			],
		});
		const m = scripted([
			{ text: PLAN, toolCalls: [] },
			acting(call("w1", "write_file", { path: "a.txt", content: "x" })),
			acting(call("d1", "task_step_update", { taskId: "t1", stepId: "s1", status: "done" })),
			acting(call("w2", "write_file", { path: "a.txt", content: "y" })),
			acting(call("d2", "task_step_update", { taskId: "t2", stepId: "s1", status: "done" })),
			finish("done"),
		]);
		const { tools } = fakeTools([{ name: "write_file", description: "", inputSchema: {} }]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier });
		await loop.run("write twice", undefined, undefined, { plan: true });
		expect(checks).toBe(1);
		expect(loop.projection.ledger.tasks.t2?.status).toBe("done");
	});

	it("plan seeds carry plain step text — completion is the model's to prove, not inferred from prose", async () => {
		const { parsePlanSeed } = await import("../../src/harness/planning/planSeed");
		const seed = parsePlanSeed("# Plan: X\n\n## Steps\n1. Review `src/harness/loop.ts` for regressions\n2. Run `npx vitest run test/harness`\n");
		expect(seed?.steps).toEqual(["Review `src/harness/loop.ts` for regressions", "Run `npx vitest run test/harness`"]);
	});

	it("an implement plan seeds its steps and verify gate, or refuses — never a planner fallback", async () => {
		const { planSeedTasks } = await import("../../src/harness/planning/planSeed");
		const ok = planSeedTasks("plans/x.md", "# Plan: X\n\n## Steps\n1. Edit `src/a.ts` to add the flag\n\n## Verification\n- `npm run check`\n");
		expect("seed" in ok && ok.seed[0]).toEqual({
			title: "Implement plan: X",
			steps: ["Edit `src/a.ts` to add the flag"],
			acceptance: { kind: "command", command: "npm run check" },
		});
		const bad = planSeedTasks("plans/y.md", "# Plan: Y\n\nJust some prose, no steps.\n");
		expect("error" in bad && bad.error).toContain("plans/y.md has no numbered steps");
	});

	it("a search_files pattern hits a filename-glob signal — brace globs included", async () => {
		const SEARCH_PLAN = JSON.stringify({
			tasks: [
				{
					id: "t1",
					title: "Find manifests",
					acceptance: { kind: "none" },
					steps: [{ id: "s1", text: "locate build manifests", signal: { tool: "search_files", path: "**/{package.json,Cargo.toml}" } }],
				},
			],
		});
		const m = scripted([
			{ text: SEARCH_PLAN, toolCalls: [] },
			acting(call("s", "search_files", { pattern: "package\\.json|Cargo\\.toml" })),
			finish(),
		]);
		const log = new MemoryEventLog(() => 1);
		const { tools } = fakeTools([{ name: "search_files", description: "", inputSchema: {}, parallel: true }]);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass });
		const outcome = await loop.run("find the build manifests", undefined, undefined, { plan: true });
		expect(outcome.status).toBe("completed");
		const done = (await log.read()).find((e) => e.type === "step.updated" && e.stepId === "s1" && e.to === "done");
		expect(done?.type === "step.updated" && done.callIds).toEqual(["s"]);
	});

	it("signals on tools the run cannot call don't block close-out", async () => {
		// A planner task carries an explore_codebase signal this run doesn't
		// offer — the signal is stripped and the step resolves via acceptance.
		const PLAN = JSON.stringify({
			tasks: [
				{
					id: "t1",
					title: "Survey",
					acceptance: { kind: "none" },
					steps: [{ id: "s1", text: "explore src", signal: { tool: "explore_codebase", path: "src/**" } }],
				},
			],
		});
		const m = scripted([{ text: PLAN, toolCalls: [] }, acting(call("x", "read_file", { path: "src/a.ts" })), finish("done")]);
		const { tools } = fakeTools([readSpec]); // no explore_codebase offered
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "r2", log, model: m.model, tools, verifier: pass });
		const outcome = await loop.run("survey the code", undefined, undefined, { plan: true });
		expect(outcome.status).toBe("completed");
		expect(loop.projection.ledger.tasks.t1?.status).toBe("done");
	});

	it("a saved-plan answer short-circuits the board — no adoption, no new tasks", async () => {
		const log = new MemoryEventLog(() => 1);
		await log.append({ type: "task.created", runId: "r1", task: { id: "t1", title: "old plan", acceptance: { kind: "none" }, dependsOn: [], status: "pending", steps: [{ id: "s1", text: "x", status: "pending", callIds: [] }], evidence: [] } });
		const m = scripted([{ text: '{"reuse_plan":"codebase-explanation"}', toolCalls: [] }, acting(call("p", "read_plan", { slug: "codebase-explanation" })), finish("here is the existing answer")]);
		const planSpec: ToolSpec = { name: "list_plans", description: "", inputSchema: {} };
		const { tools } = fakeTools([readSpec, planSpec], "codebase-explanation");
		const loop = new HarnessLoop({ runId: "r2", log, model: m.model, tools, verifier: pass });
		await loop.recover();
		const outcome = await loop.run("explain the codebase again", undefined, undefined, { plan: true });
		expect(outcome.status).toBe("completed");
		const events = await log.read();
		// Saved-plan slugs were offered to the planner.
		expect(m.requests[0]?.messages[0]?.kind === "user" && m.requests[0].messages[0].text).toContain("codebase-explanation");
		expect(events.some((e) => e.type === "task.adopted")).toBe(false);
		expect(events.some((e) => e.type === "steer.note" && e.text.includes("codebase-explanation"))).toBe(true);
		// t1 stays r1's — the run answered from the artifact.
		expect(loop.projection.ledger.tasks.t1?.runId).toBe("r1");
	});

	it("boardOf surfaces the adopting task's origin run", async () => {
		const { boardOf } = await import("../../src/harness/core/runner");
		const log = new MemoryEventLog(() => 1);
		await log.append({ type: "task.created", runId: "r1", task: { id: "t1", title: "x", acceptance: { kind: "none" }, dependsOn: [], status: "pending", steps: [], evidence: [] } });
		await log.append({ type: "task.adopted", id: "t1", runId: "r2" });
		const { project } = await import("../../src/harness/core/projections");
		const board = boardOf(project(await log.read()), "r2");
		expect(board[0]?.from).toBe("r1");
	});

	it("coerces command acceptance to none in read-only runs", async () => {
		const m = scripted([{ text: PLAN_JSON, toolCalls: [] }, acting(call("r", "read_file", { path: "a.ts" })), finish("done")]);
		const log = new MemoryEventLog(() => 1);
		const { tools } = fakeTools([readSpec]);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: pass, writable: false });
		const outcome = await loop.run("explain a.ts", undefined, undefined, { plan: true });
		expect(outcome.status).toBe("completed");
		const created = (await log.read()).find((e) => e.type === "task.created");
		expect(created?.type === "task.created" && created.task.acceptance).toEqual({ kind: "none" });
	});

	it("marks a task blocked when its acceptance can never pass, then finishes", async () => {
		const DEP_PLAN = JSON.stringify({
			tasks: [
				{ id: "t1", title: "Write a doc", acceptance: { kind: "command", command: "test -s DOC.md" }, steps: [{ id: "s1", text: "write the doc" }] },
				{ id: "t2", title: "Review it", acceptance: { kind: "none" }, dependsOn: ["t1"], steps: [{ id: "s1", text: "check the doc" }] },
			],
		});
		const fail: VerifierPort = { check: async () => ({ ok: false, detail: "file missing" }) };
		// Two finishes: the first refusal lets the model retry, the second close-out blocks t1 (and cascades to t2).
		const m = scripted([{ text: DEP_PLAN, toolCalls: [] }, finish("can't write"), finish("blocked")]);
		const log = new MemoryEventLog(() => 1);
		const { tools } = fakeTools([readSpec]);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools, verifier: fail, writable: true });
		const outcome = await loop.run("write and review", undefined, undefined, { plan: true });
		expect(outcome.status).toBe("completed");
		const events = await log.read();
		const t1Blocked = events.find((e) => e.type === "task.updated" && e.id === "t1" && e.to === "blocked");
		expect(t1Blocked?.type === "task.updated" && t1Blocked.reason).toContain("acceptance");
		const t2Blocked = events.find((e) => e.type === "task.updated" && e.id === "t2" && e.to === "blocked");
		expect(t2Blocked?.type === "task.updated" && t2Blocked.reason).toContain("dependency t1");
		expect(events.some((e) => e.type === "steer.note" && e.rule === "finish.blocked")).toBe(true);
		expect(loop.projection.ledger.tasks.t1?.status).toBe("blocked");
		expect(loop.projection.ledger.tasks.t2?.status).toBe("blocked");
	});

	it("a read_files batch satisfies a read_file signal", async () => {
		const m = scripted([
			{ text: PLAN_JSON, toolCalls: [] },
			acting(call("rb", "read_files", { files: [{ path: "a.ts" }, { path: "b.ts" }] })),
			finish(),
		]);
		const log = new MemoryEventLog(() => 1);
		const base = fakeTools([{ name: "read_file", description: "", inputSchema: {}, parallel: true }]);
		const { withBatchReads } = await import("../../src/harness/tools/batchReads");
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools: withBatchReads(base.tools), verifier: pass });
		const outcome = await loop.run("read both", undefined, undefined, { plan: true });
		expect(outcome.status).toBe("completed");
		const s1 = (await log.read()).find((e) => e.type === "step.updated" && e.stepId === "s1" && e.to === "done");
		expect(s1?.type === "step.updated" && s1.callIds).toEqual(["rb"]);
	});
});

describe("reads.batch steering", () => {
	it("nudges the model to batch after repeated single-read turns", async () => {
		const readCalls = [1, 2, 3, 4].map((i) => acting(call(`r${i}`, "read_file", { path: `f${i}` })));
		const m = scripted([...readCalls, finish("done")]);
		const log = new MemoryEventLog(() => 1);
		const { tools } = fakeTools([readSpec]);
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools });
		await loop.run("read files");
		const notes = (await log.read()).filter((e) => e.type === "steer.note");
		expect(notes.some((e) => e.type === "steer.note" && /read_files|batch/i.test(e.text))).toBe(true);
	});
});

describe("usage accounting", () => {
	it("counts tool-reported usage (subagent spend) against the session counters", async () => {
		const m = scripted([acting(call("e", "noop", {})), finish()]);
		const log = new MemoryEventLog(() => 1);
		const tools: ToolPort = {
			specs: () => [noopSpec],
			execute: async () => ({ ok: true, output: "summary", usage: { inputTokens: 500, outputTokens: 50, cachedTokens: 0 } }),
		};
		const loop = new HarnessLoop({ runId: "r", log, model: m.model, tools });
		await loop.run("go");
		// Two model calls at 100 input tokens each + 500 from the tool's nested spend.
		expect(loop.projection.counters.inputTokens).toBe(700);
	});
});

describe("boardOf attribution", () => {
	it("emits step callIds so the UI can nest calls under steps", async () => {
		const { boardOf } = await import("../../src/harness/core/runner");
		const { project } = await import("../../src/harness/core/projections");
		const log = new MemoryEventLog(() => 1);
		await log.append({
			type: "task.created",
			runId: "r1",
			task: {
				id: "t1",
				title: "plan",
				acceptance: { kind: "none" },
				dependsOn: [],
				status: "pending",
				steps: [
					{ id: "s1", text: "explore", status: "pending", callIds: [] },
					{ id: "s2", text: "implement", status: "pending", callIds: [] },
				],
				evidence: [],
			},
		});
		await log.append({ type: "task.updated", runId: "r1", id: "t1", to: "in_progress" });
		await log.append({ type: "tool.finished", runId: "r1", callId: "c1", name: "read_file", ok: true, output: "ok" });
		await log.append({ type: "tool.finished", runId: "r1", callId: "c2", name: "read_file", ok: true, output: "ok" });
		await log.append({ type: "step.updated", runId: "r1", taskId: "t1", stepId: "s1", to: "in_progress", callIds: [] });
		await log.append({ type: "step.updated", runId: "r1", taskId: "t1", stepId: "s1", to: "done", callIds: ["c1", "c2"] });
		await log.append({ type: "step.updated", runId: "r1", taskId: "t1", stepId: "s2", to: "in_progress", callIds: [] });
		const board = boardOf(project(await log.read()), "r1");
		expect(board[0]?.steps[0]).toMatchObject({ id: "s1", callIds: ["c1", "c2"] });
		expect(board[0]?.steps[1]).toMatchObject({ id: "s2", callIds: [] });
	});
});
