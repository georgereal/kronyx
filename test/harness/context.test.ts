import { describe, expect, it } from "vitest";
import type { ToolSpec } from "../../src/harness/contracts";
import { MemoryEventLog } from "../../src/harness/eventLog";
import { buildContext, compactHistory, COMPACT_CHUNK, COMPACT_HEAD_CHARS, COMPACT_OVER_CHARS, DIGEST_OVER_CHARS, KEEP_RECENT_MESSAGES, KEEP_RECENT_RESULTS, LOG_SLICE_SPEC, prefixHash, SYSTEM_INSTRUCTIONS, taskBoard } from "../../src/harness/context";
import { initialState, reduce, type HarnessState } from "../../src/harness/projections";
import type { SessionEvent } from "../../src/harness/contracts";

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
			task: { id: "t", title: "Parse", acceptance: { kind: "command", command: "true" }, dependsOn: [], status: "pending", steps: [{ id: "s1", text: "write", status: "pending", callIds: [] }], evidence: [] },
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

		it("compacts an old long user message to a head and an elision note with its seq", async () => {
			const long = "a".repeat(COMPACT_OVER_CHARS + 500);
			const state = await longRun(long, KEEP_RECENT_MESSAGES + COMPACT_CHUNK);
			const first = compactHistory(state.messages)[0];
			expect(first?.kind === "user" && first.text.length).toBeLessThan(COMPACT_HEAD_CHARS + 200);
			expect(first?.kind === "user" && first.text).toMatch(/elided at seq 1\. log_slice from 1 to 1/);
		});

		it("leaves recent messages intact even when they are long", async () => {
			const long = "b".repeat(COMPACT_OVER_CHARS + 500);
			const state = await longRun("short task", KEEP_RECENT_MESSAGES);
			const withLong = { ...state, messages: [...state.messages, { kind: "user" as const, text: long, seq: 99 }] };
			expect(compactHistory(withLong.messages).at(-1)).toMatchObject({ text: long });
		});

		it("keeps the compacted rendering fixed within a chunk, so the prefix does not churn every turn", async () => {
			const long = "c".repeat(COMPACT_OVER_CHARS + 500);
			const a = compactHistory((await longRun(long, KEEP_RECENT_MESSAGES + COMPACT_CHUNK)).messages);
			const b = compactHistory((await longRun(long, KEEP_RECENT_MESSAGES + COMPACT_CHUNK + 1)).messages);
			expect(b[0]).toEqual(a[0]);
		});

		it("does nothing to a short history", async () => {
			const state = await longRun("x".repeat(COMPACT_OVER_CHARS + 1), 3);
			expect(compactHistory(state.messages)[0]).toMatchObject({ text: "x".repeat(COMPACT_OVER_CHARS + 1) });
		});
	});
});
