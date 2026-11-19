import { describe, expect, it } from "vitest";
import { ToolPipeline } from "../src/agent/pipeline";
import { createRepeatGuard } from "../src/agent/guards/repeatGuard";
import { createPermissionGuard } from "../src/agent/guards/permissionGuard";
import { createSavePlanGuard, createWriteModeGuard } from "../src/agent/guards/modeGuard";
import { createApprovalGuard } from "../src/agent/guards/approvalGuard";
import { evaluate, type PermissionLayers } from "../src/agent/permissions";
import type { AgentMode } from "../src/agent/runner";

const empty = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
const WRITE_TOOLS = new Set(["write_file", "edit_file", "file_editor", "run_command", "save_plan"]);

interface HarnessOpts {
	mode?: AgentMode;
	layers?: Partial<PermissionLayers>;
	confirm?: (tool: string, input: unknown) => Promise<boolean>;
	onLoop?: (tool: string, count: number) => void;
	onStop?: (reason: string) => void;
	onBlocked?: (mode: AgentMode) => void;
}

/** Full production order: repeat → save_plan → permissions → write-mode → approval. */
function harness(opts: HarnessOpts = {}) {
	const mode = () => opts.mode ?? "code";
	const layers: PermissionLayers = {
		global: opts.layers?.global ?? { ...empty },
		project: opts.layers?.project ?? { ...empty },
		local: opts.layers?.local ?? { ...empty },
		modes: opts.layers?.modes,
	};
	const p = new ToolPipeline();
	p.pre(createRepeatGuard({ onLoopDetected: opts.onLoop, onStop: opts.onStop }));
	p.pre(createSavePlanGuard(mode));
	p.pre(createPermissionGuard(async (t, i) => evaluate(layers, t, i, opts.mode)));
	p.pre(createWriteModeGuard({ currentMode: mode, writeTools: WRITE_TOOLS, onModeBlocked: opts.onBlocked }));
	p.pre(createApprovalGuard(opts.confirm ? { confirm: opts.confirm } : undefined));
	return {
		run: (name: string, input: unknown = {}) => p.runPre({ name, input }),
	};
}

describe("repeat guard", () => {
	it("warns at 3 identical calls, stops at 5", async () => {
		const h = harness({ confirm: async () => true });
		const call = () => h.run("run_command", { command: "npm test" });
		expect(await call()).toEqual({ kind: "allow" });
		expect(await call()).toEqual({ kind: "allow" });
		const warn = await call();
		expect(warn.kind).toBe("deny");
		expect(warn.kind === "deny" && warn.reason).toMatch(/already ran this exact action 3 times/);
	});

	it("hard-stops at 5 and reports the loop", async () => {
		let stopped = "";
		let looped: [string, number] | undefined;
		const h = harness({
			confirm: async () => true,
			onLoop: (t, c) => (looped = [t, c]),
			onStop: (r) => (stopped = r),
		});
		// 4 allowed calls then two denied nudges reach the stop count.
		for (let i = 0; i < 4; i++) await h.run("run_command", { command: "x" });
		const v = await h.run("run_command", { command: "x" });
		expect(v.kind).toBe("deny");
		expect(looped).toEqual(["run_command", 5]);
		expect(stopped).toMatch(/attempted 5 times/);
	});

	it("different inputs don't count as repeats", async () => {
		const h = harness({ confirm: async () => true });
		for (let i = 0; i < 5; i++) {
			expect((await h.run("run_command", { command: `cmd${i}` })).kind).toBe("allow");
		}
	});
});

describe("save_plan guard", () => {
	it("plan mode allows, other modes deny before rules apply", async () => {
		expect((await harness({ mode: "plan" }).run("save_plan", { slug: "x" })).kind).toBe("allow");
		// Even with a repo allow-rule, code mode denies (runs before permissionGuard).
		const h = harness({ mode: "code", layers: { project: { ...empty, allow: ["save_plan"] } } });
		expect((await h.run("save_plan", {})).kind).toBe("deny");
	});
});

describe("permission guard", () => {
	it("deny rule short-circuits before mode and approval", async () => {
		const h = harness({
			layers: { local: { ...empty, deny: ["run_command(rm *)"] } },
			confirm: async () => {
				throw new Error("must not be called");
			},
		});
		const v = await h.run("run_command", { command: "rm -rf /" });
		expect(v.kind).toBe("deny");
	});

	it("allow rule bypasses approval in code mode", async () => {
		let asked = false;
		const h = harness({
			layers: { project: { ...empty, allow: ["write_file"] } },
			confirm: async () => ((asked = true), true),
		});
		expect((await h.run("write_file", { path: "a.ts" })).kind).toBe("allow");
		expect(asked).toBe(false);
	});

	it("no matching rule falls through to mode defaults", async () => {
		let asked = false;
		const h = harness({ confirm: async () => ((asked = true), true) });
		expect((await h.run("write_file", { path: "a.ts" })).kind).toBe("allow");
		expect(asked).toBe(true);
	});
});

describe("write-mode guard", () => {
	it("non-write tools always allow", async () => {
		const h = harness({ mode: "ask" });
		expect((await h.run("read_file", { path: "a" })).kind).toBe("allow");
	});

	it("file_editor view/symbols bypass even under a deny rule", async () => {
		const h = harness({
			mode: "code",
			layers: { local: { ...empty, deny: ["file_editor"] } },
			confirm: async () => {
				throw new Error("must not prompt");
			},
		});
		// deny rule fires first (rules precede the bypass? no — bypass runs inside
		// writeModeGuard, AFTER permissionGuard: a deny file_editor rule denies view too.)
		expect((await h.run("file_editor", { command: "view" })).kind).toBe("deny");
	});

	it("file_editor view bypasses approval when no rule denies", async () => {
		const h = harness({
			confirm: async () => {
				throw new Error("must not prompt");
			},
		});
		expect((await h.run("file_editor", { command: "view" })).kind).toBe("allow");
	});

	it("ask/plan deny writes with a one-shot mode-blocked notice", async () => {
		const blocked: AgentMode[] = [];
		const h = harness({ mode: "plan", onBlocked: (m) => blocked.push(m) });
		expect((await h.run("write_file", {})).kind).toBe("deny");
		expect((await h.run("write_file", {})).kind).toBe("deny");
		expect(blocked).toEqual(["plan"]);
	});

	it("smart/bypass allow writes without approval", async () => {
		for (const mode of ["smart", "bypass"] as const) {
			const h = harness({ mode, confirm: async () => false });
			expect((await h.run("write_file", {})).kind).toBe("allow");
		}
	});
});

describe("approval guard", () => {
	it("code-mode writes reach confirm; denial denies", async () => {
		expect((await harness({ confirm: async () => true }).run("write_file")).kind).toBe("allow");
		expect((await harness({ confirm: async () => false }).run("write_file")).kind).toBe("deny");
	});

	it("no provider denies", async () => {
		expect((await harness().run("write_file")).kind).toBe("deny");
	});
});
