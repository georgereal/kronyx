import { describe, expect, it } from "vitest";
import type { HookRule } from "../../src/harness/contracts";
import { emptyLedger } from "../../src/harness/taskLedger";
import { builtinRules, SteeringError, SteeringRegistry, type SteerContext } from "../../src/harness/steering";

const beforeTool = (call = { callId: "c", name: "read", input: {} }): SteerContext["beforeTool"] => ({ call, ledger: emptyLedger(), outcomes: {} });
const rule = (id: string, order: number, decide: () => unknown): HookRule<unknown> => ({ id, point: "beforeTool", order, decide: decide as HookRule<unknown>["decide"] });

describe("steering registry", () => {
	it("runs rules in order and keeps every note", async () => {
		const reg = new SteeringRegistry();
		reg.add("beforeTool", rule("second", 20, () => ({ kind: "note", text: "b" })));
		reg.add("beforeTool", rule("first", 10, () => ({ kind: "note", text: "a" })));
		const result = await reg.run("beforeTool", beforeTool());
		expect(result.verdict).toEqual({ kind: "allow" });
		expect(result.notes).toEqual([
			{ rule: "first", text: "a" },
			{ rule: "second", text: "b" },
		]);
	});

	it("lets deny override ask and allow regardless of order", async () => {
		const reg = new SteeringRegistry();
		reg.add("beforeTool", rule("asks", 1, () => ({ kind: "ask", question: "ok?" })));
		reg.add("beforeTool", rule("denies", 9, () => ({ kind: "deny", reason: "no" })));
		reg.add("beforeTool", rule("allows", 0, () => ({ kind: "allow" })));
		const result = await reg.run("beforeTool", beforeTool());
		expect(result.verdict).toEqual({ kind: "deny", rule: "denies", reason: "no" });
	});

	it("treats ask as the verdict when nothing denies", async () => {
		const reg = new SteeringRegistry();
		reg.add("beforeTool", rule("asks", 1, () => ({ kind: "ask", question: "run it?" })));
		expect((await reg.run("beforeTool", beforeTool())).verdict).toEqual({ kind: "ask", rule: "asks", question: "run it?" });
	});

	it("only runs rules registered at the requested point", async () => {
		const reg = new SteeringRegistry();
		reg.add("onStop", rule("elsewhere", 0, () => ({ kind: "deny", reason: "never" })));
		expect((await reg.run("beforeTool", beforeTool())).verdict).toEqual({ kind: "allow" });
	});

	it("wraps a throwing rule in SteeringError naming the rule", async () => {
		const reg = new SteeringRegistry();
		reg.add("beforeTool", rule("broken", 0, () => {
			throw new Error("boom");
		}));
		const err = await reg.run("beforeTool", beforeTool()).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SteeringError);
		expect((err as SteeringError).message).toMatch(/broken.*boom/);
	});

	it("rejects a duplicate rule id and can unregister a rule", async () => {
		const reg = new SteeringRegistry();
		const off = reg.add("beforeTool", rule("once", 0, () => ({ kind: "allow" })));
		expect(() => reg.add("beforeTool", rule("once", 1, () => ({ kind: "allow" })))).toThrow(/already registered/);
		off();
		expect(reg.ids("beforeTool")).toEqual([]);
	});
});

describe("reads.batch-force", () => {
	const pair = () => {
		const rules = builtinRules();
		const det = rules.find((r) => r.rule.id === "reads.batch")!.rule as HookRule<SteerContext["beforeModel"]>;
		const enf = rules.find((r) => r.rule.id === "reads.batch-force")!.rule as HookRule<SteerContext["beforeTool"]>;
		return { det, enf };
	};
	const mctx = (turns: string[][]): SteerContext["beforeModel"] => ({ turn: turns.length, ledger: emptyLedger(), recentTurns: turns.map((calls) => ({ calls })) });
	const tctx = (name: string): SteerContext["beforeTool"] => ({ call: { callId: "c", name, input: {} }, ledger: emptyLedger(), outcomes: {} });
	const loneReads = (n: number) => Array.from({ length: n }, () => ["read_file"]);

	it("denies lone read_file calls once the streak is armed, disarms when it breaks", async () => {
		const { det, enf } = pair();
		await det.decide(mctx(loneReads(9)));
		expect(await enf.decide(tctx("read_file"))).toEqual({ kind: "allow" });
		await det.decide(mctx(loneReads(10)));
		const denied = await enf.decide(tctx("read_file"));
		expect(denied).toMatchObject({ kind: "deny" });
		expect(denied.kind === "deny" && denied.reason).toContain("read_files");
		// Batched reads and non-read calls pass through.
		expect(await enf.decide(tctx("read_files"))).toEqual({ kind: "allow" });
		expect(await enf.decide(tctx("write_file"))).toEqual({ kind: "allow" });
		// A multi-call turn breaks the streak and disarms the deny.
		await det.decide(mctx([["read_file", "read_file"]]));
		expect(await enf.decide(tctx("read_file"))).toEqual({ kind: "allow" });
	});
});

