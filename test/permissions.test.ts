import { describe, expect, it } from "vitest";
import { evaluate, parsePermissions, parsePermissionsText, ruleFor, ruleTarget, type PermissionLayers } from "../src/agent/permissions";

const empty = { allow: [], ask: [], deny: [] };
const layers = (p: Partial<PermissionLayers> = {}): PermissionLayers => ({
	global: p.global ?? { ...empty },
	project: p.project ?? { ...empty },
	local: p.local ?? { ...empty },
});

describe("parsePermissions", () => {
	it("reads allow/ask/deny lists and tolerates noise", () => {
		const r = parsePermissions({ permissions: { allow: ["read_file", 42, ""], deny: ["run_command(rm *)"], extra: true } });
		expect(r.allow).toEqual(["read_file"]);
		expect(r.deny).toEqual(["run_command(rm *)"]);
		expect(r.ask).toEqual([]);
	});
	it("returns empty rules for garbage", () => {
		expect(parsePermissionsText("not json")).toEqual(empty);
		expect(parsePermissions(null)).toEqual(empty);
	});
});

describe("ruleTarget", () => {
	it("uses command for run_command, path for file tools", () => {
		expect(ruleTarget("run_command", { command: "npm test" })).toBe("npm test");
		expect(ruleTarget("write_file", { path: "src/a.ts" })).toBe("src/a.ts");
		expect(ruleTarget("browser_use", { url: "http://x" })).toBe("http://x");
	});
});

describe("evaluate", () => {
	it("matches whole-tool rules", () => {
		const l = layers({ project: { ...empty, allow: ["read_file"] } });
		expect(evaluate(l, "read_file", { path: "a.ts" })).toBe("allow");
		expect(evaluate(l, "write_file", { path: "a.ts" })).toBeUndefined();
	});

	it("matches tool(glob) against the target", () => {
		const l = layers({ project: { ...empty, allow: ["run_command(npm run *)", "write_file(src/**)"] } });
		expect(evaluate(l, "run_command", { command: "npm run build" })).toBe("allow");
		expect(evaluate(l, "run_command", { command: "npm install x" })).toBeUndefined();
		expect(evaluate(l, "write_file", { path: "src/deep/a.ts" })).toBe("allow");
		expect(evaluate(l, "write_file", { path: ".env" })).toBeUndefined();
	});

	it("single * does not cross path separators, ** does", () => {
		const l = layers({ project: { ...empty, allow: ["write_file(src/*.ts)"] } });
		expect(evaluate(l, "write_file", { path: "src/a.ts" })).toBe("allow");
		expect(evaluate(l, "write_file", { path: "src/deep/a.ts" })).toBeUndefined();
	});

	it("global deny is a floor — local/project allow cannot override it", () => {
		const l = layers({
			global: { ...empty, deny: ["run_command(rm -rf *)"] },
			project: { ...empty, allow: ["run_command(*)"] },
			local: { ...empty, allow: ["run_command(rm -rf *)"] },
		});
		expect(evaluate(l, "run_command", { command: "rm -rf /tmp/x" })).toBe("deny");
	});

	it("local allow overrides a committed project deny", () => {
		const l = layers({
			project: { ...empty, deny: ["run_command(git push *)"] },
			local: { ...empty, allow: ["run_command(git push *)"] },
		});
		expect(evaluate(l, "run_command", { command: "git push origin x" })).toBe("allow");
	});

	it("project rules beat global non-deny rules", () => {
		const l = layers({
			global: { ...empty, allow: ["run_command(curl *)"] },
			project: { ...empty, ask: ["run_command(curl *)"] },
		});
		expect(evaluate(l, "run_command", { command: "curl x" })).toBe("ask");
	});

	it("within a layer deny beats allow beats ask", () => {
		const l = layers({ project: { allow: ["write_file(**)"], ask: ["write_file(*.env)"], deny: ["write_file(.env)"] } });
		expect(evaluate(l, "write_file", { path: ".env" })).toBe("deny");
		expect(evaluate(l, "write_file", { path: "prod.env" })).toBe("allow"); // allow wins over ask
		expect(evaluate(l, "write_file", { path: "src/x.ts" })).toBe("allow");
	});

	it("returns undefined with no matching rule", () => {
		expect(evaluate(layers(), "run_command", { command: "ls" })).toBeUndefined();
	});
});

describe("ruleFor", () => {
	it("produces the narrowest rule for the call", () => {
		expect(ruleFor("run_command", { command: "npm run build" })).toBe("run_command(npm run build)");
		expect(ruleFor("write_file", { path: "src/app.py" })).toBe("write_file(src/app.py)");
		expect(ruleFor("memory_write", { fact: "x" })).toBe("memory_write");
	});
});
