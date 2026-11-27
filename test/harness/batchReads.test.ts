import { describe, expect, it } from "vitest";
import type { ToolPort, ToolResult, ToolSpec } from "../../src/harness/core/contracts";
import { READ_FILES, withBatchReads } from "../../src/harness/tools/batchReads";

const readSpec: ToolSpec = { name: "read_file", description: "read one", inputSchema: {}, parallel: true };

function basePort(handler?: (name: string, input: unknown) => ToolResult) {
	const calls: Array<{ name: string; input: unknown }> = [];
	const port: ToolPort = {
		specs: () => [readSpec],
		execute: async (name, input) => {
			calls.push({ name, input });
			return handler ? handler(name, input) : { ok: true, output: `contents of ${(input as { path: string }).path}` };
		},
	};
	return { port, calls };
}

describe("read_files batch tool", () => {
	it("is offered only when read_file is, and fans out per file", async () => {
		const { port, calls } = basePort();
		const wrapped = withBatchReads(port);
		expect(wrapped.specs().map((s) => s.name)).toContain(READ_FILES);
		const result = await wrapped.execute(READ_FILES, { files: [{ path: "a.ts" }, { path: "b.ts", start_line: 3 }] });
		expect(result.ok).toBe(true);
		expect(calls).toEqual([
			{ name: "read_file", input: { path: "a.ts" } },
			{ name: "read_file", input: { path: "b.ts", start_line: 3 } },
		]);
		expect(result.output).toContain("### a.ts");
		expect(result.output).toContain("### b.ts");
	});

	it("is not offered when the base port has no read_file", async () => {
		const port: ToolPort = { specs: () => [{ name: "write_file", description: "", inputSchema: {} }], execute: async () => ({ ok: true, output: "" }) };
		const wrapped = withBatchReads(port);
		expect(wrapped.specs().map((s) => s.name)).not.toContain(READ_FILES);
		const result = await wrapped.execute(READ_FILES, { files: [{ path: "a" }] });
		expect(result.ok).toBe(false);
	});

	it("passes other tools through untouched", async () => {
		const { port, calls } = basePort(() => ({ ok: true, output: "w" }));
		const wrapped = withBatchReads(port);
		await wrapped.execute("read_file", { path: "solo.ts" });
		expect(calls).toEqual([{ name: "read_file", input: { path: "solo.ts" } }]);
	});

	it("rejects malformed input and caps the file count", async () => {
		const { port, calls } = basePort();
		const wrapped = withBatchReads(port);
		expect((await wrapped.execute(READ_FILES, {})).ok).toBe(false);
		expect((await wrapped.execute(READ_FILES, { files: [{}, { path: 7 }] })).ok).toBe(false);
		const many = await wrapped.execute(READ_FILES, { files: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}` })) });
		expect(many.ok).toBe(true);
		expect(calls.length).toBe(8);
	});

	it("reports per-file failures inline and marks the result not ok", async () => {
		const { port } = basePort((name, input) => ((input as { path: string }).path === "bad" ? { ok: false, output: "missing" } : { ok: true, output: "fine" }));
		const wrapped = withBatchReads(port);
		const result = await wrapped.execute(READ_FILES, { files: [{ path: "good" }, { path: "bad" }] });
		expect(result.ok).toBe(false);
		expect(result.output).toContain("(failed)");
		expect(result.output).toContain("missing");
	});
});
