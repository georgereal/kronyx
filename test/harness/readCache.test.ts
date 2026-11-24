import { describe, expect, it } from "vitest";
import type { ToolPort, ToolResult } from "../../src/harness/contracts";
import { withReadCache } from "../../src/harness/readCache";

function countingPort(handler: (name: string, input: unknown, n: number) => ToolResult) {
	let n = 0;
	const calls: string[] = [];
	const port: ToolPort = {
		specs: () => [],
		execute: async (name, input) => {
			calls.push(name);
			return handler(name, input, ++n);
		},
	};
	return { port, calls };
}

describe("withReadCache", () => {
	it("reuses an identical read without re-executing", async () => {
		const { port } = countingPort(() => ({ ok: true, output: "file text" }));
		const cached = withReadCache(port);
		const first = await cached.execute("read_file", { path: "a.ts" });
		const second = await cached.execute("read_file", { path: "a.ts" });
		expect(first.output).toBe("file text");
		expect(second.output).toContain("file text");
		expect(second.output).toContain("cached");
	});

	it("treats list_files max_entries as irrelevant, path/recursive as significant", async () => {
		const { port, calls } = countingPort(() => ({ ok: true, output: "listing" }));
		const cached = withReadCache(port);
		await cached.execute("list_files", { path: "." });
		const hit = await cached.execute("list_files", { path: ".", max_entries: 3000 });
		expect(hit.output).toContain("cached");
		await cached.execute("list_files", { path: "src" });
		await cached.execute("list_files", { path: ".", recursive: true });
		expect(calls.filter((c) => c === "list_files")).toHaveLength(3);
	});

	it("re-executes failed calls — a retry may succeed", async () => {
		let fail = true;
		const { port } = countingPort(() => (fail ? { ok: false, output: "boom" } : { ok: true, output: "recovered" }));
		const cached = withReadCache(port);
		expect((await cached.execute("read_file", { path: "a.ts" })).ok).toBe(false);
		fail = false;
		const retry = await cached.execute("read_file", { path: "a.ts" });
		expect(retry.output).toBe("recovered");
		expect(retry.output).not.toContain("cached");
	});

	it("invalidates after a successful mutation, not a failed one", async () => {
		let version = 0;
		const { port } = countingPort((name) => (name === "write_file" ? { ok: true, output: "wrote" } : { ok: true, output: `v${version}` }));
		const cached = withReadCache(port);
		await cached.execute("read_file", { path: "a.ts" });
		version = 1;
		const stale = await cached.execute("read_file", { path: "a.ts" });
		expect(stale.output).toContain("v0"); // cached — no write ran
		await cached.execute("write_file", { path: "a.ts", content: "x" });
		expect((await cached.execute("read_file", { path: "a.ts" })).output).toBe("v1");
	});
});
