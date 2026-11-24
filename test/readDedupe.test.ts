import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileTools } from "../src/tools/fileTools";

const ctx = (iteration: number, toolCallId: string) => ({ agentId: "a", iteration, toolCallId }) as any;

async function setup() {
	const root = await mkdtemp(path.join(tmpdir(), "kronyx-dedupe-"));
	await writeFile(path.join(root, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
	const readFile = createFileTools({ root }).find((t) => t.name === "read_file")!;
	const writeFileTool = createFileTools({ root }).find((t) => t.name === "write_file")!;
	return { root, readFile, writeFileTool };
}

describe("read_file dedupe", () => {
	it("returns a pointer for an unchanged re-read shortly after the original", async () => {
		const { readFile } = await setup();
		const first = await readFile.execute({ path: "a.ts" }, ctx(1, "c1"));
		const second = await readFile.execute({ path: "a.ts" }, ctx(2, "c2"));
		expect(first).toContain("1| export const a = 1;");
		expect(second).toContain('toolCallId "c1"');
		expect(second).not.toContain("| export");
	});

	it("returns full content again after the file changes", async () => {
		const { root, readFile, writeFileTool } = await setup();
		await readFile.execute({ path: "a.ts" }, ctx(1, "c1"));
		await writeFileTool.execute({ path: "a.ts", content: "export const a = 9;\n" }, ctx(2, "w1"));
		const after = await readFile.execute({ path: "a.ts" }, ctx(3, "c3"));
		expect(after).toContain("1| export const a = 9;");
		expect(root).toBeTruthy();
	});

	it("returns full content when the earlier read is outside the window", async () => {
		const { readFile } = await setup();
		await readFile.execute({ path: "a.ts" }, ctx(1, "c1"));
		const later = await readFile.execute({ path: "a.ts" }, ctx(20, "c2"));
		expect(later).toContain("1| export const a = 1;");
	});

	it("keys by range, so a different slice is never deduplicated", async () => {
		const { readFile } = await setup();
		await readFile.execute({ path: "a.ts", start_line: 1, end_line: 1 }, ctx(1, "c1"));
		const other = await readFile.execute({ path: "a.ts", start_line: 2, end_line: 2 }, ctx(2, "c2"));
		expect(other).toContain("2| export const b = 2;");
	});
});
