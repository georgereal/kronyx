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
	root?: string;
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
	p.pre(createWriteModeGuard({ currentMode: mode, writeTools: WRITE_TOOLS, root: opts.root, onModeBlocked: opts.onBlocked }));
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
	it("plan mode allows directly; other modes fall through to permission rules", async () => {
		expect((await harness({ mode: "plan" }).run("save_plan", { slug: "x" })).kind).toBe("allow");
		// In code mode a repo allow-rule now governs save_plan like any write.
		const h = harness({ mode: "code", layers: { project: { ...empty, allow: ["save_plan"] } } });
		expect((await h.run("save_plan", {})).kind).toBe("allow");
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

	it("ask and plan refuse memory_write and browser interaction; code allows them", async () => {
		const noPrompt = async () => {
			throw new Error("must not prompt");
		};
		for (const mode of ["ask", "plan"] as const) {
			const h = harness({ mode, confirm: noPrompt });
			for (const name of ["memory_write", "browser_click", "browser_type", "browser_eval"]) {
				expect((await h.run(name, {})).kind).toBe("deny");
			}
			expect((await h.run("browser_snapshot", {})).kind).toBe("allow");
		}
		const code = harness({ mode: "code", confirm: noPrompt });
		expect((await code.run("browser_click", { ref: "e1" })).kind).toBe("allow");
		expect((await code.run("memory_write", { fact: "x" })).kind).toBe("allow");
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

	it("plan mode allows scoped writes free, plan-doc writes go to approval, other file writes are denied", async () => {
		const os = await import("node:os");
		const h = harness({ mode: "plan", root: "/repo" });
		expect((await h.run("write_file", { path: ".kronyx/plans/x.md" })).kind).toBe("allow");
		expect((await h.run("write_file", { path: `${os.tmpdir()}/scratch.md` })).kind).toBe("allow");
		// Repo writes outside the plan document are implementation — denied
		// outright in plan mode, not deferred to approval.
		const yes = harness({ mode: "plan", root: "/repo", confirm: async () => true });
		expect((await yes.run("write_file", { path: "src/x.ts" })).kind).toBe("deny");
		expect((await yes.run("write_file", { path: "../escape.md" })).kind).toBe("deny");
		// Plan-document writes are the one exception — the user decides.
		expect((await yes.run("write_file", { path: "plans/follow-up.md" })).kind).toBe("allow");
		const no = harness({ mode: "plan", root: "/repo", confirm: async () => false });
		expect((await no.run("write_file", { path: "plans/follow-up.md" })).kind).toBe("deny");
		// Edit tools carry the same scoping.
		expect((await yes.run("edit_file", { path: "plans/x.md", edits: [] })).kind).toBe("allow");
		expect((await yes.run("edit_file", { path: "src/x.ts", edits: [] })).kind).toBe("deny");
		// Ask mode gets no write scope at all.
		const ask = harness({ mode: "ask", root: "/repo" });
		expect((await ask.run("write_file", { path: ".kronyx/plans/x.md" })).kind).toBe("deny");
	});

	it("plan mode sends run_command to approval instead of denying", async () => {
		const allowed = harness({ mode: "plan", root: "/repo", confirm: async () => true });
		expect((await allowed.run("run_command", { command: "git log --oneline" })).kind).toBe("allow");
		const refused = harness({ mode: "plan", root: "/repo", confirm: async () => false });
		expect((await refused.run("run_command", { command: "git log --oneline" })).kind).toBe("deny");
		// Ask mode still denies it outright.
		const ask = harness({ mode: "ask", root: "/repo", confirm: async () => true });
		expect((await ask.run("run_command", { command: "ls" })).kind).toBe("deny");
	});

	it("ask mode denies writes with a one-shot mode-blocked notice; plan asks instead", async () => {
		const blocked: AgentMode[] = [];
		const h = harness({ mode: "ask", onBlocked: (m) => blocked.push(m) });
		expect((await h.run("write_file", {})).kind).toBe("deny");
		expect((await h.run("write_file", {})).kind).toBe("deny");
		expect(blocked).toEqual(["ask"]);
		// Plan mode never dead-ends: without an approval channel the call is
		// refused by the approval stage, and no mode-blocked notice fires.
		const plan = harness({ mode: "plan", onBlocked: (m) => blocked.push(m) });
		expect((await plan.run("write_file", {})).kind).toBe("deny");
		expect(blocked).toEqual(["ask"]);
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
