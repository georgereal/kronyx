import { describe, expect, it } from "vitest";
import { implementationIntent, parsePlanSeed, planSeedTasks } from "../../src/harness/planning/planSeed";

const THREADESTIMATOR = `# ThreadEstimator — Development Plan

## Phase 0 — Project Hygiene
| Step | What | Files |
| --- | --- | --- |
| 0.1 | Initialize git repo, add .gitignore (IDE, OS, build artefacts) | .gitignore |
| 0.2 | Add a concise README.md — purpose, usage example, prerequisites | README.md |
| 0.3 | Run \`mvn clean compile\` end-to-end to prove baseline compiles | — |

## Phase 1 — Configuration Extraction
| Step | What | Files |
| --- | --- | --- |
| 1.1 | Create Config.java in com.threadestimator holding constants | Config.java |
| 1.2 | Replace the literal path in ExcelReader.read() with Config.DEFAULT_INPUT | ExcelReader.java |

## Backlog / Future Enhancements (out of scope for this plan)
| 9.1 | Thread count calculation support | Calculator.java |
| 9.2 | Output CSV writer | Writer.java |

## Verification
- \`mvn clean compile\` passes for all phases
`;

describe("plan seed parser", () => {
	it("parses phased table plans into one task per phase with steps exactly as written", () => {
		const r = parsePlanSeed(THREADESTIMATOR);
		expect(r?.tasks.map((t) => t.title)).toEqual(["Project Hygiene", "Configuration Extraction"]);
		expect(r?.tasks[0]?.steps).toEqual([
			"Initialize git repo, add .gitignore (IDE, OS, build artefacts)",
			"Add a concise README.md — purpose, usage example, prerequisites",
			"Run `mvn clean compile` end-to-end to prove baseline compiles",
		]);
	});

	it("excludes backlog/out-of-scope sections from steps entirely", () => {
		const r = parsePlanSeed(THREADESTIMATOR);
		const all = r?.tasks.flatMap((t) => t.steps).join(" ") ?? "";
		expect(all).not.toContain("Thread count calculation");
		expect(all).not.toContain("Output CSV writer");
		expect(r?.tasks.some((t) => /backlog|future/i.test(t.title))).toBe(false);
	});

	it("extracts per-phase verify commands and doc-level gates the final task", () => {
		const r = parsePlanSeed(THREADESTIMATOR);
		expect(r?.tasks[0]?.verify).toBe("mvn clean compile");
		// Phase 1 has no command of its own — the doc-level verification gates it.
		expect(r?.tasks[1]?.verify).toBe("mvn clean compile");
	});

	it("skips table header and separator rows", () => {
		const r = parsePlanSeed(THREADESTIMATOR);
		const first = r?.tasks[0]?.steps ?? [];
		expect(first.some((s) => /^\s*-+\s*$/.test(s) || s === "What")).toBe(false);
	});

	it("flat numbered-list plans still parse to a single task", () => {
		const r = parsePlanSeed("# Plan: X\n\n## Steps\n1. Edit src/a.ts to add the flag\n2. Run the tests\n");
		expect(r?.tasks).toHaveLength(1);
		expect(r?.tasks[0]?.steps).toEqual(["Edit src/a.ts to add the flag", "Run the tests"]);
	});

	it("checkbox steps parse", () => {
		const r = parsePlanSeed("# Plan\n\n## Actions\n- [ ] Wire the config loader into startup\n- [x] Already done item stays a step\n");
		expect(r?.tasks[0]?.steps.length).toBe(2);
	});

	it("unparseable docs produce no seed", () => {
		expect(parsePlanSeed("# Notes\n\nJust prose about the architecture, no steps at all.\n")).toBeUndefined();
	});

	it("verify-headed phase names are not excluded as verification sections", () => {
		const md = "# Plan\n\n## Phase 1 — Input Validation & Parsing\n| 1.1 | Add defensive parsing to the reader | R.java |\n\n## Phase 2 — Unit Tests for Core Logic\n| 2.1 | Write tests for the parsing module | T.java |\n";
		const r = parsePlanSeed(md);
		expect(r?.tasks.map((t) => t.title)).toEqual(["Input Validation & Parsing", "Unit Tests for Core Logic"]);
	});

	it("planSeedTasks emits one SeedTask per phase with command acceptance", () => {
		const r = planSeedTasks("plans/x.md", THREADESTIMATOR);
		expect("seed" in r && r.seed).toHaveLength(2);
		expect("seed" in r && r.seed[0]?.acceptance).toEqual({ kind: "command", command: "mvn clean compile" });
	});

	it("unparseable implement-intent docs hard-fail with structural guidance", () => {
		const r = planSeedTasks("plans/y.md", "# Plan\n\nno steps here\n");
		expect("error" in r && r.error).toContain("numbered steps");
		expect("error" in r && r.error).toContain("Phase N");
	});
});