describe("list.repeat rule", () => {
	const rule = () => builtinRules().find((r) => r.rule.id === "list.repeat")!.rule as HookRule<SteerContext["beforeTool"]>;
	const lctx = (input: unknown): SteerContext["beforeTool"] => ({ call: { callId: "c", name: "list_files", input }, ledger: emptyLedger(), outcomes: {} });

	it("denies a repeat of the same path+recursive listing, allows variations", async () => {
		const r = rule();
		expect(await r.decide(lctx({ path: "." }))).toEqual({ kind: "allow" });
		// Same listing requested again — max_entries doesn't change a flat result.
		const denied = await r.decide(lctx({ path: ".", max_entries: 3000 }));
		expect(denied).toMatchObject({ kind: "deny" });
		expect(denied.kind === "deny" && denied.reason).toContain("recursive");
		// A recursive listing or a different path is a different call.
		expect(await r.decide(lctx({ path: ".", recursive: true }))).toEqual({ kind: "allow" });
		expect(await r.decide(lctx({ path: "src" }))).toEqual({ kind: "allow" });
		// Other tools pass through.
		expect(await r.decide(beforeTool({ callId: "c", name: "read_file", input: {} }))).toEqual({ kind: "allow" });
	});

	it("re-allows a listing after a mutating call may have changed it", async () => {
		const r = rule();
		await r.decide(lctx({ path: "." }));
		expect(await r.decide(lctx({ path: "." }))).toMatchObject({ kind: "deny" });
		// A write between the two lists makes the re-list legitimate again.
		await r.decide(beforeTool({ callId: "w", name: "write_file", input: { path: "a.ts" } }));
		expect(await r.decide(lctx({ path: "." }))).toEqual({ kind: "allow" });
		// A task-board call does not reset it.
		await r.decide(beforeTool({ callId: "t", name: "task_step_update", input: {} }));
		expect(await r.decide(lctx({ path: "." }))).toMatchObject({ kind: "deny" });
	});

	it("leaves other reads alone — the read cache dedupes them", async () => {
		const r = rule();
		const rctx = (input: unknown): SteerContext["beforeTool"] => ({ call: { callId: "c", name: "read_file", input }, ledger: emptyLedger(), outcomes: {} });
		expect(await r.decide(rctx({ path: "package.json" }))).toEqual({ kind: "allow" });
		expect(await r.decide(rctx({ path: "package.json" }))).toEqual({ kind: "allow" });
	});
});

