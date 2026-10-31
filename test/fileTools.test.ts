import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileTools, globToRegExp } from "../src/tools/fileTools";

const ctx = { agentId: "test", iteration: 1 } as AgentToolContext;

let root: string;
let tools: Map<string, AgentTool<any, string>>;
let changes: string[];

const run = (name: string, input: unknown) => Promise.resolve(tools.get(name)!.execute(input, ctx));
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "kronyx-tools-"));
	changes = [];
	tools = new Map(
		createFileTools({ root, onFileChanged: (abs, kind) => changes.push(`${kind}:${path.basename(abs)}`) }).map((t) => [
			t.name,
			t,
		]),
	);
	writeFileSync(path.join(root, "a.ts"), "export function add(a, b) {\n  return a + b;\n}\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("read_file", () => {
	it("returns numbered lines", async () => {
		const out = await run("read_file", { path: "a.ts" });
		expect(out).toContain("lines 1-3 of 3");
		expect(out).toContain("2|   return a + b;");
	});

	it("supports ranges", async () => {
		const out = await run("read_file", { path: "a.ts", start_line: 2, end_line: 2 });
		expect(out).toContain("lines 2-2 of 3");
		expect(out).not.toContain("export");
	});

	it("rejects paths outside the workspace", async () => {
		await expect(run("read_file", { path: "../etc/passwd" })).rejects.toThrow(/outside the workspace/);
	});

	it("rejects symlinks escaping the workspace", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "kronyx-outside-"));
		writeFileSync(path.join(outside, "secret.txt"), "x");
		symlinkSync(outside, path.join(root, "link"));
		await expect(run("read_file", { path: "link/secret.txt" })).rejects.toThrow(/outside the workspace/);
		rmSync(outside, { recursive: true, force: true });
	});
});

describe("write_file and append_file", () => {
	it("creates nested files", async () => {
		await run("write_file", { path: "src/new.ts", content: "x\n" });
		expect(read("src/new.ts")).toBe("x\n");
		expect(changes).toEqual(["created:new.ts"]);
	});

	it("appends with a separating newline", async () => {
		writeFileSync(path.join(root, "log.txt"), "one");
		await run("append_file", { path: "log.txt", content: "two\n" });
		expect(read("log.txt")).toBe("one\ntwo\n");
	});

	it("refuses to touch dirty editor files", async () => {
		const guarded = createFileTools({ root, isDirty: () => true }).find((t) => t.name === "write_file")!;
		await expect(Promise.resolve(guarded.execute({ path: "a.ts", content: "" }, ctx))).rejects.toThrow(/unsaved/);
	});
});

describe("edit_file", () => {
	it("applies exact edits", async () => {
		await run("edit_file", { path: "a.ts", edits: [{ old_text: "return a + b;", new_text: "return a - b;" }] });
		expect(read("a.ts")).toContain("return a - b;");
	});

	it("tolerates wrong indentation and keeps the file's indentation", async () => {
		await run("edit_file", {
			path: "a.ts",
			edits: [{ old_text: "    return a + b;\n  }", new_text: "    const s = a + b;\n    return s;\n  }" }],
		});
		expect(read("a.ts")).toBe("export function add(a, b) {\n  const s = a + b;\n  return s;\n}\n");
	});

	it("is all-or-nothing", async () => {
		await expect(
			run("edit_file", {
				path: "a.ts",
				edits: [
					{ old_text: "return a + b;", new_text: "return 0;" },
					{ old_text: "missing", new_text: "x" },
				],
			}),
		).rejects.toThrow(/Edit 2/);
		expect(read("a.ts")).toContain("return a + b;");
	});

	it("rejects ambiguous matches unless replace_all", async () => {
		writeFileSync(path.join(root, "b.txt"), "x = 1\ny = 2\nx = 1\n");
		await expect(run("edit_file", { path: "b.txt", edits: [{ old_text: "x = 1", new_text: "x = 3" }] })).rejects.toThrow(
			/matches 2 places \(lines 1, 3\)/,
		);
		await run("edit_file", { path: "b.txt", edits: [{ old_text: "x = 1", new_text: "x = 3", replace_all: true }] });
		expect(read("b.txt")).toBe("x = 3\ny = 2\nx = 3\n");
	});

	it("suggests the closest text when nothing matches", async () => {
		await expect(
			run("edit_file", { path: "a.ts", edits: [{ old_text: "return a + c;", new_text: "x" }] }),
		).rejects.toThrow(/most similar text[\s\S]*2\|   return a \+ b;/);
	});

	it("preserves CRLF line endings", async () => {
		writeFileSync(path.join(root, "w.txt"), "one\r\ntwo\r\n");
		await run("edit_file", { path: "w.txt", edits: [{ old_text: "two", new_text: "three\nfour" }] });
		expect(read("w.txt")).toBe("one\r\nthree\r\nfour\r\n");
	});
});

describe("insert_lines", () => {
	it("inserts before a line", async () => {
		await run("insert_lines", { path: "a.ts", line: 1, content: "// header" });
		expect(read("a.ts").split("\n")[0]).toBe("// header");
	});

	it("appends at end with line = count + 1", async () => {
		await run("insert_lines", { path: "a.ts", line: 4, content: "// end" });
		expect(read("a.ts").endsWith("}\n// end\n")).toBe(true);
	});
});

describe("list_files and search_files", () => {
	it("lists recursively and skips ignored folders", async () => {
		await run("write_file", { path: "src/x.ts", content: "needle\n" });
		await run("write_file", { path: "node_modules/pkg/i.js", content: "needle\n" });
		const out = await run("list_files", { recursive: true });
		expect(out.split("\n")).toEqual(["a.ts", "src/", "src/x.ts"]);
	});

	it("searches with glob filters", async () => {
		await run("write_file", { path: "src/x.ts", content: "const needle = 1;\n" });
		await run("write_file", { path: "notes.md", content: "needle\n" });
		expect(await run("search_files", { pattern: "needle", file_glob: "**/*.ts" })).toBe("src/x.ts:1: const needle = 1;");
	});

	it("converts globs", () => {
		expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
		expect(globToRegExp("**/*.ts").test("c.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
	});
});
