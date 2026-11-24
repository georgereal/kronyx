import { describe, expect, it } from "vitest";
import type { EventBody, SessionEvent, Task } from "../../src/harness/contracts";
import { buildHarnessReport, REPORT_INTERVENTION_CAP } from "../../src/harness/report";

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
