import { describe, expect, it } from "vitest";
import type { RunEvent } from "../web/lib/types";
import {
	buildTimeline,
	group,
	groupWorked,
	normText,
	summaryTexts,
	toolLabel,
	toolDetail,
	toolMeta,
	toolPath,
	toolTarget,
	turnMergeable,
	workedStats,
	type ActionItem,
	type EventItem,
	type Item,
	type StreamItem,
	type TurnItem,
} from "../web/lib/timelineModel";

let seq = 0;
function ev(type: string, event: Record<string, unknown> = {}, runId = "r1", at?: string): RunEvent {
	return { runId, seq: seq++, at: at ?? new Date(2025, 0, 1, 0, 0, seq).toISOString(), event: { type, ...event } };
}
const types = (items: Item[]) => items.map((i) => (i.kind === "event" ? i.e.event.type : i.kind));
const actions = (items: Item[]) => items.filter((i): i is ActionItem => i.kind === "action");
const streams = (items: Item[]) => items.filter((i): i is StreamItem => i.kind === "stream");
const events = (items: Item[]) => items.filter((i): i is EventItem => i.kind === "event");

/** Fixture mirroring the real cloud session: deltas, durable records, paired tools, file-changed, lifecycle, summary. */
function fixture(): RunEvent[] {
	seq = 0;
	const out: RunEvent[] = [];
	out.push(ev("run-started", { task: "fix the flaky test" }));
	out.push(ev("agent-message", { text: "durable user msg" }));
	out.push(ev("cloud-status", { status: "cloning" }));
	out.push(ev("info", { text: "preflight ok" }));
	out.push(ev("check", { command: "preflight:node", ok: true, output: "ok" }));
	out.push(ev("check", { command: "npm test", ok: true, output: "12 passed" }));
	out.push(ev("memory", { items: [{}, {}] }));
	// iteration 1: reasoning + narration + read + edit
	out.push(ev("reasoning-delta", { text: "The test flakes because " }));
	out.push(ev("reasoning-delta", { text: "of a race." }));
	out.push(ev("assistant-delta", { text: "I'll look at the test file." }));
	out.push(ev("assistant-text", { text: "I'll look at the test file." }));
	out.push(ev("tool-started", { id: "t1", name: "read_file", input: { path: "src/foo.test.ts" } }));
	out.push(ev("tool-finished", { id: "t1", name: "read_file", ok: true, output: "...", durationMs: 120 }));
	out.push(ev("tool-started", { id: "t2", name: "edit_file", input: { path: "src/foo.test.ts" } }));
	out.push(ev("file-changed", { path: "src/foo.test.ts", diff: "@@ -1 +1 @@\n-a\n+b", added: 4, removed: 1 }));
	out.push(ev("tool-finished", { id: "t2", name: "edit_file", ok: true, output: "done", durationMs: 300 }));
	// iteration 2: command + orphan finish + failed check
	out.push(ev("assistant-delta", { text: "Now run the tests." }));
	out.push(ev("tool-started", { id: "t3", name: "run_command", input: { command: "npm test" } }));
	out.push(ev("tool-output-delta", { text: "running..." }));
	out.push(ev("tool-finished", { id: "t3", name: "run_command", ok: true, output: "ok", durationMs: 5000 }));
	out.push(ev("tool-finished", { id: "orphan", name: "mystery_tool", ok: false, output: "boom" }));
	out.push(ev("tool-started", { id: "t4", name: "run_command", input: { command: "deploy --prod" } }));
	out.push(ev("tool-finished", { id: "t4", name: "run_command", ok: false, output: "denied", durationMs: 50 }));
	out.push(ev("check", { command: "npm run lint", ok: false, output: "lint errors" }));
	// final reply == run summary → must be hidden
	const summary = "Fixed the flaky test by awaiting the promise.";
	out.push(ev("assistant-delta", { text: summary }));
	out.push(ev("assistant-text", { text: summary }));
	out.push(ev("agent-message", { text: "durable reply" }));
	out.push(ev("run-finished", { text: summary }));
	out.push(ev("run-completed", { summary, pushed: true }));
	out.push(ev("usage", { tokens: 100 }));
	return out;
}

