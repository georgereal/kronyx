import { describe, expect, it } from "vitest";
import { buildRefIndex, buildRefMatcher, scanUnknownRefTokens } from "../../src/harness/core/refIndex";
import { applyLedgerEvent, emptyLedger, type Ledger } from "../../src/harness/core/taskLedger";
import type { Task } from "../../src/harness/core/contracts";

const task = (id: string, title: string, steps: { id: string; text: string }[] = [], runId?: string): Task => ({
	id, title, acceptance: { kind: "command", command: "npm test" }, dependsOn: [], status: "pending",
	steps: steps.map((s) => ({ id: s.id, text: s.text, status: "pending" as const, callIds: [] })),
	evidence: [], ...(runId === undefined ? {} : { runId }),
});
const ledgerWith = (...tasks: Task[]): Ledger => tasks.reduce((l, t) => applyLedgerEvent(l, { type: "task.created", task: t }), emptyLedger());

describe("buildRefIndex", () => {
	it("maps tasks and steps to their entities with run scoping", () => {
		const ledger = ledgerWith(task("t1", "Assess repo", [{ id: "s1", text: "Survey layout" }], "r1"));
		const index = buildRefIndex(ledger, "r1");
		expect(index.entries.get("t1")).toMatchObject({ kind: "task", title: "Assess repo", runId: "r1" });
		expect(index.entries.get("s1")).toMatchObject({ kind: "step", taskId: "t1", title: "Survey layout" });
		expect(index.currentRunIds.has("t1")).toBe(true);
	});

	it("accepts any id shape — hierarchical, lettered, mixed", () => {
		const ledger = ledgerWith(task("t6-s2", "Verify & harden packaging", [{ id: "s3a", text: "Multi-sheet" }]));
		const index = buildRefIndex(ledger);
		expect(index.entries.has("t6-s2")).toBe(true);
		expect(index.entries.has("s3a")).toBe(true);
	});
});

describe("buildRefMatcher", () => {
	it("returns null for an empty board", () => {
		expect(buildRefMatcher(buildRefIndex(emptyLedger()))).toBeNull();
	});

	it("matches hierarchical ids whole — never truncates to the prefix", () => {
		const ledger = ledgerWith(task("t6-s2", "Packaging"), task("t6-s3", "CLI flags"));
		const re = buildRefMatcher(buildRefIndex(ledger))!;
		const matches = "closing t6-s2 then starting t6-s3".match(re);
		expect(matches).toEqual(["t6-s2", "t6-s3"]);
	});

	it("t1 never matches inside t11 or t6-s2", () => {
		const ledger = ledgerWith(task("t1", "One"), task("t11", "Eleven"), task("t6-s2", "Nested"));
		const re = buildRefMatcher(buildRefIndex(ledger))!;
		const text = "t1 and t11 and t6-s2";
		const matches = text.match(re)!;
		expect(matches).toEqual(["t1", "t11", "t6-s2"]);
		expect(matches).not.toContain("t6");
	});

	it("does not match tokens absent from the map", () => {
		const ledger = ledgerWith(task("t1", "One"));
		const re = buildRefMatcher(buildRefIndex(ledger))!;
		expect("the t9 phantom and s3 bucket".match(re)).toBeNull();
		expect("t1 is real".match(re)).toEqual(["t1"]);
	});

	it("longest-first ordering wins over position", () => {
		const ledger = ledgerWith(task("t6", "Short"), task("t6-s2", "Long"));
		const re = buildRefMatcher(buildRefIndex(ledger))!;
		expect("see t6-s2 here".match(re)).toEqual(["t6-s2"]);
		expect("see t6 here".match(re)).toEqual(["t6"]);
	});
});

describe("scanUnknownRefTokens", () => {
	const ledger = ledgerWith(task("t1", "One", [{ id: "s1", text: "first" }]), task("t2", "Two"), task("t3", "Three"));
	const index = buildRefIndex(ledger);

	it("flags id-shaped tokens missing from the index", () => {
		expect(scanUnknownRefTokens("closing t9 next, then s7", index)).toEqual(["s7", "t9"]);
	});

	it("passes real ids — tasks and steps", () => {
		expect(scanUnknownRefTokens("t1 done, s1 next, t2 after", index)).toEqual([]);
	});

	it("catches braced phantom refs but ignores braced prose", () => {
		expect(scanUnknownRefTokens("the {t9} step and {author} field", index)).toEqual(["t9"]);
	});

	it("ignores id shapes inside fenced code and inline code", () => {
		expect(scanUnknownRefTokens("run it:\n```\nt9 --flag\n```\nand `s7` inline, but t9 in prose", index)).toEqual(["t9"]);
	});

	it("accepts case variants of real ids", () => {
		expect(scanUnknownRefTokens("T1 and S1 uppercase", index)).toEqual([]);
	});

	it("returns empty for an empty board", () => {
		expect(scanUnknownRefTokens("t9 anything", buildRefIndex(emptyLedger()))).toEqual([]);
	});
});

describe("id token validation", () => {
	it("rejects whitespace-bearing task ids at creation", async () => {
		const { parseTaskCreateInput } = await import("../../src/harness/core/taskLedger");
		expect(() => parseTaskCreateInput({
			id: "task one", title: "x", acceptance: { kind: "none" }, steps: [],
		})).toThrow(/single tokens/);
	});

	it("rejects whitespace-bearing step ids at creation", async () => {
		const { parseTaskCreateInput } = await import("../../src/harness/core/taskLedger");
		expect(() => parseTaskCreateInput({
			id: "t1", title: "x", acceptance: { kind: "none" }, steps: [{ id: "step 1", text: "y" }],
		})).toThrow(/single tokens/);
	});

	it("accepts hierarchical and lettered ids — shape is not constrained", async () => {
		const { parseTaskCreateInput } = await import("../../src/harness/core/taskLedger");
		const parsed = parseTaskCreateInput({
			id: "t6-s2", title: "x", acceptance: { kind: "none" }, steps: [{ id: "s3a", text: "y" }],
		});
		expect(parsed.id).toBe("t6-s2");
		expect(parsed.steps[0].id).toBe("s3a");
	});
});
