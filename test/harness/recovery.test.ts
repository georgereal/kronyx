import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelPort, SessionEvent, ToolPort } from "../../src/harness/core/contracts";
import { FileEventLog, MemoryEventLog } from "../../src/harness/core/eventLog";
import { HarnessLoop } from "../../src/harness/core/loop";

const spec = { name: "noop", description: "", inputSchema: {} };

function tools(calls: string[]): ToolPort {
	return {
		specs: () => [spec],
		execute: async (name, input) => {
			calls.push(JSON.stringify(input));
			return { ok: true, output: `ran ${name}` };
		},
	};
}

/** Model: first call asks for two tools, then finishes. */
function model(): ModelPort {
	let turn = 0;
	return {
		async complete() {
			turn++;
			if (turn === 1) {
				return {
					text: "",
					toolCalls: [
						{ callId: "a", name: "noop", input: { n: 1 } },
						{ callId: "b", name: "noop", input: { n: 2 } },
					],
				};
			}
			return { text: "all done", toolCalls: [] };
		},
	};
}

describe("crash recovery (M7)", () => {
	it("marks a tool call with no recorded result as interrupted and does not re-run recorded calls", async () => {
		const log = new MemoryEventLog(() => 1);
		const first: string[] = [];
		const loop = new HarnessLoop({ runId: "r", log, model: model(), tools: tools(first) });
		await loop.run("go");
		expect(first).toHaveLength(2);

		// Simulate a crash after call "b" was requested but before its result was written.
		const all = await log.read();
		const cut = all.findIndex((e) => e.type === "tool.finished" && e.callId === "b");
		const events = all.slice(0, cut);
		const replay = new MemoryEventLog(() => 1);
		for (const e of events) await replay.append({ ...stripMeta(e), runId: "r" } as never);

		const second: string[] = [];
		const recovered = new HarnessLoop({ runId: "r", log: replay, model: model(), tools: tools(second) });
		const { interrupted } = await recovered.recover();
		expect(interrupted).toBe(1);
		expect(second).toEqual([]);
		const b = recovered.projection.messages.find((m) => m.kind === "tool" && m.callId === "b");
		expect(b).toMatchObject({ ok: false });
		expect(recovered.projection.run).toMatchObject({ status: "paused", reason: "recovered" });
	});

	it("resumes after recovery and finishes without repeating recorded tool calls", async () => {
		const log = new MemoryEventLog(() => 1);
		const first: string[] = [];
		await new HarnessLoop({ runId: "r", log, model: model(), tools: tools(first) }).run("go");
		const events = (await log.read()).filter((e) => !(e.type === "run.status" && e.status === "completed"));
		const replay = new MemoryEventLog(() => 1);
		for (const e of events) await replay.append({ ...stripMeta(e), runId: "r" } as never);

		const second: string[] = [];
		const loop = new HarnessLoop({ runId: "r", log: replay, model: { complete: async () => ({ text: "wrapped up", toolCalls: [] }) }, tools: tools(second) });
		await loop.recover();
		const outcome = await loop.resume();
		expect(outcome.status).toBe("completed");
		expect(second).toEqual([]);
	});

	it("resumes with recovery input on the same run ledger", async () => {
		const log = new MemoryEventLog(() => 1);
		const first: string[] = [];
		await new HarnessLoop({ runId: "r", log, model: model(), tools: tools(first) }).run("go");
		const events = (await log.read()).filter((e) => !(e.type === "run.status" && e.status === "completed"));
		const replay = new MemoryEventLog(() => 1);
		for (const e of events) await replay.append({ ...stripMeta(e), runId: "r" } as never);

		const loop = new HarnessLoop({ runId: "r", log: replay, model: { complete: async () => ({ text: "recovered", toolCalls: [] }) }, tools: tools([]) });
		await loop.recover();
		const outcome = await loop.resume("The sandbox died; check state and continue.");
		expect(outcome.status).toBe("completed");
		const inputs = (await replay.read()).filter((e) => e.type === "user.input").map((e) => e.type === "user.input" ? e.text : "");
		expect(inputs.at(-1)).toContain("sandbox died");
		expect((await replay.read()).filter((e) => e.type === "run.status" && e.status === "running")).toHaveLength(2);
	});

	it("survives a restart with the file log: reopen, recover, and the log stays valid", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "harness-recover-"));
		const file = path.join(dir, "session.jsonl");
		const log = await FileEventLog.open(file, () => 1);
		await new HarnessLoop({ runId: "r", log, model: model(), tools: tools([]) }).run("go");
		const lines = (await readFile(file, "utf8")).trim().split("\n");
		const cut = lines.findIndex((l) => l.includes('"type":"tool.finished"') && l.includes('"callId":"b"'));
		await writeFile(file, lines.slice(0, cut).join("\n") + "\n");

		const reopened = await FileEventLog.open(file, () => 1);
		const loop = new HarnessLoop({ runId: "r", log: reopened, model: model(), tools: tools([]) });
		expect((await loop.recover()).interrupted).toBe(1);
		const after = await FileEventLog.open(file, () => 1);
		const events = await after.read();
		expect(events.some((e) => e.type === "run.status" && e.status === "paused")).toBe(true);
		expect(events.at(-1)?.type).toBe("execution.state_snapshotted");
	});
});

function stripMeta(event: SessionEvent): Record<string, unknown> {
	const { seq: _seq, at: _at, runId: _runId, ...body } = event;
	return body;
}