describe("reads.wander rule", () => {
	const rule = (): HookRule<SteerContext["beforeModel"]> => {
		const entry = builtinRules().find((r) => r.point === "beforeModel" && r.rule.id === "reads.wander");
		if (!entry) throw new Error("reads.wander not registered");
		return entry.rule as HookRule<SteerContext["beforeModel"]>;
	};
	const ctx = (turns: string[][]): SteerContext["beforeModel"] => ({
		turn: turns.length,
		ledger: emptyLedger(),
		recentTurns: turns.map((calls) => ({ calls })),
	});
	const reads = (n: number) => Array.from({ length: n }, () => ["read_file"]);

	it("allows short read streaks and notes once at the threshold", async () => {
		const r = rule();
		expect(await r.decide(ctx(reads(9)))).toEqual({ kind: "allow" });
		expect(await r.decide(ctx(reads(10)))).toMatchObject({ kind: "note" });
		// The strong note fires once per run; a repeat streak stays quiet.
		expect(await r.decide(ctx(reads(11)))).toEqual({ kind: "allow" });
	});

	it("denies at the hard threshold, then requires the streak to grow before denying again", async () => {
		const r = rule();
		expect(await r.decide(ctx(reads(16)))).toMatchObject({ kind: "deny", reason: expect.stringContaining("Wandering") });
		// Resumed run: the deferred strong note lands once, then the model gets
		// a few turns to change course before the next deny.
		expect(await r.decide(ctx(reads(17)))).toMatchObject({ kind: "note" });
		for (const n of [18, 19, 20]) expect(await r.decide(ctx(reads(n)))).toEqual({ kind: "allow" });
		expect(await r.decide(ctx(reads(21)))).toMatchObject({ kind: "deny" });
	});

	it("a write or a tool-free turn breaks the streak", async () => {
		const r = rule();
		const mixed = [...reads(15), ["write_file"], ...reads(3)];
		expect(await r.decide(ctx(mixed))).toEqual({ kind: "allow" });
		const noCalls = [...reads(15), [], ...reads(3)];
		expect(await r.decide(ctx(noCalls))).toEqual({ kind: "allow" });
	});

	it("does not deny while the board is making progress", async () => {
		const r = rule();
		const ledgerWith = (open: number) => ({
			order: ["t1"],
			tasks: {
				t1: {
					id: "t1",
					title: "t",
					acceptance: { kind: "none" as const },
					dependsOn: [],
					status: "in_progress" as const,
					steps: [
						{ id: "s1", text: "a", status: "done" as const, callIds: [] },
						{ id: "s2", text: "b", status: open > 0 ? ("in_progress" as const) : ("done" as const), callIds: [] },
						{ id: "s3", text: "c", status: open > 1 ? ("pending" as const) : ("done" as const), callIds: [] },
					],
					evidence: [],
				},
			},
			verified: [],
		});
		const pctx = (turns: string[][], open: number): SteerContext["beforeModel"] => ({
			turn: turns.length,
			ledger: ledgerWith(open),
			recentTurns: turns.map((calls) => ({ calls })),
		});
		await r.decide(pctx(reads(15), 2));
		// A step closed between checks — reads are paying off, not wandering.
		expect(await r.decide(pctx(reads(17), 1))).toEqual({ kind: "allow" });
		// With no progress since, the same streak denies.
		expect(await r.decide(pctx(reads(20), 1))).toMatchObject({ kind: "deny" });
	});

	it("read-only runs get a longer leash and no write wording", async () => {
		const r = builtinRules({ writable: false }).find((x) => x.rule.id === "reads.wander")!.rule as HookRule<SteerContext["beforeModel"]>;
		expect(await r.decide(ctx(reads(20)))).toEqual({ kind: "allow" });
		expect(await r.decide(ctx(reads(24)))).toMatchObject({ kind: "note" });
		const denied = await r.decide(ctx(reads(40)));
		expect(denied.kind === "deny" && denied.reason).not.toContain("write");
	});

	it("post-save_plan reads lose the relaxed read-only leash", async () => {
		const r = builtinRules({ writable: false }).find((x) => x.rule.id === "reads.wander")!.rule as HookRule<SteerContext["beforeModel"]>;
		// save_plan in an earlier turn means the deliverable exists — writable
		// thresholds apply (deny at 16, not 40).
		const turns = [...[["save_plan"]], ...reads(16)];
		expect(await r.decide(ctx(turns))).toMatchObject({ kind: "deny", reason: expect.stringContaining("Wandering") });
	});

	it("tree.recount notes once after 6 tree-derivation calls", async () => {
		const r = builtinRules().find((x) => x.rule.id === "tree.recount")!.rule as HookRule<SteerContext["beforeModel"]>;
		expect(await r.decide(ctx([["list_files"], ["get_file_structure"], ["list_files"]]))).toEqual({ kind: "allow" });
		expect(await r.decide(ctx([["list_files", "list_files"], ["get_file_structure"], ["list_files"], ["list_files"], ["get_file_structure"], ["list_files"], ["list_files"]]))).toMatchObject({ kind: "note", text: expect.stringContaining("layout") });
		expect(await r.decide(ctx(reads(3)))).toEqual({ kind: "allow" });
	});

	it("counts every read-only tool toward the streak", async () => {
		const r = rule();
		const turns = ["search_files", "list_files", "explore_codebase", "log_slice", "recall_context"].map((t) => [t]);
		const padded = [...reads(11), ...turns];
		expect(await r.decide(ctx(padded))).toMatchObject({ kind: "deny" });
	});
});
