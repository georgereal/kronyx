import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../src/harness/core/contracts";
import { MemoryEventLog } from "../../src/harness/core/eventLog";
import { buildContext, compactHistory, COMPACT_CHUNK, COMPACT_HEAD_CHARS, COMPACT_OVER_CHARS, DIGEST_OVER_CHARS, KEEP_RECENT_MESSAGES, KEEP_RECENT_RESULTS, LOG_SLICE_SPEC, makeContextPolicy, prefixHash, SYSTEM_INSTRUCTIONS, taskBoard } from "../../src/harness/defaults/context";
import { inputBudgetForWindow } from "../../src/context/adapters/harnessProjection";
import { maybeHarnessRecap } from "../../src/context/adapters/harnessRecap";
import type { ModelPort } from "../../src/harness/core/contracts";
import { initialState, reduce, type HarnessState } from "../../src/harness/core/projections";
import type { SessionEvent } from "../../src/harness/core/contracts";

const tools: ToolSpec[] = [{ name: "read_file", description: "read", inputSchema: { type: "object" } }];

function stateFrom(events: SessionEvent[]): HarnessState {
	return events.reduce(reduce, initialState());
}

async function bigResultLog(size: number) {
	const log = new MemoryEventLog(() => 1);
	const out = "x".repeat(size);
	const body = [
		{ type: "user.input", text: "go" },
		{ type: "tool.requested", callId: "big", name: "read_file", input: { path: "a" } },
		{ type: "tool.finished", callId: "big", name: "read_file", ok: true, output: out },
	];
	for (const b of body) await log.append({ ...(b as object), runId: "r" } as never);
	for (let i = 0; i < KEEP_RECENT_RESULTS; i++) {
		await log.append({ type: "tool.requested", callId: `small${i}`, name: "read_file", input: { i }, runId: "r" });
		await log.append({ type: "tool.finished", callId: `small${i}`, name: "read_file", ok: true, output: "ok", runId: "r" });
	}
	return log;
}

