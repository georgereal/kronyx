import { describe, expect, it } from "vitest";
import type { RunViewEvent } from "../../src/agent/runner";
import type { SessionEvent } from "../../src/harness/contracts";
import { toViewEvents } from "../../src/harness/runner";

const meta = { at: 1, runId: "r" };
const tracker = () => ({ turn: 0, runStart: 0, lastText: "", starts: new Map<string, number>(), usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } });
const map = (e: SessionEvent) => toViewEvents(e, tracker(), 50) as RunViewEvent[];
const mapDebug = (e: SessionEvent) => toViewEvents(e, tracker(), 50, true) as RunViewEvent[];

describe("harness event to run-view mapping", () => {
	it("maps a paused run to a stopped finish with a resume hint", () => {
		const out = map({ ...meta, seq: 1, type: "run.status", status: "paused", reason: "open_tasks" });
		expect(out).toEqual([{ type: "run-finished", status: "stopped", text: "Paused (open_tasks). Send a message to continue.", iterations: 0 }]);
	});

	it("maps a failed run to run-failed with classification", () => {
		const out = map({ ...meta, seq: 2, type: "run.status", status: "failed", reason: "rate limit exceeded" });
		expect(out[0]).toMatchObject({ type: "run-failed", error: "rate limit exceeded", errorKind: "rate_limit", retryable: true });
	});

	it("maps a loop warning and a refused finish to visible info lines", () => {
		expect(map({ ...meta, seq: 3, type: "loop.verdict", level: "warn", fingerprint: "x", reason: "repeat" })).toEqual([{ type: "info", text: "Loop control: warn (repeat)" }]);
		expect(map({ ...meta, seq: 4, type: "stop.refused", openTaskIds: ["a"] })[0]).toMatchObject({ type: "info" });
	});

	it("keeps quiet loop verdicts out of the timeline", () => {
		expect(map({ ...meta, seq: 5, type: "loop.verdict", level: "none", fingerprint: "x" })).toEqual([]);
	});

	it("maps a verifier result to a check line", () => {
		expect(map({ ...meta, seq: 6, type: "verifier.result", taskId: "a", ok: false, detail: "suite red" })[0]).toMatchObject({ type: "check", ok: false, output: "suite red" });
	});

	it("shows the steer rule id only in debug mode", () => {
		const e = { ...meta, seq: 7, type: "steer.note", rule: "reads.wander", text: "Still exploring." } as SessionEvent;
		expect(map(e)[0]).toMatchObject({ type: "info", text: "Still exploring." });
		expect(mapDebug(e)[0]).toMatchObject({ type: "info", text: "[reads.wander] Still exploring.", meta: { kind: "harness", rule: "reads.wander" } });
	});

	it("emits a per-turn token line only in debug mode", () => {
		const e = {
			...meta,
			seq: 8,
			type: "model.response",
			turn: 3,
			text: "",
			toolCalls: [{ callId: "c", name: "read_file", input: {} }],
			usage: { inputTokens: 45_000, outputTokens: 900, cachedTokens: 0 },
		} as SessionEvent;
		expect(map(e).some((v) => v.type === "info")).toBe(false);
		expect(mapDebug(e).at(-1)).toMatchObject({ type: "info", text: "turn 3 — 45.0K in / 900 out · 1 call", meta: { kind: "harness" } });
	});

	it("surfaces recaps and clears only in debug mode", () => {
		const recap = { ...meta, seq: 9, type: "context.recap", covers: 8, text: "brief" } as SessionEvent;
		const cleared = { ...meta, seq: 10, type: "context.cleared" } as SessionEvent;
		expect(map(recap)).toEqual([]);
		expect(map(cleared)).toEqual([]);
		expect(mapDebug(recap)[0]).toMatchObject({ type: "info", text: "recap covered 8 messages" });
		expect(mapDebug(cleared)[0]).toMatchObject({ type: "info", text: "context cleared" });
	});
});
