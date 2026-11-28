import { describe, expect, it } from "vitest";
import type { HookRule } from "../../src/harness/core/contracts";
import { emptyLedger } from "../../src/harness/core/taskLedger";
import { builtinRules, SteeringError, SteeringRegistry, type SteerContext } from "../../src/harness/defaults/steering";
import { isReadOnlyCommand } from "../../src/harness/tools/shellReadOnly";

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

describe("shell read classification in steering", () => {
	const mctx = (turns: Array<{ calls: string[]; readOnly?: boolean[]; text?: string }>): SteerContext["beforeModel"] => ({
		turn: turns.length,
		ledger: emptyLedger(),
		recentTurns: turns,
	});
	const roShell = (command: string, text?: string) => ({ calls: ["run_command"], readOnly: [isReadOnlyCommand(command)], ...(text ? { text } : {}) });
	const rule = (id: string) => builtinRules().find((r) => r.rule.id === id)!.rule as HookRule<SteerContext["beforeModel"]>;

	it("read-only run_commands count toward the wander streak — shell reads can't hide", async () => {
		const r = rule("reads.wander");
		const turns = Array.from({ length: 16 }, () => roShell("sed -n '1,40p' f.ts"));
		expect(await r.decide(mctx(turns))).toMatchObject({ kind: "deny", reason: expect.stringContaining("Wandering") });
	});

	it("a non-read-only run_command breaks the streak", async () => {
		const r = rule("reads.wander");
		const turns = [...Array.from({ length: 16 }, () => roShell("cat f.ts")), { calls: ["run_command"], readOnly: [isReadOnlyCommand("npm test")] }];
		expect(await r.decide(mctx(turns))).toEqual({ kind: "allow" });
	});

	it("turns without readOnly flags keep the old behavior", async () => {
		const r = rule("reads.wander");
		const turns = Array.from({ length: 20 }, () => ({ calls: ["run_command"] }));
		expect(await r.decide(mctx(turns))).toEqual({ kind: "allow" });
	});
});

describe("reads.converge rule", () => {
	const rule = () => builtinRules().find((r) => r.rule.id === "reads.converge")!.rule as HookRule<SteerContext["beforeModel"]>;
	const ctx = (turns: Array<{ calls: string[]; readOnly?: boolean[]; text?: string }>): SteerContext["beforeModel"] => ({
		turn: turns.length,
		ledger: emptyLedger(),
		recentTurns: turns,
	});
	const roShell = (text?: string) => ({ calls: ["run_command"], readOnly: [true], ...(text ? { text } : {}) });

	it("notes once when the model declares it has enough but keeps reading", async () => {
		const r = rule();
		const turns = [
			roShell("Let me read the tool files."),
			roShell("Now the remaining files."),
			roShell("I have a good picture of the tool surface."),
			roShell("Let me check the remaining pieces."),
		];
		expect(await r.decide(ctx(turns))).toMatchObject({ kind: "note", text: expect.stringContaining("enough context") });
	});

	it("denies after repeated declarations across a long read-only streak", async () => {
		const r = rule();
		const turns = [
			roShell("I have most of the picture."),
			roShell(),
			roShell("I have a good picture now — let me do a final check."),
			roShell(),
			roShell("Let me check the remaining pieces."),
			roShell(),
			roShell(),
			roShell("One last file and I'm done."),
		];
		expect(await r.decide(ctx(turns))).toMatchObject({ kind: "deny", reason: expect.stringContaining("Stop reading") });
	});

	it("stays quiet on plain exploration without declarations", async () => {
		const r = rule();
		const turns = Array.from({ length: 8 }, () => roShell("Let me look at the tool wiring."));
		expect(await r.decide(ctx(turns))).toEqual({ kind: "allow" });
	});

	it("a write turn resets the streak", async () => {
		const r = rule();
		const turns = [roShell("I have a good picture."), roShell("Final check."), { calls: ["write_file"], readOnly: [false] }, roShell()];
		expect(await r.decide(ctx(turns))).toEqual({ kind: "allow" });
	});
});

