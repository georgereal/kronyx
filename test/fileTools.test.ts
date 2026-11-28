import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	it("withholds secret-file contents but lists key names", async () => {
		writeFileSync(path.join(root, ".env.local"), "MONGODB_URI=mongodb+srv://user:pass@x\nAPI_KEY=sk-abc123\n");
		const out = await run("read_file", { path: ".env.local" });
		expect(out).toContain("withheld");
		expect(out).toContain("MONGODB_URI");
		expect(out).not.toContain("mongodb+srv");
		expect(out).not.toContain("sk-abc123");
	});

	it("withholds service-account JSON values", async () => {
		writeFileSync(path.join(root, "svc-service-account.json"), JSON.stringify({ private_key: "-----BEGIN KEY-----", client_email: "a@b.c" }));
		const out = await run("read_file", { path: "svc-service-account.json" });
		expect(out).toContain("withheld");
		expect(out).toContain("private_key");
		expect(out).not.toContain("BEGIN KEY");
	});

	it("treats gitignored files as sensitive across read, editor view and search", async () => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(path.join(root, ".gitignore"), "notes.local.txt\nprivate/\n");
		writeFileSync(path.join(root, "notes.local.txt"), "TOKEN_VALUE_XYZ=hunter2hunter2\n");
		mkdirSync(path.join(root, "private"));
		writeFileSync(path.join(root, "private", "keys.txt"), "TOKEN_VALUE_XYZ=hunter2hunter2\n");
		expect(await run("read_file", { path: "notes.local.txt" })).toContain("gitignored");
		expect(await run("read_file", { path: "private/keys.txt" })).not.toContain("hunter2");
		expect(await run("file_editor", { command: "view", path: "notes.local.txt" })).not.toContain("hunter2");
		const hits = await run("search_files", { pattern: "hunter2" });
		expect(hits).toBe("No matches.");
	});

	it("does not treat vendored dependencies as sensitive", async () => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
		mkdirSync(path.join(root, "node_modules", "lib"), { recursive: true });
		writeFileSync(path.join(root, "node_modules", "lib", "index.js"), "export const version = 2;\n");
		expect(await run("read_file", { path: "node_modules/lib/index.js" })).toContain("export const version = 2;");
	});

	it("supports ranges", async () => {
		const out = await run("read_file", { path: "a.ts", start_line: 2, end_line: 2 });
		expect(out).toContain("lines 2-2 of 3");
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

describe("file-changed diff payload", () => {
	it("carries numbered context lines and +/- counts for an edit", async () => {
		const stats: { added: number; removed: number; diff: string }[] = [];
		const withStats = new Map(
			createFileTools({ root, onFileChanged: (_abs, _kind, s) => s && stats.push(s) }).map((t) => [t.name, t]),
		);
		await withStats.get("edit_file")!.execute(
			{ path: "a.ts", edits: [{ old_text: "return a + b;", new_text: "return a - b;" }] },
			ctx,
		);
		expect(stats).toHaveLength(1);
		expect(stats[0]).toMatchObject({ added: 1, removed: 1 });
		expect(stats[0].diff).toContain("@@ -1,3 +1,3 @@");
		expect(stats[0].diff).toContain("-  return a + b;");
		expect(stats[0].diff).toContain("+  return a - b;");
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

	it("hints at recursion when a flat listing contains folders", async () => {
		await run("write_file", { path: "src/x.ts", content: "" });
		const flat = await run("list_files", {});
		expect(flat).toContain("src/");
		expect(flat).toContain("non-recursive; pass recursive: true");
		const full = await run("list_files", { recursive: true });
		expect(full).not.toContain("non-recursive");
	});

	it("searches with glob filters", async () => {
		await run("write_file", { path: "src/x.ts", content: "const needle = 1;\n" });
		await run("write_file", { path: "notes.md", content: "needle\n" });
		expect(await run("search_files", { pattern: "needle", file_glob: "**/*.ts" })).toBe("src/x.ts:1: const needle = 1;");
	});

	it("tolerates a file path and an empty path", async () => {
		await run("write_file", { path: "src/x.ts", content: "const needle = 1;\n" });
		// Models regularly pass a file where a folder is expected — search it.
		expect(await run("search_files", { pattern: "needle", path: "src/x.ts" })).toBe("src/x.ts:1: const needle = 1;");
		// And an empty path means the root, not an error.
		expect(await run("search_files", { pattern: "needle", path: "" })).toBe("src/x.ts:1: const needle = 1;");
		expect(await run("list_files", { path: "" })).toContain("src/");
	});

	it("reports a failing command as a failed call with its output", async () => {
		await expect(run("run_command", { command: "echo broke; exit 3" })).rejects.toThrow(/exit 3[\s\S]*broke/);
	});

	it("fails a pipeline when an early stage fails, not just the last one", async () => {
		await expect(run("run_command", { command: "false | tail -1" })).rejects.toThrow(/exit 1/);
	});

	it("reports a passing command as exit 0 with its output", async () => {
		expect(await run("run_command", { command: "echo hi" })).toBe("exit 0\nhi");
	});

	it("converts globs", () => {
		expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
		expect(globToRegExp("**/*.ts").test("c.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
	});
});

describe("file_editor edit_file-shape tolerance", () => {
	it("applies an edits array when command is missing — the schema mix case", async () => {
		const out = await run("file_editor", {
			path: "a.ts",
			edits: [{ old_text: "return a + b;", new_text: "return a * b;" }],
		});
		expect(out).toContain("Edited a.ts");
		expect(read("a.ts")).toContain("return a * b;");
	});

	it("accepts edits as a JSON string — models sometimes serialize arrays", async () => {
		const out = await run("file_editor", {
			path: "a.ts",
			edits: JSON.stringify([{ old_str: "add(a, b)", new_str: "add(a, b, c)" }]),
		});
		expect(out).toContain("Edited a.ts");
		expect(read("a.ts")).toContain("add(a, b, c)");
	});

	it("missing command without edits errors with a teaching message", async () => {
		await expect(run("file_editor", { path: "a.ts" })).rejects.toThrow(/needs a command/);
	});
});
