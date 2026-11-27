import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FileEventLog, MemoryEventLog } from "../../src/harness/core/eventLog";

const clock = () => 1_700_000_000_000;

describe("MemoryEventLog", () => {
	it("stamps sequence numbers in order and never rewrites history", async () => {
		const log = new MemoryEventLog(clock);
		const a = await log.append({ type: "user.input", text: "one", runId: "r" });
		const b = await log.append({ type: "user.input", text: "two", runId: "r" });
		expect([a.seq, b.seq]).toEqual([1, 2]);
		expect((await log.read()).map((e) => e.seq)).toEqual([1, 2]);
	});
});

describe("FileEventLog", () => {
	it("persists events and reloads them with the same sequence", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "harness-log-"));
		const file = path.join(dir, "session.jsonl");
		const first = await FileEventLog.open(file, clock);
		await first.append({ type: "user.input", text: "hello", runId: "r" });
		await first.append({ type: "run.status", status: "running", runId: "r" });
		const reopened = await FileEventLog.open(file, clock);
		expect(await reopened.read()).toEqual(await first.read());
		await reopened.append({ type: "user.input", text: "again", runId: "r" });
		expect((await reopened.read()).at(-1)?.seq).toBe(3);
	});

	it("refuses a file whose sequence has a gap", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "harness-log-"));
		const file = path.join(dir, "bad.jsonl");
		const ok = { type: "user.input", text: "x", at: 1, runId: "r" };
		await writeFile(file, `${JSON.stringify({ ...ok, seq: 1 })}\n${JSON.stringify({ ...ok, seq: 3 })}\n`);
		await expect(FileEventLog.open(file, clock)).rejects.toThrow(/out of order/);
	});

	it("refuses a corrupt line instead of skipping it", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "harness-log-"));
		const file = path.join(dir, "corrupt.jsonl");
		await writeFile(file, "{not json}\n");
		await expect(FileEventLog.open(file, clock)).rejects.toThrow(/bad.*corrupt\.jsonl:1|corrupt\.jsonl:1/);
	});

	it("writes one JSON object per line", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "harness-log-"));
		const file = path.join(dir, "lines.jsonl");
		const log = await FileEventLog.open(file, clock);
		await log.append({ type: "user.input", text: "x", runId: "r" });
		const lines = (await readFile(file, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!).seq).toBe(1);
	});

	it("sync picks up lines appended after open, once", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "harness-log-"));
		const file = path.join(dir, "live.jsonl");
		const log = await FileEventLog.open(file, clock);
		await log.append({ type: "user.input", text: "one", runId: "r" });

		const line = (seq: number, text: string) => `${JSON.stringify({ type: "user.input", text, runId: "r", seq, at: 1 })}\n`;
		await appendFile(file, line(2, "two") + line(3, "three"));

		expect(await log.sync()).toBe(2);
		expect((await log.read()).map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(await log.sync()).toBe(0);
	});

	it("sync waits for a torn tail to complete", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "harness-log-"));
		const file = path.join(dir, "torn.jsonl");
		const log = await FileEventLog.open(file, clock);
		await log.append({ type: "user.input", text: "one", runId: "r" });

		const full = `${JSON.stringify({ type: "user.input", text: "two", runId: "r", seq: 2, at: 1 })}\n`;
		await appendFile(file, full.slice(0, -1)); // no trailing newline yet
		expect(await log.sync()).toBe(0);
		expect((await log.read()).map((e) => e.seq)).toEqual([1]);

		await appendFile(file, "\n");
		expect(await log.sync()).toBe(1);
		const last = (await log.read()).at(-1);
		expect(last?.type === "user.input" ? last.text : undefined).toBe("two");
	});

	it("sync rejects an out-of-order appended line", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "harness-log-"));
		const file = path.join(dir, "gap.jsonl");
		const log = await FileEventLog.open(file, clock);
		await log.append({ type: "user.input", text: "one", runId: "r" });
		await appendFile(file, `${JSON.stringify({ type: "user.input", text: "x", runId: "r", seq: 5, at: 1 })}\n`);
		await expect(log.sync()).rejects.toThrow(/out of order/);
	});
});