describe("reads.shell nudge", () => {
	const rule = () => builtinRules().find((r) => r.rule.id === "reads.shell")!.rule as HookRule<SteerContext["beforeTool"]>;
	const tctx = (name: string, input: unknown): SteerContext["beforeTool"] => ({ call: { callId: "c", name, input }, ledger: emptyLedger(), outcomes: {} });

	it("notes after three read-only shell calls, ignores writes and repeats", async () => {
		const r = rule();
		expect(await r.decide(tctx("run_command", { command: "cat a" }))).toEqual({ kind: "allow" });
		expect(await r.decide(tctx("run_command", { command: "sed -n '1,5p' b" }))).toEqual({ kind: "allow" });
		expect(await r.decide(tctx("run_command", { command: "npm test" }))).toEqual({ kind: "allow" });
		expect(await r.decide(tctx("run_command", { command: "grep x c" }))).toMatchObject({ kind: "note", text: expect.stringContaining("read_file") });
		// Once only.
		expect(await r.decide(tctx("run_command", { command: "head d" }))).toEqual({ kind: "allow" });
	});
});

describe("plan.drift rule", () => {
	const rule = () => builtinRules({ runId: "r1" }).find((r) => r.rule.id === "plan.drift")!.rule as HookRule<SteerContext["beforeModel"]>;
	const ledger = (stepStatus: "in_progress" | "done" = "in_progress") => ({
		order: ["t1"],
		tasks: {
			t1: { id: "t1", title: "t", acceptance: { kind: "none" as const }, dependsOn: [], status: "in_progress" as const, steps: [{ id: "s1", text: "x", status: stepStatus, callIds: [] }], evidence: [], runId: "r1" },
		},
		verified: [] as string[],
	});
	const ctx = (l: ReturnType<typeof ledger>, calls = ["run_command"]): SteerContext["beforeModel"] => ({ turn: 1, ledger: l, recentTurns: [{ calls }] });
	const drain = async (r: HookRule<SteerContext["beforeModel"]>, n: number, l = ledger()) => {
		let last;
		for (let i = 0; i < n; i++) last = await r.decide(ctx(l));
		return last;
	};

	it("nudges the model to explain itself before ever asking the user", async () => {
		const r = rule();
		await drain(r, 1); // baseline signature
		expect(await drain(r, 5)).toEqual({ kind: "allow" });
		const note = await r.decide(ctx(ledger())); // 6th unproductive turn
		expect(note).toMatchObject({ kind: "note", text: expect.stringContaining("task_replace") });
	});

	it("escalates to ask only after several ignored nudges", async () => {
		const r = rule();
		const kinds: string[] = [];
		await r.decide(ctx(ledger())); // baseline
		for (let i = 0; i < 15; i++) kinds.push((await r.decide(ctx(ledger()))).kind);
		expect(kinds.filter((k) => k === "note").length).toBe(3);
		expect(kinds[kinds.length - 1]).toBe("ask");
	});

	it("any board change resets the counter — replanning counts as an answer", async () => {
		const r = rule();
		await drain(r, 1);
		expect(await drain(r, 6)).toMatchObject({ kind: "note" });
		// Step closes → signature changes → drift resolved.
		expect(await r.decide(ctx(ledger("done")))).toEqual({ kind: "allow" });
		// Streak restarts from zero.
		expect(await drain(r, 5, ledger("done"))).toEqual({ kind: "allow" });
	});

	it("write turns are productive — a big implementation step never reads as drift", async () => {
		const r = rule();
		await r.decide(ctx(ledger())); // baseline
		// 25 turns of genuine writes (the Session-20 false positive: three new
		// classes, edits, tests while the big step stayed in_progress) — no drift.
		const writing: SteerContext["beforeModel"] = { turn: 1, ledger: ledger(), recentTurns: [{ calls: ["write_file"], readOnly: [false] }] };
		for (let i = 0; i < 25; i++) expect((await r.decide(writing)).kind).toBe("allow");
		// but task bookkeeping alone is accounting, not output — it must not evade drift
		const bookkeeping: SteerContext["beforeModel"] = { turn: 1, ledger: ledger(), recentTurns: [{ calls: ["task_step_update"], readOnly: [false] }] };
		let sawNote = false;
		for (let i = 0; i < 8; i++) if ((await r.decide(bookkeeping)).kind === "note") sawNote = true;
		expect(sawNote).toBe(true);
	});

	it("reads interleaved with writes still count when the writes stop", async () => {
		const r = rule();
		await r.decide(ctx(ledger())); // baseline
		const writing: SteerContext["beforeModel"] = { turn: 1, ledger: ledger(), recentTurns: [{ calls: ["edit_file"], readOnly: [false] }] };
		for (let i = 0; i < 4; i++) await r.decide(writing);
		// writes stop — read-only turns accrue from zero, so the first nudge lands at the usual threshold
		const reading: SteerContext["beforeModel"] = { turn: 1, ledger: ledger(), recentTurns: [{ calls: ["read_file"], readOnly: [true] }] };
		const kinds: string[] = [];
		for (let i = 0; i < 7; i++) kinds.push((await r.decide(reading)).kind);
		expect(kinds).toContain("note");
	});

	it("skips runs with no board", async () => {
		const r = rule();
		for (let i = 0; i < 20; i++) expect(await r.decide({ turn: i, ledger: emptyLedger(), recentTurns: [{ calls: ["write_file"], readOnly: [false] }] })).toEqual({ kind: "allow" });
	});
});

