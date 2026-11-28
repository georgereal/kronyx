import { describe, expect, it } from "vitest";
import type { RunViewEvent } from "../../src/agent/runner";
import type { SessionEvent } from "../../src/harness/core/contracts";
import { toViewEvents } from "../../src/harness/core/runner";

const meta = { at: 1, runId: "r" };
const tracker = () => ({ turn: 0, runStart: 0, lastText: "", starts: new Map<string, number>(), usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, taskTitles: new Map<string, string>(), blocked: [] as string[] });
const map = (e: SessionEvent) => toViewEvents(e, tracker(), 50) as RunViewEvent[];
const mapDebug = (e: SessionEvent) => toViewEvents(e, tracker(), 50, true) as RunViewEvent[];

describe("harness event to run-view mapping", () => {
	it("maps a paused run to a paused finish with a resume hint", () => {
		const out = map({ ...meta, seq: 1, type: "run.status", status: "paused", reason: "open_tasks" });
		expect(out).toEqual([{ type: "run-finished", status: "paused", text: "Paused (open_tasks). Send a message to continue.", iterations: 0 }]);
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

	it("surfaces recaps and clears as info lines", () => {
		const recap = { ...meta, seq: 9, type: "context.recap", covers: 8, text: "brief" } as SessionEvent;
		const cleared = { ...meta, seq: 10, type: "context.cleared" } as SessionEvent;
		expect(map(recap)[0]).toMatchObject({ type: "info", text: "Context compacted — recap covers the first 8 messages." });
		expect(map(cleared)[0]).toMatchObject({ type: "info", text: "context cleared" });
	});
});

describe("completion suggestions", () => {
	it("extracts the fenced suggestions block and strips it from the summary", async () => {
		const { extractSuggestions } = await import("../../src/harness/core/runner");
		const text = "All six phases are done.\n\n```suggestions\n[\"Add the estimation formula\", \"Export results to CSV\"]\n```\n";
		const out = extractSuggestions(text);
		expect(out.suggestions).toEqual(["Add the estimation formula", "Export results to CSV"]);
		expect(out.text).toBe("All six phases are done.");
	});

	it("ignores malformed or absent blocks without touching the text", async () => {
		const { extractSuggestions } = await import("../../src/harness/core/runner");
		expect(extractSuggestions("plain summary").suggestions).toEqual([]);
		expect(extractSuggestions("summary\n```suggestions\nnot json\n```\n").suggestions).toEqual([]);
		expect(extractSuggestions("summary\n```suggestions\nnot json\n```\n").text).toContain("summary");
	});

	it("a completed run carries model suggestions in run-finished", () => {
		const t = tracker();
		t.lastText = "Work done.\n```suggestions\n[\"commit it\"]\n```\n";
		const out = toViewEvents({ ...meta, seq: 3, type: "run.status", status: "completed" }, t, 50) as RunViewEvent[];
		expect(out[0]).toMatchObject({ type: "run-finished", status: "completed", text: "Work done.", suggestions: ["commit it"] });
	});

	it("blocked tasks become deterministic suggestions even without a model block", () => {
		const t = tracker();
		toViewEvents({ ...meta, seq: 1, type: "task.created", task: { id: "t1", title: "wire the exporter", acceptance: { kind: "none" }, dependsOn: [], status: "pending", steps: [], callIds: [], evidence: [] } as never }, t, 50);
		toViewEvents({ ...meta, seq: 2, type: "task.updated", id: "t1", to: "blocked" }, t, 50);
		t.lastText = "Ended early.";
		const out = toViewEvents({ ...meta, seq: 3, type: "run.status", status: "completed" }, t, 50) as RunViewEvent[];
		expect((out[0] as { suggestions?: string[] }).suggestions).toEqual(["Finish the blocked work: wire the exporter"]);
	});
});
