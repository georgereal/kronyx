import { describe, expect, it } from "vitest";
import type { EventBody, SessionEvent, Task } from "../../src/harness/core/contracts";
import { buildHarnessReport, REPORT_INTERVENTION_CAP } from "../../src/harness/report/report";

/** Stamps bodies into a contiguous session log. */
function log(bodies: EventBody[], runId = "run-1"): SessionEvent[] {
	return bodies.map((body, i) => ({ ...body, seq: i + 1, at: 1000 + i, runId }) as SessionEvent);
}

const task: Task = {
	id: "t1",
	title: "Do the thing",
	acceptance: { kind: "command", command: "npm test" },
	dependsOn: [] as string[],
	status: "pending" as const,
	steps: [
		{ id: "s1", text: "read files", status: "pending" as const, callIds: [], signal: { tool: "read_file" } },
		{ id: "s2", text: "verify", status: "pending" as const, callIds: [] },
	],
	evidence: [] as string[],
};

const usage = { inputTokens: 100, outputTokens: 20, cachedTokens: 5 };

describe("buildHarnessReport", () => {
	it("summarizes board, interventions, context and execution", () => {
		const events = log([
			{ type: "user.input", text: "fix it" },
			{ type: "task.created", task, usage },
			{ type: "model.response", turn: 1, text: "", toolCalls: [{ callId: "c1", name: "read_file", input: { path: "a.ts" } }], usage },
			{ type: "tool.requested", callId: "c1", name: "read_file", input: { path: "a.ts" } },
			{ type: "tool.finished", callId: "c1", name: "read_file", ok: true, output: "...", usage: { inputTokens: 500, outputTokens: 10, cachedTokens: 0 } },
			{ type: "step.updated", taskId: "t1", stepId: "s1", to: "in_progress", callIds: [] },
			{ type: "step.updated", taskId: "t1", stepId: "s1", to: "done", callIds: ["c1"] },
			{ type: "steer.note", rule: "reads.batch", text: "Batch independent reads with read_files." },
			{ type: "model.response", turn: 2, text: "done", toolCalls: [], usage },
			{ type: "task.updated", id: "t1", to: "in_progress" },
			{ type: "verifier.result", taskId: "t1", ok: true, detail: "npm test passed" },
			{ type: "step.updated", taskId: "t1", stepId: "s2", to: "in_progress", callIds: [] },
			{ type: "step.updated", taskId: "t1", stepId: "s2", to: "done", callIds: [] },
			{ type: "task.updated", id: "t1", to: "done" },
			{ type: "run.status", status: "completed" },
		]);
		const report = buildHarnessReport(events, { now: () => 42 });

		expect(report.generatedAt).toBe(42);
		expect(report.board.tasks).toHaveLength(1);
		const t = report.board.tasks[0]!;
		expect(t.status).toBe("done");
		expect(t.steps[0]?.evidence).toEqual(["c1"]);
		expect(t.steps[0]?.signal).toEqual({ tool: "read_file" });

		expect(report.interventions.map((i) => i.kind)).toEqual(["steer", "verifier", "status"]);
		expect(report.interventions[0]).toMatchObject({ seq: 8, runId: "run-1", label: "reads.batch" });

		// Tokens: model 2×100 + planner 100 + tools 500 + recap 0.
		expect(report.context.tokens.input).toBe(800);
		expect(report.context.bySource).toEqual({ model: 200, planner: 100, tools: 500, recap: 0 });
		expect(report.context.turns).toBe(2);
		expect(report.context.toolCalls).toBe(1);

		expect(report.execution.stepsSignalDone).toBe(1);
		expect(report.execution.stepsCoveredAtCloseout).toBe(1);
		expect(report.execution.readFileCalls).toBe(1);
		expect(report.execution.tools).toEqual([{ name: "read_file", calls: 1, failures: 0 }]);
		expect(report.execution.exploreTurns).toBe(1);
		expect(report.execution.maxReadOnlyStreak).toBe(1);

		expect(report.runs).toHaveLength(1);
		expect(report.runs[0]).toMatchObject({ runId: "run-1", status: "completed", turns: 2, toolCalls: 1, tasksCreated: 1 });
	});

	it("extracts divergence episodes with harness/model attribution", () => {
		const divTask: Task = {
			id: "x1",
			title: "Unplanned work — starting with edit_file unrelated.ts",
			acceptance: { kind: "none" },
			dependsOn: [],
			status: "pending",
			steps: [],
			evidence: [],
			origin: "divergence",
		};
		const events = log([
			{ type: "user.input", text: "fix it" },
			{ type: "task.created", task, usage },
			// A harness refusal shortly before the episode — makes it harness-triggered.
			{ type: "tool.requested", callId: "c0", name: "task_step_update", input: { taskId: "t1", stepId: "s1", status: "done", callIds: [] } },
			{ type: "tool.finished", callId: "c0", name: "task_step_update", ok: false, output: "Refused by step.grounding: No successful tool call has proven this step" },
			// Episode opens; two off-plan writes; then the on-plan write closes it.
			{ type: "task.created", task: divTask },
			{ type: "task.updated", id: "x1", to: "in_progress" },
			{ type: "tool.requested", callId: "w1", name: "edit_file", input: { path: "unrelated.ts" } },
			{ type: "tool.finished", callId: "w1", name: "edit_file", ok: true, output: "ok" },
			{ type: "tool.requested", callId: "w2", name: "edit_file", input: { path: "other.ts" } },
			{ type: "tool.finished", callId: "w2", name: "edit_file", ok: true, output: "ok" },
			{ type: "tool.requested", callId: "w3", name: "write_file", input: { path: "pom.xml" } },
			{ type: "tool.finished", callId: "w3", name: "write_file", ok: true, output: "ok" },
			{ type: "verifier.result", taskId: "x1", ok: true, detail: "no acceptance check" },
			{ type: "task.updated", id: "x1", to: "done" },
			{ type: "run.status", status: "completed" },
		]);
		const report = buildHarnessReport(events, { now: () => 42 });

		expect(report.divergence).toHaveLength(1);
		const ep = report.divergence[0]!;
		expect(ep.id).toBe("x1");
		expect(ep.status).toBe("done");
		// The closing on-plan write (w3) is excluded — only the two off-plan edits count.
		expect(ep.calls.map((c) => c.name)).toEqual(["edit_file", "edit_file"]);
		expect(ep.cause).toBe("harness");
		expect(ep.causeDetail).toContain("refusal");
		expect(report.divergenceSummary).toEqual({ episodes: 1, harnessCaused: 1, modelCaused: 0, calls: 2 });
		// The board carries the origin marker.
		expect(report.board.tasks.find((t) => t.id === "x1")?.origin).toBe("divergence");
	});

	it("attributes divergence with no preceding harness intervention to the model, and leaves open episodes in_progress", () => {
		const divTask: Task = {
			id: "x1",
			title: "Unplanned work",
			acceptance: { kind: "none" },
			dependsOn: [],
			status: "pending",
			steps: [],
			evidence: [],
			origin: "divergence",
		};
		const events = log([
			{ type: "user.input", text: "fix it" },
			{ type: "task.created", task, usage },
			{ type: "task.created", task: divTask },
			{ type: "task.updated", id: "x1", to: "in_progress" },
			{ type: "tool.requested", callId: "w1", name: "edit_file", input: { path: "unrelated.ts" } },
			{ type: "tool.finished", callId: "w1", name: "edit_file", ok: true, output: "ok" },
			{ type: "run.status", status: "paused", reason: "max_turns" },
		]);
		const report = buildHarnessReport(events, { now: () => 42 });
		const ep = report.divergence[0]!;
		expect(ep.status).toBe("in_progress");
		expect(ep.endedAt).toBeUndefined();
		expect(ep.cause).toBe("model");
		expect(ep.calls).toHaveLength(1);
	});

	it("tracks read-only streaks across model turns", () => {
		const readTurn = (turn: number, name = "read_file") =>
			({ type: "model.response", turn, text: "", toolCalls: [{ callId: `c${turn}`, name, input: {} }], usage }) as EventBody;
		const events = log([
			readTurn(1, "search_files"),
			readTurn(2, "read_file"),
			readTurn(3, "explore_codebase"),
			readTurn(4, "write_file"), // breaks the streak
			readTurn(5, "read_file"),
			readTurn(6, "read_file"),
			{ type: "model.response", turn: 7, text: "done", toolCalls: [], usage }, // no calls — breaks too
			readTurn(8, "read_file"),
		]);
		const report = buildHarnessReport(events);
		expect(report.execution.exploreTurns).toBe(6);
		expect(report.execution.maxReadOnlyStreak).toBe(3);
		expect(report.runs[0]?.tasksCreated).toBe(0);
	});

	it("scopes stats and board to a runId across a multi-run log", () => {
		const events = [
			...log(
				[
					{ type: "task.created", task, usage },
					{ type: "model.response", turn: 1, text: "", toolCalls: [], usage },
					{ type: "run.status", status: "completed" },
				],
				"run-a",
			),
			...log(
				[
					{ type: "steer.note", rule: "reads.batch", text: "batch!" },
					{ type: "model.response", turn: 1, text: "", toolCalls: [], usage: { inputTokens: 50, outputTokens: 5, cachedTokens: 0 } },
					{ type: "run.status", status: "paused", reason: "limit" },
				],
				"run-b",
			).map((e) => ({ ...e, seq: e.seq + 3 })),
		];
		// Fix seqs to be contiguous across the concatenation.
		events.forEach((e, i) => (e.seq = i + 1));

		const whole = buildHarnessReport(events);
		expect(whole.runs.map((r) => r.runId)).toEqual(["run-a", "run-b"]);
		expect(whole.context.turns).toBe(2);
		// run-a completed status + run-b steer + run-b paused status.
		expect(whole.interventions.map((i) => i.kind)).toEqual(["status", "steer", "status"]);

		const scoped = buildHarnessReport(events, { runId: "run-b" });
		expect(scoped.context.turns).toBe(1);
		expect(scoped.context.tokens.input).toBe(50);
		expect(scoped.interventions.map((i) => i.kind)).toEqual(["steer", "status"]);
		// Board snapshot at run-b's end still holds run-a's task; runs lists all runs for the picker.
		expect(scoped.board.tasks[0]?.id).toBe("t1");
		expect(scoped.runs.map((r) => r.runId)).toEqual(["run-a", "run-b"]);
		expect(scoped.runs[1]?.status).toBe("paused");
	});

	it("caps the intervention list and reports the omitted count", () => {
		const bodies: EventBody[] = Array.from({ length: REPORT_INTERVENTION_CAP + 5 }, (_, i) => ({
			type: "steer.note",
			rule: `rule-${i}`,
			text: "x".repeat(400),
		}));
		const report = buildHarnessReport(log(bodies));
		expect(report.interventions).toHaveLength(REPORT_INTERVENTION_CAP);
		expect(report.interventionsOmitted).toBe(5);
		expect(report.interventions[0]?.detail?.length).toBeLessThanOrEqual(301);
	});

	it("returns an empty report for an empty log", () => {
		const report = buildHarnessReport([]);
		expect(report.runs).toEqual([]);
		expect(report.board.tasks).toEqual([]);
		expect(report.interventions).toEqual([]);
		expect(report.context.tokens.input).toBe(0);
	});
});