describe("plan.offstep — verify-step iteration", () => {
	const ledgerWithVerifyStep = async () => {
		const { emptyLedger, applyLedgerEvent } = await import("../../src/harness/core/taskLedger");
		let ledger = emptyLedger();
		ledger = applyLedgerEvent(ledger, {
			type: "task.created",
			task: {
				id: "t1", title: "Tests", acceptance: { kind: "command", command: "mvn test" },
				dependsOn: [], status: "pending", evidence: [], planId: "p1",
				steps: [{ id: "s1", text: "`mvn test` passes; fix any failures", status: "pending", callIds: [], signal: { tool: "run_command", path: "mvn test" } }],
			},
		});
		ledger = applyLedgerEvent(ledger, { type: "task.updated", id: "t1", to: "in_progress" });
		ledger = applyLedgerEvent(ledger, { type: "step.updated", taskId: "t1", stepId: "s1", to: "in_progress", callIds: [] });
		return ledger;
	};
	const mkRegistry = async () => {
		const { SteeringRegistry, builtinRules } = await import("../../src/harness/defaults/steering");
		const reg = new SteeringRegistry();
		for (const r of builtinRules()) reg.add(r.point, r.rule);
		return reg;
	};

	it("a failing attempt at the proving command resets the off-plan counter", async () => {
		const ledger = await ledgerWithVerifyStep();
		const reg = await mkRegistry();
		const write = { callId: "w", name: "write_file", input: { path: "src/X.java" } };
		const test = { callId: "t", name: "run_command", input: { command: "cd x && mvn clean test 2>&1" } };
		// Two writes, then a FAILED test run — then more writes. No offstep note should appear.
		for (let i = 0; i < 2; i++) await reg.run("afterTool", { call: { ...write, callId: `w${i}` }, ok: true, ledger });
		await reg.run("afterTool", { call: test, ok: false, ledger });
		let noted = false;
		for (let i = 0; i < 6; i++) {
			const r = await reg.run("afterTool", { call: { ...write, callId: `x${i}` }, ok: true, ledger });
			if (r.notes.some((n) => n.rule === "plan.offstep")) noted = true;
		}
		expect(noted).toBe(false);
	});

	it("writes during a run_command verify step are excused as fixup work", async () => {
		const ledger = await ledgerWithVerifyStep();
		const reg = await mkRegistry();
		let noted = false;
		for (let i = 0; i < 8; i++) {
			const r = await reg.run("afterTool", { call: { callId: `e${i}`, name: "edit_file", input: { path: "src/X.java" } }, ok: true, ledger });
			if (r.notes.some((n) => n.rule === "plan.offstep")) noted = true;
		}
		expect(noted).toBe(false);
	});

	it("writes still count as off-plan when the open signal is a file-type step", async () => {
		const { emptyLedger, applyLedgerEvent } = await import("../../src/harness/core/taskLedger");
		let ledger = emptyLedger();
		ledger = applyLedgerEvent(ledger, {
			type: "task.created",
			task: {
				id: "t1", title: "Write", acceptance: { kind: "command", command: "tsc" },
				dependsOn: [], status: "pending", evidence: [], planId: "p1",
				steps: [{ id: "s1", text: "create Config.java", status: "pending", callIds: [], signal: { tool: "write_file", path: "Config.java" } }],
			},
		});
		ledger = applyLedgerEvent(ledger, { type: "task.updated", id: "t1", to: "in_progress" });
		ledger = applyLedgerEvent(ledger, { type: "step.updated", taskId: "t1", stepId: "s1", to: "in_progress", callIds: [] });
		const reg = await mkRegistry();
		let notes = 0;
		for (let i = 0; i < 10; i++) {
			const r = await reg.run("afterTool", { call: { callId: `e${i}`, name: "write_file", input: { path: "unrelated/Other.java" } }, ok: true, ledger });
			notes += r.notes.filter((n) => n.rule === "plan.offstep").length;
		}
		expect(notes).toBeGreaterThan(0);
	});
});