describe("implementation intent detection", () => {
	it.each([
		["lets build as per @plans/x.md", "plans/x.md"],
		["implement plans/x.md", "plans/x.md"],
		["implement @plans/x.md", "plans/x.md"],
		["follow the steps in plans/x.md", "plans/x.md"],
		["execute plans/x.md", "plans/x.md"],
		["build according to plans/x.md", "plans/x.md"],
	])("implementation phrasing %s yields the doc path", (task, want) => {
		expect(implementationIntent(task)).toBe(want);
	});

	it.each([
		"check compliance with SECURITY.md",
		"summarize NOTES.md",
		"use the conventions in contributing.md",
		"fix the login bug",
		"what does x.md say?",
		"update README.md to mention the new flag",
	])("reference phrasing never triggers seeding: %s", (task) => {
		expect(implementationIntent(task)).toBeUndefined();
	});

	it("non-markdown attachments never match", () => {
		expect(implementationIntent("implement @src/app.ts")).toBeUndefined();
		expect(implementationIntent("build using @image.png as reference")).toBeUndefined();
	});
});

describe("harness internal-step notes", () => {
	it("pre-loop notes land as durable steer.note events ahead of the user input", async () => {
		const { MemoryEventLog } = await import("../../src/harness/core/eventLog");
		const { HarnessLoop } = await import("../../src/harness/core/loop");
		const log = new MemoryEventLog(() => 1);
		const model = {
			complete: async () => ({ text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }),
		};
		const tools = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };
		const loop = new HarnessLoop({ runId: "r1", log, model: model as never, tools: tools as never });
		await loop.run("hi", undefined, undefined, {
			notes: ["Read AGENTS.md (1234 chars) — repo guide is in this run's context.", "Read plans/x.md — parsed 6 phases (23 steps). The document is the scope; no planner call this run."],
		});
		const events = await log.read();
		const notes = events.filter((e) => e.type === "steer.note");
		expect(notes).toHaveLength(2);
		expect((notes[0] as { text: string }).text).toContain("Read AGENTS.md");
		expect((notes[1] as { text: string }).text).toContain("Read plans/x.md");
		expect((notes[0] as { rule: string }).rule).toBe("harness.step");
		// Notes follow the user input — inside the run's timeline, where the user
		// actually sees them, not floating above their own message.
		expect(events.findIndex((e) => e.type === "steer.note")).toBeGreaterThan(events.findIndex((e) => e.type === "user.input"));
	});

	it("runs without notes emit none", async () => {
		const { MemoryEventLog } = await import("../../src/harness/core/eventLog");
		const { HarnessLoop } = await import("../../src/harness/core/loop");
		const log = new MemoryEventLog(() => 1);
		const model = {
			complete: async () => ({ text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }),
		};
		const tools = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };
		const loop = new HarnessLoop({ runId: "r1", log, model: model as never, tools: tools as never });
		await loop.run("hi");
		const events = await log.read();
		expect(events.filter((e) => e.type === "steer.note" && (e as { rule: string }).rule === "harness.step")).toHaveLength(0);
	});
});

describe("seeded board structure", () => {
	it("chains seeded tasks so phases run one at a time, not all at once", async () => {
		const { MemoryEventLog } = await import("../../src/harness/core/eventLog");
		const { HarnessLoop } = await import("../../src/harness/core/loop");
		const { project } = await import("../../src/harness/core/projections");
		const log = new MemoryEventLog(() => 1);
		const model = {
			complete: async () => ({ text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }),
		};
		const tools = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };
		const loop = new HarnessLoop({ runId: "r1", log, model: model as never, tools: tools as never });
		await loop.run("implement x", undefined, undefined, {
			seed: [
				{ title: "Phase A", steps: ["first step of phase a"] },
				{ title: "Phase B", steps: ["first step of phase b"] },
				{ title: "Phase C", steps: ["first step of phase c"] },
			],
		});
		const state = project(await log.read());
		// Sequential chain: each phase waits on the previous one.
		expect(state.ledger.tasks.t2?.dependsOn).toEqual(["t1"]);
		expect(state.ledger.tasks.t3?.dependsOn).toEqual(["t2"]);
		// Only the first phase may be active — later phases stay pending.
		const statuses = events_statuses(state);
		expect(statuses.filter((s) => s === "in_progress")).toHaveLength(0); // run ended unfinished; nothing left mid-flight
		const created = state.ledger.tasks;
		expect(created.t1).toBeDefined();
	});

	function events_statuses(state: { ledger: { tasks: Record<string, { status: string }> } }): string[] {
		return Object.values(state.ledger.tasks).map((t) => t.status);
	}

	it("the seed note names task_step_update so the model knows how to close steps", async () => {
		const { MemoryEventLog } = await import("../../src/harness/core/eventLog");
		const { HarnessLoop } = await import("../../src/harness/core/loop");
		const log = new MemoryEventLog(() => 1);
		const model = {
			complete: async () => ({ text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }),
		};
		const tools = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };
		const loop = new HarnessLoop({ runId: "r1", log, model: model as never, tools: tools as never });
		await loop.run("implement x", undefined, undefined, { seed: [{ title: "Phase A", steps: ["first step of phase a"] }] });
		const events = await log.read();
		const seedNote = events.find((e) => e.type === "steer.note" && (e as { rule: string }).rule === "plan.seed" && (e as { text: string }).text.includes("Plan seeded"));
		expect((seedNote as { text: string } | undefined)?.text).toContain("task_step_update");
	});
});

