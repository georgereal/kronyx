import { describe, expect, it } from "vitest";
import { createProcessTools } from "../src/tools/procTools";

const mk = () => createProcessTools({ root: process.cwd() });
const call = (t: { execute: (i: never, c: never) => string | Promise<string> }, i: Record<string, unknown>) => t.execute(i as never, {} as never);

describe("process tools", () => {
	it("start → poll → stop lifecycle", async () => {
		const reg = mk();
		const [start, poll, stop] = reg.tools;
		const started = await call(start, { command: "echo hello-proc && sleep 5" });
		expect(started).toContain("p1");
		expect(started).toContain("hello-proc");
		expect(started).toContain("running");

		const polled = await call(poll, { id: "p1" });
		expect(polled).toContain("running");

		const stopped = await call(stop, { id: "p1" });
		expect(stopped).toMatch(/exited|code|signal/);
		reg.dispose();
	});

	it("poll wait_seconds returns after exit for fast commands", async () => {
		const reg = mk();
		const [start, poll] = reg.tools;
		await call(start, { command: "echo done-fast" });
		const out = await call(poll, { id: "p1", wait_seconds: 10 });
		expect(out).toContain("exited");
		expect(out).toContain("done-fast");
		reg.dispose();
	});

	it("dispose kills live processes", async () => {
		const reg = mk();
		const [start, , stop] = reg.tools;
		await call(start, { command: "sleep 30" });
		reg.dispose();
		const out = await call(stop, { id: "p1" });
		expect(out).toMatch(/exited|signal/);
	});
});
