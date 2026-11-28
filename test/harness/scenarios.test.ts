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

async function run(opts: { steps: Array<Partial<ModelResponse>>; verifier?: VerifierPort; toolPort?: ToolPort; limits?: Partial<HarnessLimits>; onSteerAsk?: (q: string) => Promise<boolean> }) {
	const m = scripted(opts.steps);
	const log = new MemoryEventLog(() => 1);
	const loop = new HarnessLoop({ runId: "scenario", log, model: m.model, tools: opts.toolPort ?? tools(), verifier: opts.verifier, limits: opts.limits, onSteerAsk: opts.onSteerAsk });
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
		// End-of-run closeout is a later context boundary, so inspect the projection just before it.
		const events = await r.log.read();
		const closeoutAt = events.findIndex((e) => e.type === "context.closeout");
		expect(project(events.slice(0, closeoutAt)).strikes).toBe(3);
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
		// No frozen pause: the open task is honestly marked blocked and the run ends.
		expect(r.loop.projection.ledger.tasks.a?.status).toBe("blocked");
		expect(r.outcome.status).not.toBe("paused");
	});
});

describe("scenario: ask_user tool", () => {
	it("intercepts ask_user, logs structured questions, and pauses without executing", async () => {
		const r = await run({
			steps: [
				acting(call("q1", "ask_user", { questions: [
					{ question: "Which formula should estimation use?", options: ["threads = ceil(bytes/64MB)", "fixed 4 threads"] },
					{ question: "Should config live in Config.java?" },
				] })),
				finish("unreachable"),
			],
		});
		expect(r.outcome.status).toBe("paused");
		expect(r.outcome.reason).toBe("question");
		const events = await r.log.read();
		const ask = events.find((e) => e.type === "user.question");
		expect(ask?.type === "user.question" && ask.questions).toEqual([
			{ question: "Which formula should estimation use?", options: ["threads = ceil(bytes/64MB)", "fixed 4 threads"] },
			{ question: "Should config live in Config.java?" },
		]);
		// the call "finished" without any execution — it is a pause, not a tool run
		const fin = events.find((e) => e.type === "tool.finished" && e.callId === "q1");
		expect(fin?.type === "tool.finished" && fin.output).toMatch(/paused until the user answers/);
	});

	it("refuses a malformed ask_user call and lets the model retry", async () => {
		const r = await run({
			steps: [
				acting(call("q1", "ask_user", { questions: [] })),
				acting(call("q2", "ask_user", { questions: [{ question: "proceed?" }] })),
			],
		});
		expect(r.outcome.status).toBe("paused");
		const events = await r.log.read();
		const bad = events.find((e) => e.type === "tool.finished" && e.callId === "q1");
		expect(bad?.type === "tool.finished" && bad.ok).toBe(false);
		expect(events.some((e) => e.type === "user.question")).toBe(true);
	});
});

describe("scenario: non-offered tool calls", () => {
	it("refuses a hallucinated tool with the available alternates, never executing it", async () => {
		const r = await run({
			steps: [acting(call("x1", "str_replace", { path: "a" })), finish("done")],
		});
		const events = await r.log.read();
		const fin = events.find((e) => e.type === "tool.finished" && e.callId === "x1");
		expect(fin?.type === "tool.finished" && fin.ok).toBe(false);
		expect(fin?.type === "tool.finished" && fin.output).toMatch(/never offered/);
		expect(fin?.type === "tool.finished" && fin.output).toMatch(/noop/);
	});
});

describe("scenario: open-tasks ask", () => {
	it("continue resets the refusal window; decline ends with tasks blocked", async () => {
		// decline — no user willing to continue: blocked, not frozen
		const r1 = await run({ limits: { maxRefusals: 0 }, steps: [acting(createTask("a", ["x"])), finish()] });
		expect(r1.loop.projection.ledger.tasks.a?.status).toBe("blocked");
		expect(r1.outcome.status).not.toBe("paused");
		// continue — the window resets and the model gets another chance. The first
		// finish hits the open task and fires the ask; the model then closes the work.
		const r2 = await run({
			verifier: pass,
			limits: { maxRefusals: 0 },
			onSteerAsk: async () => true,
			steps: [
				acting(createTask("a", ["x"])),
				finish("nothing yet"),
				acting(call("w", "noop", { x: 1 })),
				acting(call("s1", "task_step_update", { taskId: "a", stepId: "s1", status: "in_progress", callIds: [] })),
				acting(call("s2", "task_step_update", { taskId: "a", stepId: "s1", status: "done", callIds: ["w"] })),
				acting(call("t1", "task_update", { id: "a", status: "in_progress" })),
				acting(call("t2", "task_update", { id: "a", status: "done" })),
				finish(),
			],
		});
		expect(r2.loop.projection.ledger.tasks.a?.status).toBe("done");
	});
});