describe("loop detection across compaction", () => {
	it("a recap resets repeat history — re-reading a compacted-away file is reconstruction, not looping", async () => {
		const { project } = await import("../../src/harness/core/projections");
		const { MemoryEventLog } = await import("../../src/harness/core/eventLog");
		const log = new MemoryEventLog(() => 1);
		// Four identical reads before the recap — one short of the repeat threshold.
		for (let i = 0; i < 4; i++) {
			await log.append({ type: "tool.requested", runId: "r1", callId: `c${i}`, name: "read_file", input: { path: "src/a.ts" } });
			await log.append({ type: "tool.finished", runId: "r1", callId: `c${i}`, name: "read_file", ok: true, output: "contents" });
		}
		const before = project(await log.read());
		expect(before.history).toHaveLength(4);
		await log.append({ type: "context.recap", runId: "r1", covers: 20, text: "summary" } as never);
		const after = project(await log.read());
		// The recap wiped the model's view of those reads — the detector starts clean.
		expect(after.history).toHaveLength(0);
		expect(after.strikes).toBe(0);
	});
});

describe("seeded step signals", () => {
	it("infers run_command signals from steps naming a command", async () => {
		const { inferStepSignal } = await import("../../src/harness/planning/planSeed");
		expect(inferStepSignal("Run `mvn clean compile` end-to-end to prove baseline compiles")).toEqual({ tool: "run_command", path: "mvn clean compile" });
		expect(inferStepSignal("Verify compilation: `mvn clean compile`")).toEqual({ tool: "run_command", path: "mvn clean compile" });
		expect(inferStepSignal("Create Config.java holding constants")).toEqual({ tool: "write_file", path: "Config.java" });
	});

	it("a seeded verify step auto-closes when its command runs ok — no manual task_step_update", async () => {
		const { MemoryEventLog } = await import("../../src/harness/core/eventLog");
		const { HarnessLoop } = await import("../../src/harness/core/loop");
		const { project } = await import("../../src/harness/core/projections");
		const log = new MemoryEventLog(() => 1);
		let calls = 0;
		const model = {
			complete: async () => {
				calls++;
				// Turn 1: run the compile. Turn 2: finish with no calls.
				return calls === 1
					? { text: "", toolCalls: [{ callId: "c1", name: "run_command", input: { command: "mvn clean compile" } }], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }
					: { text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
			},
		};
		const tools = { specs: () => [{ name: "run_command", description: "", inputSchema: {} }], execute: async () => ({ ok: true, output: "BUILD SUCCESS" }) };
		const loop = new HarnessLoop({ runId: "r1", log, model: model as never, tools: tools as never });
		await loop.run("implement x", undefined, undefined, {
			seed: [{ title: "Phase A", steps: ["Run `mvn clean compile` end-to-end to prove baseline compiles"] }],
		});
		const state = project(await log.read());
		// The signal hit closed the step — the model never called task_step_update.
		expect(state.ledger.tasks.t1?.steps[0]?.status).toBe("done");
		expect(state.ledger.tasks.t1?.steps[0]?.callIds).toContain("c1");
	});
});

describe("file-path signal inference", () => {
	it("infers write_file signals for create-ish steps naming a source file", async () => {
		const { inferStepSignal } = await import("../../src/harness/planning/planSeed");
		expect(inferStepSignal("Create `Config.java` in `com.threadestimator` holding constants")).toEqual({ tool: "write_file", path: "Config.java" });
		expect(inferStepSignal("Add `ExcelReaderTest.java` — a helper that builds in-memory XLSX")).toEqual({ tool: "write_file", path: "ExcelReaderTest.java" });
	});

	it("infers edit_file signals for modification steps", async () => {
		const { inferStepSignal } = await import("../../src/harness/planning/planSeed");
		expect(inferStepSignal("Replace the three string literals in `ExcelReader.java` with constants")).toEqual({ tool: "edit_file", path: "ExcelReader.java" });
	});

	it("ignores data literals — xlsx is not an edit target", async () => {
		const { inferStepSignal } = await import("../../src/harness/planning/planSeed");
		expect(inferStepSignal('Replace the literal `"src/main/resources/tech_debt.xlsx"` in `Config.DEFAULT_INPUT`')).toBeUndefined();
	});

	it("write-ish tools hit each other's file signals", async () => {
		const { signalHits } = await import("../../src/harness/core/taskLedger");
		const sig = { tool: "edit_file", path: "Config.java" };
		expect(signalHits(sig, { name: "write_file", input: { path: "src/main/java/com/threadestimator/Config.java" } })).toBe(true);
		expect(signalHits(sig, { name: "file_editor", input: { path: "src/main/java/com/threadestimator/Config.java" } })).toBe(true);
		expect(signalHits(sig, { name: "read_file", input: { path: "src/main/java/com/threadestimator/Config.java" } })).toBe(false);
	});
});