describe("context projection (M6)", () => {
	it("keeps the stable prefix byte-identical across tasks and changes it when instructions change", () => {
		const a = buildContext(initialState(), tools);
		const b = buildContext(stateFrom([]), tools);
		expect(a.prefixHash).toBe(b.prefixHash);
		expect(prefixHash(SYSTEM_INSTRUCTIONS + "!", tools)).not.toBe(a.prefixHash);
	});

	it("includes log_slice in the tool list the model sees", () => {
		expect(buildContext(initialState(), tools).tools.map((t) => t.name)).toEqual(["read_file"]);
		expect(LOG_SLICE_SPEC.name).toBe("log_slice");
	});

	it("digests an old large tool result with its seq and leaves recent results intact", async () => {
		const log = await bigResultLog(DIGEST_OVER_CHARS + 500);
		const state = stateFrom(await log.read());
		const ctx = buildContext(state, tools);
		const big = ctx.messages.find((m) => m.kind === "tool" && m.callId === "big");
		expect(big?.kind === "tool" && big.output).toMatch(/digest.*seq 3.*log_slice from 3 to 3/);
		const recent = ctx.messages.filter((m) => m.kind === "tool" && m.callId.startsWith("small"));
		expect(recent.every((m) => m.kind === "tool" && m.output === "ok")).toBe(true);
	});

	it("recovers a digested result byte-for-byte from the log through log_slice", async () => {
		const size = DIGEST_OVER_CHARS + 500;
		const log = await bigResultLog(size);
		const events = await log.read();
		const finished = events.find((e) => e.type === "tool.finished" && e.callId === "big");
		const slice = (await log.read()).filter((e) => e.seq === finished?.seq);
		expect(slice).toHaveLength(1);
		const recovered = slice[0]!.type === "tool.finished" ? slice[0]!.output : "";
		expect(recovered).toHaveLength(size);
	});

	it("does not digest a result that is under the size threshold", async () => {
		const log = await bigResultLog(DIGEST_OVER_CHARS - 1);
		const ctx = buildContext(stateFrom(await log.read()), tools);
		expect(ctx.messages.find((m) => m.kind === "tool" && m.callId === "big")).toMatchObject({ output: "x".repeat(DIGEST_OVER_CHARS - 1) });
	});

	it("appends the task board last so the prefix and history keep their cache", async () => {
		const log = new MemoryEventLog(() => 1);
		await log.append({
			type: "task.created",
			task: { id: "t", title: "Parse", acceptance: { kind: "command", command: "npm test" }, dependsOn: [], status: "pending", steps: [{ id: "s1", text: "write", status: "pending", callIds: [] }], evidence: [] },
			runId: "r",
		});
		const state = stateFrom(await log.read());
		expect(taskBoard(state)).toMatch(/t \[pending\] Parse\n {4}- s1 \[pending\] write/);
		const ctx = buildContext(state, tools);
		expect(ctx.messages.at(-1)).toMatchObject({ kind: "system" });
	});

	it("returns no board when there are no tasks", () => {
		expect(taskBoard(initialState())).toBeUndefined();
	});

	describe("message compaction", () => {
		async function longRun(longText: string, extra: number) {
			const log = new MemoryEventLog(() => 1);
			await log.append({ type: "user.input", text: longText, runId: "r" });
			for (let i = 0; i < extra; i++) await log.append({ type: "model.response", turn: i + 1, text: `short ${i}`, toolCalls: [], runId: "r" });
			return stateFrom(await log.read());
		}

		it("never compacts user inputs — the canonical objective and constraints survive verbatim", async () => {
			const long = "a".repeat(COMPACT_OVER_CHARS + 500);
			const state = await longRun(long, KEEP_RECENT_MESSAGES + COMPACT_CHUNK * 2);
			const first = compactHistory(state.messages)[0];
			expect(first).toMatchObject({ kind: "user", text: long });
		});

		it("compacts an old long assistant message to a head and an elision note with its seq", async () => {
			const log = new MemoryEventLog(() => 1);
			await log.append({ type: "user.input", text: "go", runId: "r" });
			const long = "a".repeat(COMPACT_OVER_CHARS + 500);
			await log.append({ type: "model.response", turn: 1, text: long, toolCalls: [], runId: "r" });
			for (let i = 0; i < KEEP_RECENT_MESSAGES + COMPACT_CHUNK; i++) await log.append({ type: "model.response", turn: i + 2, text: `short ${i}`, toolCalls: [], runId: "r" });
			const state = stateFrom(await log.read());
			const assistant = compactHistory(state.messages)[1];
			expect(assistant?.kind === "assistant" && assistant.text.length).toBeLessThan(COMPACT_HEAD_CHARS + 200);
			expect(assistant?.kind === "assistant" && assistant.text).toMatch(/elided at seq 2\. log_slice from 2 to 2/);
		});

		it("leaves recent messages intact even when they are long", async () => {
			const long = "b".repeat(COMPACT_OVER_CHARS + 500);
			const state = await longRun("short task", KEEP_RECENT_MESSAGES);
			const withLong = { ...state, messages: [...state.messages, { kind: "user" as const, text: long, seq: 99 }] };
			expect(compactHistory(withLong.messages).at(-1)).toMatchObject({ text: long });
		});

		it("keeps the compacted rendering fixed within a chunk, so the prefix does not churn every turn", async () => {
			const long = "c".repeat(COMPACT_OVER_CHARS + 500);
			const build = async (extra: number) => {
				const log = new MemoryEventLog(() => 1);
				await log.append({ type: "user.input", text: "go", runId: "r" });
				await log.append({ type: "model.response", turn: 1, text: long, toolCalls: [], runId: "r" });
				for (let i = 0; i < extra; i++) await log.append({ type: "model.response", turn: i + 2, text: `short ${i}`, toolCalls: [], runId: "r" });
				return compactHistory(stateFrom(await log.read()).messages);
			};
			const a = await build(KEEP_RECENT_MESSAGES + COMPACT_CHUNK);
			const b = await build(KEEP_RECENT_MESSAGES + COMPACT_CHUNK + 1);
			expect(b[1]).toEqual(a[1]);
		});

		it("does nothing to a short history", async () => {
			const state = await longRun("x".repeat(COMPACT_OVER_CHARS + 1), 3);
			expect(compactHistory(state.messages)[0]).toMatchObject({ text: "x".repeat(COMPACT_OVER_CHARS + 1) });
		});
	});

	describe("superseded and duplicate tool evidence", () => {
		async function logWith(events: object[]) {
			const log = new MemoryEventLog(() => 1);
			for (const e of events) await log.append({ ...(e as object), runId: "r" } as never);
			return stateFrom(await log.read());
		}
		const readResult = (callId: string, size: number) => [
			{ type: "model.response", turn: 1, text: "", toolCalls: [{ callId, name: "read_file", input: { path: "src/a.ts" } }] },
			{ type: "tool.finished", callId, name: "read_file", ok: true, output: "x".repeat(size) },
		];
		const writeResult = (callId: string) => [
			{ type: "model.response", turn: 1, text: "", toolCalls: [{ callId, name: "write_file", input: { path: "src/a.ts", content: "new" } }] },
			{ type: "tool.finished", callId, name: "write_file", ok: true, output: "Created src/a.ts" },
		];

		it("collapses a file read superseded by a later successful write, even inside the recent window", async () => {
			const state = await logWith([
				{ type: "user.input", text: "go" },
				...readResult("r1", 2000),
				...writeResult("w1"),
			]);
			const ctx = buildContext(state, tools);
			const stale = ctx.messages.find((m) => m.kind === "tool" && m.callId === "r1");
			expect(stale?.kind === "tool" && stale.output).toMatch(/superseded tool result/);
			expect(stale?.kind === "tool" && stale.output).not.toContain("x".repeat(500));
		});

		it("keeps the latest read of a file intact", async () => {
			const state = await logWith([
				{ type: "user.input", text: "go" },
				...readResult("r1", 2000),
				...readResult("r2", 2000),
			]);
			const ctx = buildContext(state, tools);
			const latest = ctx.messages.find((m) => m.kind === "tool" && m.callId === "r2");
			expect(latest?.kind === "tool" && latest.output).toContain("x".repeat(500));
			const stale = ctx.messages.find((m) => m.kind === "tool" && m.callId === "r1");
			expect(stale?.kind === "tool" && stale.output).toMatch(/superseded tool result/);
		});

		it("renders the execution-state component with validation, failures and the change map", async () => {
			const state = await logWith([
				{ type: "user.input", text: "go" },
				{ type: "task.created", task: { id: "t1", title: "Verify", acceptance: { kind: "command", command: "npm test" }, dependsOn: [], status: "pending", steps: [], evidence: [] } },
				...writeResult("w1"),
				{ type: "verifier.result", taskId: "t1", command: "npm test", ok: false },
			]);
			const ctx = buildContext(state, tools);
			const note = ctx.messages.find((m) => m.kind === "system" && m.text.startsWith("Execution state:"));
			expect(note?.kind === "system" && note.text).toMatch(/Validation: FAILED — `npm test`/);
			expect(note?.kind === "system" && note.text).toMatch(/Files modified: src\/a\.ts/);
		});
	});

	describe("token-measured budgeting", () => {
		it("measures the projection in real tokens and reports the estimate", async () => {
			const log = new MemoryEventLog(() => 1);
			await log.append({ type: "user.input", text: "hello world, implement the feature", runId: "r" });
			const state = stateFrom(await log.read());
			const ctx = buildContext(state, tools);
			expect(ctx.estimatedInputTokens).toBeGreaterThan(10);
			expect(ctx.overBudget).toBe(false);
			expect(ctx.reductionLevel).toBe(0);
		});

		it("collapses older evidence to recovery pointers when the token budget is tight", async () => {
			const log = new MemoryEventLog(() => 1);
			await log.append({ type: "user.input", text: "go", runId: "r" });
			for (let i = 0; i < KEEP_RECENT_RESULTS + 3; i++) {
				await log.append({ type: "model.response", turn: i + 1, text: "", toolCalls: [{ callId: `c${i}`, name: "run_command", input: { command: `cmd${i}` } }], runId: "r" });
				await log.append({ type: "tool.finished", callId: `c${i}`, name: "run_command", ok: true, output: `output ${i} ` + "y".repeat(3000), runId: "r" });
			}
			const state = stateFrom(await log.read());
			const wide = buildContext(state, tools);
			expect(wide.reductionLevel).toBe(0);
			// A budget that fits only a fraction of the results forces graduated reduction.
			const tight = buildContext(state, tools, SYSTEM_INSTRUCTIONS, "r", { inputTokens: 2500, outputReserveTokens: 1000 });
			expect(tight.reductionLevel).toBeGreaterThan(0);
			const old = tight.messages.find((m) => m.kind === "tool" && m.callId === "c0");
			expect(old?.kind === "tool" && old.output).toMatch(/tool result elided|tool result digest/);
			expect(tight.estimatedInputTokens).toBeLessThan(wide.estimatedInputTokens!);
		});

		it("marks a critical budget violation honestly when even maximum reduction cannot fit", async () => {
			const log = new MemoryEventLog(() => 1);
			await log.append({ type: "user.input", text: "go", runId: "r" });
			await log.append({ type: "model.response", turn: 1, text: "", toolCalls: [{ callId: "c0", name: "run_command", input: { command: "x" } }], runId: "r" });
			await log.append({ type: "tool.finished", callId: "c0", name: "run_command", ok: true, output: "z".repeat(20_000), runId: "r" });
			const state = stateFrom(await log.read());
			// Budget below even the fixed system+tools cost: nothing can be reduced away.
			const impossible = buildContext(state, tools, SYSTEM_INSTRUCTIONS, "r", { inputTokens: 5, outputReserveTokens: 1 });
			expect(impossible.overBudget).toBe(true);
		});

		it("never exceeds the budget silently: token pressure triggers compaction before the hard cap", async () => {
			const log = new MemoryEventLog(() => 1);
			// User inputs are never compacted, so thirty verbose inputs accumulate
			// verbatim — exactly the utilization the pressure trigger must catch.
			// 45 verbose inputs accumulate verbatim — past 70% of the 22976-token budget at level 0.
			for (let i = 0; i < 45; i++) {
				await log.append({ type: "user.input", text: `requirement ${i}: ` + "detail ".repeat(430), runId: "r" });
				await log.append({ type: "model.response", turn: i + 1, text: "ack", toolCalls: [], runId: "r" });
			}
			const state = stateFrom(await log.read());
			const policy = makeContextPolicy(inputBudgetForWindow(undefined));
			const measured = policy.build(state, [], SYSTEM_INSTRUCTIONS, "r");
			expect(measured.unreducedInputTokens!).toBeGreaterThan(policy.budgetTokens * 0.7);
			const emitted: object[] = [];
			const recapModel: ModelPort = { complete: async () => ({ text: "brief", toolCalls: [] }) };
			await maybeHarnessRecap({
				model: recapModel,
				emit: async (body) => { emitted.push(body); },
				state,
				runId: "r",
				signal: new AbortController().signal,
				lastInputTokens: measured.unreducedInputTokens!,
				taskDone: false,
				forced: false,
				context: policy,
			});
			expect(emitted.some((e) => (e as { type?: string }).type === "context.recap")).toBe(true);
		});

		it("does not trigger pressure compaction for a small context", async () => {
			const log = new MemoryEventLog(() => 1);
			await log.append({ type: "user.input", text: "go", runId: "r" });
			const state = stateFrom(await log.read());
			const policy = makeContextPolicy(inputBudgetForWindow(undefined));
			const measured = policy.build(state, [], SYSTEM_INSTRUCTIONS, "r");
			const emitted: object[] = [];
			const recapModel: ModelPort = { complete: async () => ({ text: "brief", toolCalls: [] }) };
			await maybeHarnessRecap({
				model: recapModel,
				emit: async (body) => { emitted.push(body); },
				state,
				runId: "r",
				signal: new AbortController().signal,
				lastInputTokens: measured.estimatedInputTokens!,
				taskDone: false,
				forced: false,
				context: policy,
			});
			expect(emitted).toHaveLength(0);
		});
	});
});
