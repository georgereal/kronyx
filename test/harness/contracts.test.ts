import { describe, expect, it } from "vitest";
import { DEFAULT_LOOP_DETECTOR, parseLoopDetectorConfig, parseSessionEvent, parseTask, SchemaError, type SessionEvent } from "../../src/harness/core/contracts";

const meta = { seq: 1, at: 1_700_000_000_000, runId: "run-1" };
const task = { id: "t1", title: "Add parser", acceptance: { kind: "command", command: "npm test" }, dependsOn: [], status: "pending", steps: [{ id: "s1", text: "write it", status: "pending", callIds: [] }], evidence: [] };

const samples: Array<Record<string, unknown>> = [
	{ type: "user.input", text: "hi" },
	{ type: "model.response", turn: 1, text: "ok", toolCalls: [{ callId: "c1", name: "task_create", input: { id: "t1" } }], usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 4 } },
	{ type: "model.response", turn: 2, text: "", toolCalls: [] },
	{ type: "tool.requested", callId: "c1", name: "read_file", input: { path: "a.ts" } },
	{ type: "tool.finished", callId: "c1", name: "read_file", ok: false, output: "missing" },
	{ type: "task.created", task },
	{ type: "task.updated", id: "t1", to: "in_progress", reason: "started" },
	{ type: "task.removed", id: "t1" },
	{ type: "verifier.result", taskId: "t1", ok: true, detail: "suite green" },
	{ type: "stop.refused", openTaskIds: ["t1"] },
	{ type: "budget.warning", kind: "input_tokens", used: 800, limit: 1000 },
	{ type: "run.status", status: "paused", reason: "max_turns" },
	{ type: "step.added", taskId: "t1", step: { id: "s2", text: "test it", status: "pending", callIds: [] } },
	{ type: "step.updated", taskId: "t1", stepId: "s1", to: "done", callIds: ["c1"] },
	{ type: "steer.note", rule: "loop.warn", text: "try something else" },
	{ type: "loop.verdict", level: "warn", fingerprint: "read_file:{}", reason: "repeat" },
];

describe("session event contract", () => {
	it.each(samples.map((s) => [s.type, s] as const))("round-trips %s through JSON", (_type, body) => {
		const event = { ...body, ...meta } as SessionEvent;
		const parsed = parseSessionEvent(JSON.parse(JSON.stringify(event)));
		expect(parsed).toEqual(event);
	});

	it("rejects an unknown event type", () => {
		expect(() => parseSessionEvent({ ...meta, type: "something.else" })).toThrow(SchemaError);
	});

	it("rejects a missing field with its path", () => {
		expect(() => parseSessionEvent({ ...meta, type: "tool.finished", callId: "c1", name: "x", output: "" })).toThrow(/event\.ok/);
	});

	it("rejects a task status outside the allowed set", () => {
		expect(() => parseTask({ ...task, status: "finished" })).toThrow(/status/);
	});

	it("rejects a sequence number below 1", () => {
		expect(() => parseSessionEvent({ ...meta, seq: 0, type: "user.input", text: "x" })).toThrow(/seq/);
	});

	it("rejects a budget warning for an unknown kind", () => {
		expect(() => parseSessionEvent({ ...meta, type: "budget.warning", kind: "money", used: 1, limit: 2 })).toThrow(/kind/);
	});
});

describe("loop detector config", () => {
	it("accepts the defaults", () => {
		expect(parseLoopDetectorConfig(DEFAULT_LOOP_DETECTOR)).toEqual(DEFAULT_LOOP_DETECTOR);
	});

	it("rejects an alternation threshold that cannot fit in the window", () => {
		expect(() => parseLoopDetectorConfig({ ...DEFAULT_LOOP_DETECTOR, window: 4, alternationThreshold: 3 })).toThrow(/window/);
	});
});