describe("refs.unknown — hallucinated-reference capture", () => {
	const ledgerWithBoard = async () => {
		const { applyLedgerEvent } = await import("../../src/harness/core/taskLedger");
		const mk = (id: string, runId: string) => ({ id, title: id, acceptance: { kind: "none" as const }, dependsOn: [], status: "pending" as const, steps: [], evidence: [], runId });
		let ledger = emptyLedger();
		for (const id of ["t1", "t2", "t3"]) ledger = applyLedgerEvent(ledger, { type: "task.created", task: mk(id, "r1") });
		return ledger;
	};
	const beforeModelCtx = (ledger: import("../../src/harness/core/taskLedger").Ledger, text: string): SteerContext["beforeModel"] => ({
		turn: 1, ledger, recentTurns: [{ calls: ["read_file"], text }],
	});
	const runRule = async (ledger: import("../../src/harness/core/taskLedger").Ledger, text: string) => {
		const reg = new SteeringRegistry();
		for (const r of builtinRules({ runId: "r1" })) reg.add(r.point, r.rule);
		return reg.run("beforeModel", beforeModelCtx(ledger, text));
	};

	it("notes a reference to a task that does not exist", async () => {
		const ledger = await ledgerWithBoard();
		const result = await runRule(ledger, "now closing t9 and moving to s7");
		const note = result.notes.find((n) => n.rule === "refs.unknown");
		expect(note?.text).toMatch(/\{t9\}/);
		expect(note?.text).toMatch(/\{s7\}/);
		expect(note?.text).toMatch(/t1, t2, t3/);
	});

	it("stays silent when references are real", async () => {
		const ledger = await ledgerWithBoard();
		const result = await runRule(ledger, "t1 is done, moving to t2 then t3");
		expect(result.notes.find((n) => n.rule === "refs.unknown")).toBeUndefined();
	});

	it("stays silent on an empty board — pre-planning text can't hallucinate", async () => {
		const result = await runRule(emptyLedger(), "I will create t1 through t9");
		expect(result.notes.find((n) => n.rule === "refs.unknown")).toBeUndefined();
	});

	it("notes each unique token once — no nagging on repetition", async () => {
		const ledger = await ledgerWithBoard();
		const reg = new SteeringRegistry();
		for (const r of builtinRules({ runId: "r1" })) reg.add(r.point, r.rule);
		const first = await reg.run("beforeModel", beforeModelCtx(ledger, "closing t9"));
		expect(first.notes.find((n) => n.rule === "refs.unknown")).toBeDefined();
		const second = await reg.run("beforeModel", beforeModelCtx(ledger, "still closing t9"));
		expect(second.notes.find((n) => n.rule === "refs.unknown")).toBeUndefined();
		// a NEW phantom still notes
		const third = await reg.run("beforeModel", beforeModelCtx(ledger, "and then t42"));
		expect(third.notes.find((n) => n.rule === "refs.unknown")?.text).toMatch(/\{t42\}/);
	});
});
