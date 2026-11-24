import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../src/harness/shellReadOnly";

describe("isReadOnlyCommand", () => {
	it("accepts plain read commands and read pipelines", () => {
		for (const cmd of [
			"cat package.json",
			"sed -n '1,40p' src/tools/mcpTools.ts",
			"grep -rn fetch src --include='*.ts'",
			"rg -l toolSet src",
			"find src -name '*.ts' | head -20",
			"ls -la src/tools/ && wc -l src/tools/*.ts",
			"head -50 README.md && tail -5 README.md",
			"jq '.dependencies' package.json",
			"cd src && ls",
			"FOO=bar grep x f.txt",
		])
			expect(isReadOnlyCommand(cmd), cmd).toBe(true);
	});

	it("accepts read-only git subcommands", () => {
		for (const cmd of ["git status", "git log --oneline -10", "git diff HEAD~1", "git ls-files", "git config --get user.name", "git show main:file.ts"])
			expect(isReadOnlyCommand(cmd), cmd).toBe(true);
	});

	it("rejects writes, mutating flags, and execution", () => {
		for (const cmd of [
			"echo hi > f.txt",
			"cat a.txt >> b.txt",
			"sed -i 's/x/y/' f.ts",
			"find . -name '*.tmp' -delete",
			"find . -exec rm {} +",
			"jq -i '.a=1' f.json",
			"git commit -m x",
			"git config user.name bob",
			"git checkout main",
			"npm test",
			"node script.js",
			"python -c 'print(1)'",
			"rm -rf dist",
			"curl https://x.com",
			"xargs rm",
			"make build",
		])
			expect(isReadOnlyCommand(cmd), cmd).toBe(false);
	});

	it("rejects command substitution and mixed read+write chains", () => {
		expect(isReadOnlyCommand("cat $(cat f.txt)")).toBe(false);
		expect(isReadOnlyCommand("cat `ls`")).toBe(false);
		expect(isReadOnlyCommand("ls && rm -rf x")).toBe(false);
		expect(isReadOnlyCommand("cat f.txt; touch g.txt")).toBe(false);
	});

	it("allows stderr redirects but not file writes", () => {
		expect(isReadOnlyCommand("cat f.txt 2>/dev/null")).toBe(true);
		expect(isReadOnlyCommand("grep x f.txt 2>&1 | head")).toBe(true);
		expect(isReadOnlyCommand("cat f.txt > out.txt")).toBe(false);
		expect(isReadOnlyCommand("cat f.txt 2> err.txt")).toBe(false);
	});

	it("rejects empty and unknown commands", () => {
		expect(isReadOnlyCommand("")).toBe(false);
		expect(isReadOnlyCommand("   ")).toBe(false);
		expect(isReadOnlyCommand("some_random_binary --flag")).toBe(false);
	});
});