describe("scenario: acceptance integrity", () => {
	it("rejects trivially-passing acceptance — the task_replace gaming vector", async () => {
		const r = await run({
			steps: [
				acting(call("c1", "task_create", { id: "a", title: "a", acceptance: { kind: "command", command: "echo ok" }, steps: [{ id: "s1", text: "work" }] })),
				finish(),
			],
		});
		const events = await r.log.read();
		const fin = events.find((e) => e.type === "tool.finished" && e.callId === "c1");
		expect(fin?.type === "tool.finished" && fin.ok).toBe(false);
		expect(fin?.type === "tool.finished" && fin.output).toMatch(/never verifies/);
		expect(events.some((e) => e.type === "task.created")).toBe(false);
	});

	it("rejects impossible quiet-grep acceptance with guidance toward bare commands", async () => {
		const r = await run({
			steps: [
				acting(call("c1", "task_create", { id: "a", title: "a", acceptance: { kind: "command", command: "mvn test -q 2>&1 | grep -c 'Tests run:'" }, steps: [{ id: "s1", text: "work" }] })),
				finish(),
			],
		});
		const events = await r.log.read();
		const fin = events.find((e) => e.type === "tool.finished" && e.callId === "c1");
		expect(fin?.type === "tool.finished" && fin.ok).toBe(false);
		expect(fin?.type === "tool.finished" && fin.output).toMatch(/quiet/);
	});

	it("accepts bare build commands — the exit code is the check", async () => {
		const r = await run({
			verifier: pass,
			steps: [
				acting(call("c1", "task_create", { id: "a", title: "a", acceptance: { kind: "command", command: "mvn test" }, steps: [{ id: "s1", text: "work" }] })),
				finish(),
			],
		});
		const events = await r.log.read();
		expect(events.some((e) => e.type === "task.created")).toBe(true);
	});
});

describe("scenario: user questions", () => {
	it("pauses instead of refusing when the model ends its turn asking the user", async () => {
		const r = await run({
			steps: [acting(createTask("a", ["x"])), finish("The plan diverges from the code in three ways. Update the doc first, or proceed without updating?")],
		});
		expect(r.outcome.status).toBe("paused");
		const events = await r.log.read();
		expect(events.some((e) => e.type === "stop.refused")).toBe(false);
		expect(events.some((e) => e.type === "run.status" && e.status === "paused" && e.reason === "question")).toBe(true);
		// The board is left untouched — nothing force-closed or stalled while waiting.
		expect(r.loop.projection.ledger.tasks.a?.status).not.toBe("done");
		expect(r.loop.projection.ledger.tasks.a?.status).not.toBe("blocked");
	});

	it("still refuses a premature finish that is not a question", async () => {
		const r = await run({
			steps: [acting(createTask("a", ["x"])), finish("I am done."), acting(call("w", "noop", { x: 1 })), finish("done now")],
		});
		const events = await r.log.read();
		expect(events.some((e) => e.type === "stop.refused")).toBe(true);
	});
});

describe("scenario: plan document grounding", () => {
	it("never feeds a plan document to the planner — doc runs are seeded deterministically upstream", async () => {
		const m = scripted([
			// First call is the planner: answer with a one-step board.
			{ text: '{"tasks":[{"id":"t1","title":"cli","acceptance":{"kind":"none"},"dependsOn":[],"steps":[{"id":"s1","text":"parse args"}]}]}', toolCalls: [] },
			acting(call("w", "noop", { x: 1 })),
			finish("done"),
		]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "scenario", log, model: m.model, tools: tools(), verifier: pass });
		await loop.run("lets build as per plans/development-plan.md", undefined, undefined, { plan: true });
		const plannerText = m.requests[0]!.messages.map((msg) => (msg.kind === "user" ? msg.text : "")).join("\n");
		// Seeded document runs never reach the planner at all; a free-form run that
		// happens to mention a .md path must not have its scope hijacked either.
		expect(plannerText).not.toContain("PLAN DOCUMENT");
	});

	it("plans without a doc block when the task references no document", async () => {
		const m = scripted([
			{ text: '{"tasks":[{"id":"t1","title":"x","acceptance":{"kind":"none"},"dependsOn":[],"steps":[{"id":"s1","text":"x"}]}]}', toolCalls: [] },
			acting(call("w", "noop", { x: 1 })),
			finish("done"),
		]);
		const log = new MemoryEventLog(() => 1);
		const loop = new HarnessLoop({ runId: "scenario", log, model: m.model, tools: tools(), verifier: pass });
		await loop.run("fix the flaky test", undefined, undefined, { plan: true });
		const text = m.requests[0]!.messages.map((msg) => (msg.kind === "user" ? msg.text : "")).join("\n");
		expect(text).not.toContain("PLAN DOCUMENT");
	});
});