describe("buildTimeline", () => {
	it("folds deltas into single stream items per lane", () => {
		const items = buildTimeline(fixture());
		const st = streams(items);
		// reasoning stream + 2 assistant streams (iter-1 note, iter-2 note) — final reply hidden
		const reasoning = st.filter((s) => s.streamKind === "reasoning");
		const assistant = st.filter((s) => s.streamKind === "assistant");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0].text).toBe("The test flakes because of a race.");
		expect(reasoning[0].done).toBe(true);
		expect(assistant.map((s) => s.text)).toEqual([
			"I'll look at the test file.",
			"Now run the tests.",
		]);
	});

	it("hides durable-only and lifecycle records", () => {
		const ts = types(buildTimeline(fixture()));
		for (const hidden of ["agent-message", "cloud-status", "info", "preflight"]) {
			expect(ts).not.toContain(hidden);
		}
		// passed checks hidden; failed check + memory stay
		expect(events(buildTimeline(fixture())).map((i) => i.e.event.type)).not.toContain("check-ok");
		const evs = events(buildTimeline(fixture())).map((i) => `${i.e.event.type}:${i.e.event.ok}`);
		expect(evs).toContain("check:false");
		expect(evs).toContain("memory:undefined");
	});

	it("pairs tool-started/finished into one action and merges file-changed", () => {
		const items = buildTimeline(fixture());
		const acts = actions(items);
		expect(acts.map((a) => a.name)).toEqual(["read_file", "edit_file", "run_command", "run_command"]);
		const edit = acts[1];
		expect(edit.output).toBe("done");
		expect(edit.ok).toBe(true);
		expect(edit.durationMs).toBe(300);
		expect(edit.diff).toContain("@@");
		expect(edit.added).toBe(4);
		expect(edit.removed).toBe(1);
		// orphan tool-finished survives as a one-line event
		const orphan = events(items).find((i) => i.e.event.type === "tool-finished");
		expect(orphan?.e.event.name).toBe("mystery_tool");
		// run_command picked up the streamed output
		expect(acts[2].liveOutput).toBe("running...");
	});

	it("hides the final assistant reply that duplicates the run summary", () => {
		const items = buildTimeline(fixture());
		const st = streams(items).filter((s) => s.streamKind === "assistant");
		expect(st.some((s) => s.text.startsWith("Fixed the flaky"))).toBe(false);
		// but the summary texts are still detectable for other runs
		const sums = summaryTexts(fixture());
		expect(sums.get("r1")).toBe(normText("Fixed the flaky test by awaiting the promise."));
	});

	it("keeps the reply when it differs from the summary", () => {
		const evs = fixture().filter((e) => e.event.type !== "assistant-text" && !(e.event.type === "assistant-delta" && String(e.event.text).startsWith("Fixed the flaky")));
		evs.push(ev("assistant-text", { text: "All done — different wording." }));
		evs.push(ev("run-finished", { text: "Fixed the flaky test by awaiting the promise." }));
		const st = streams(buildTimeline(evs)).filter((s) => s.streamKind === "assistant");
		expect(st.some((s) => s.text === "All done — different wording." && !s.hidden)).toBe(true);
	});

	it("keeps streamed reasoning as one Thoughts item when usage lands before the final reasoning event", () => {
		seq = 0;
		const evs = [
			ev("reasoning-delta", { text: "Checking\n" }),
			ev("reasoning-delta", { text: "the flaky test." }),
			ev("usage", { inputTokens: 10, outputTokens: 5 }),
			ev("reasoning", { text: "Checking the flaky test.", iteration: 1 }),
			ev("tool-started", { id: "t1", name: "read_file", input: { path: "a.ts" } }),
		];
		const reasoning = streams(buildTimeline(evs)).filter((s) => s.streamKind === "reasoning");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0].text).toBe("Checking the flaky test.");
	});

	it("dedupes repeated reasoning that differs only in whitespace", () => {
		seq = 0;
		const evs = [
			ev("reasoning", { text: "Plan:\n  read the file", iteration: 1 }),
			ev("tool-started", { id: "t1", name: "read_file", input: { path: "a.ts" } }),
			ev("tool-finished", { id: "t1", name: "read_file", ok: true, output: "1| x", durationMs: 1 }),
			ev("reasoning", { text: "Plan: read the file", iteration: 2 }),
		];
		expect(streams(buildTimeline(evs)).filter((s) => s.streamKind === "reasoning")).toHaveLength(1);
	});

	it("keeps distinct reasoning from different iterations", () => {
		seq = 0;
		const evs = [
			ev("reasoning", { text: "Plan: read the file", iteration: 1 }),
			ev("tool-started", { id: "t1", name: "read_file", input: { path: "a.ts" } }),
			ev("tool-finished", { id: "t1", name: "read_file", ok: true, output: "1| x", durationMs: 1 }),
			ev("reasoning", { text: "Next: edit the file", iteration: 2 }),
		];
		expect(streams(buildTimeline(evs)).filter((s) => s.streamKind === "reasoning")).toHaveLength(2);
	});
});