describe("dashboard extraction — turns, executions, events, analytics", () => {
	const taskEvent = (seq: number) => ({
		type: "task.created" as const,
		task: { id: "t1", title: "T", status: "pending" as const, acceptance: { kind: "none" as const }, dependsOn: [], steps: [{ id: "s1", text: "s", status: "pending" as const, evidence: [], callIds: [] }] },
		runId: "r1",
		seq,
		at: seq * 100,
	});

	it("extracts turn details with provider items", async () => {
		const { buildHarnessReport } = await import("../../src/harness/report/report");
		const events = [
			{ type: "run.status", status: "running", runId: "r1", seq: 1, at: 100 },
			taskEvent(2),
			{
				type: "model.response", turn: 1, text: "hi", toolCalls: [], runId: "r1", seq: 3, at: 300,
				usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 5 },
				providerItems: { providerId: "p", modelId: "m", items: [{ type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "think" }] }, { type: "message", id: "msg_1" }] },
			},
		] as never[];
		const r = buildHarnessReport(events);
		expect(r.turns).toHaveLength(1);
		expect(r.turns[0]).toMatchObject({ turn: 1, providerId: "p", modelId: "m", messageId: "msg_1", reasoningId: "rs_1" });
		expect(r.turns[0].usage).toMatchObject({ input: 100 });
		expect(r.turns[0].reasoning).toContain("think");
		expect(r.events.length).toBe(3);
	});

	it("extracts execution details with exit codes", async () => {
		const { buildHarnessReport } = await import("../../src/harness/report/report");
		const events = [
			{ type: "run.status", status: "running", runId: "r1", seq: 1, at: 100 },
			taskEvent(2),
			{ type: "step.updated", taskId: "t1", stepId: "s1", to: "in_progress", callIds: [], runId: "r1", seq: 3, at: 300 },
			{ type: "tool.requested", callId: "c1", name: "run_command", input: { command: "cd /x && make" }, runId: "r1", seq: 4, at: 400 },
			{ type: "tool.finished", callId: "c1", name: "run_command", ok: true, output: "exit 0\nbuilt", runId: "r1", seq: 5, at: 5400 },
		] as never[];
		const r = buildHarnessReport(events);
		expect(r.executions).toHaveLength(1);
		expect(r.executions[0]).toMatchObject({ tool: "run_command", exitCode: 0, cwd: "/x", durationMs: 5000, ok: true });
	});

	it("aggregates cross-run analytics with friction buckets", async () => {
		const { buildHarnessReport, buildHarnessAnalytics } = await import("../../src/harness/report/report");
		const events = [
			{ type: "run.status", status: "running", runId: "r1", seq: 1, at: 100 },
			taskEvent(2),
			{ type: "step.updated", taskId: "t1", stepId: "s1", to: "in_progress", callIds: [], runId: "r1", seq: 3, at: 300 },
			{ type: "tool.requested", callId: "c1", name: "task_step_update", input: { taskId: "t1", stepId: "s1" }, runId: "r1", seq: 4, at: 400 },
			{ type: "tool.finished", callId: "c1", name: "task_step_update", ok: false, output: "Refused by step.grounding: No successful tool call has proven this step", runId: "r1", seq: 5, at: 500 },
		] as never[];
		const report = buildHarnessReport(events);
		const a = buildHarnessAnalytics([{ report, session: "s1" }]);
		expect(a.runs).toBe(1);
		expect(a.friction[0]?.reason).toContain("grounding refusal");
		expect(a.perRun[0]?.failedCloses).toBe(1);
	});
});