describe("group / groupWorked", () => {
	it("groups streams+actions into turns and merges contiguous done turns", () => {
		const grouped = group(buildTimeline(fixture()));
		const turns = grouped.filter((i): i is TurnItem => i.kind === "turn");
		expect(turns.length).toBeGreaterThanOrEqual(2);
		expect(turns.every((t) => t.done)).toBe(true);
		const worked = groupWorked(grouped);
		const w = worked.find((i) => i.kind === "worked");
		expect(w).toBeDefined();
		if (w?.kind === "worked") {
			const stats = workedStats(w.turns);
			expect(stats.actions).toBe(3);
			expect(stats.files).toBe(1);
			expect(stats.added).toBe(4);
			expect(stats.fails).toBe(0);
		}
	});

	it("does not merge turns containing failures or the final reply", () => {
		const grouped = group(buildTimeline(fixture()));
		const turns = grouped.filter((i): i is TurnItem => i.kind === "turn");
		const failed = turns.find((t) => t.items.some((i) => i.kind === "action" && i.ok === false));
		expect(failed).toBeDefined();
		expect(turnMergeable(failed!)).toBe(false);
	});

	it("unwraps stream-only turns so replies render outside worked blocks", () => {
		seq = 0;
		const evs = [
			ev("assistant-text", { text: "Just chatting." }),
			ev("assistant-text", { text: "Still chatting." }),
		];
		const worked = groupWorked(group(buildTimeline(evs)));
		expect(worked.every((i) => i.kind === "stream")).toBe(true);
		expect(worked).toHaveLength(2);
	});
});

describe("tool labels", () => {
	it("produces concise verb + target labels", () => {
		const read = { kind: "action" as const, name: "read_file", input: { path: "src/store.ts" }, key: "k", output: "x" };
		expect(toolLabel(read)).toBe("Read store.ts");
		expect(toolTarget(read)).toBe("store.ts");
		expect(toolMeta("read_file").verb).toBe("Read");
		const cmd = { kind: "action" as const, name: "run_command", input: { command: "npm test" }, key: "k2", output: "ok" };
		expect(toolTarget(cmd)).toBe("npm test");
		expect(toolMeta("mcp_github_create_issue").icon).toBe("🔌");
	});

	it("shows full paths and result summaries for file tools", () => {
		const read = { kind: "action" as const, name: "read_file", input: { path: "src/ui/agentsPanel.ts" }, key: "r", output: "1| a\n2| b\n3| c" };
		expect(toolPath(read)).toBe("src/ui/agentsPanel.ts");
		expect(toolDetail(read)).toBe("3 lines");
		const list = { kind: "action" as const, name: "list_files", input: { path: "." }, key: "l", output: "src/\nREADME.md\n" };
		expect(toolPath(list)).toBe("repo root");
		expect(toolDetail(list)).toBe("2 entries");
		const search = { kind: "action" as const, name: "search_files", input: { pattern: "foo" }, key: "s", output: "a.ts:3: foo\nb.ts:9: foo" };
		expect(toolDetail(search)).toBe("2 matches");
		const cmd = { kind: "action" as const, name: "run_command", input: { command: "npm test" }, key: "c", output: "ok" };
		expect(toolPath(cmd)).toBeUndefined();
		expect(toolDetail(cmd)).toBe("");
	});
});
