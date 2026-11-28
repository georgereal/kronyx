/**
 * Shared tool assembly for every execution engine (Cline SDK runner and the
 * OpenAI-compatible engine). vscode-free — bundled into the cloud worker too.
 *
 * Builds the policy pipeline, the mode-filtered tool list (with parallel
 * markers resolved per mode), deferred/skill dispatch, and the system prompt.
 */

import type { AgentTool } from "@cline/shared";
import { createFileTools, WRITE_TOOL_NAMES } from "../tools/fileTools";
import { createFetchTools } from "../tools/fetchTools";
import { isReadOnlyMcpTool } from "../tools/mcpTools";
import { redactForModel } from "../tools/redact";
import { createDispatchTool, DEFERRED_TOOLS } from "../tools/dispatchTools";
import { createExploreTool } from "../tools/exploreTools";
import { createLoadSkillTool, parseSkill, skillsIndex } from "./skills";
import { buildSystemPrompt } from "./systemPrompt";
import { createRecallTool } from "./recall";
import { ToolPipeline } from "./pipeline";
import { DEFAULT_MAX_PARALLEL_TOOLS, Semaphore } from "./concurrency";
import { createRepeatGuard } from "./guards/repeatGuard";
import { createPermissionGuard } from "./guards/permissionGuard";
import { createSavePlanGuard, createWriteModeGuard } from "./guards/modeGuard";
import { createApprovalGuard } from "./guards/approvalGuard";
import type { ProviderSettings, RunnerHost } from "./runner";

/** Tools hidden from the model in read-only modes (ask/plan). */
/** Tools READ_ONLY_HIDDEN keeps out of ask/plan, except plan mode still offers these — writes stay visible so a necessary one can be asked for instead of dead-ending. */
export const PLAN_VISIBLE = new Set(["write_file", "edit_file", "append_file", "insert_lines", "file_editor", "rename_symbol", "run_command"]);

export const READ_ONLY_HIDDEN = new Set([
	"write_file",
	"edit_file",
	"append_file",
	"insert_lines",
	"file_editor",
	"run_command",
	"start_process",
	"stop_process",
	"poll_process",
	"browser_use",
	"switch_environment",
	"rename_symbol",
	"memory_write",
	"browser_click",
	"browser_type",
	"browser_eval",
]);

/** Pure reads that may still run concurrently in ask/plan. Everything else is an ordered boundary there. */
const READ_PARALLEL = new Set([
	"read_file",
	"list_files",
	"search_files",
	"recall_context",
	"get_diagnostics",
	"search_symbols",
	"get_file_structure",
	"get_symbol_context",
	"get_call_hierarchy",
	"get_selection_context",
	"list_plans",
	"read_plan",
]);

interface ProgressInput {
	objective: string;
	completed?: string[];
	in_progress?: string[];
	next?: string[];
	blockers?: string[];
}

/** Publishes a short, model-authored progress snapshot for the UI; the executed-tool list stays event-derived. */
const progressTool = (emit: RunnerHost["emit"]): AgentTool<ProgressInput, string> => {
	const list = { type: "array", items: { type: "string" } };
	return {
		name: "update_progress",
		executionMode: "sequential",
		description:
			"Publish a short progress update for the user: the objective, what is done, what is in progress, what is next, and any blockers. " +
			"Call at phase boundaries on multi-step tasks, not after every tool call. " +
			"This only informs the UI — it does not change the task board. To change the plan call task_replace; to close a step call task_step_update.",
		inputSchema: {
			type: "object",
			properties: {
				objective: { type: "string", description: "The goal in one sentence." },
				completed: { ...list, description: "Finished steps." },
				in_progress: { ...list, description: "Steps under way." },
				next: { ...list, description: "Planned next steps." },
				blockers: { ...list, description: "Anything blocking progress." },
			},
			required: ["objective"],
		},
		execute: async (input) => {
			emit({
				type: "task-progress",
				objective: input.objective,
				completed: input.completed ?? [],
				inProgress: input.in_progress ?? [],
				next: input.next ?? [],
				blockers: input.blockers ?? [],
			});
			return "Progress recorded.";
		},
	};
};

export interface ToolSet {
	pipeline: ToolPipeline;
	tools: AgentTool<any, string>[];
	systemPrompt: string;
	available: ReadonlySet<string>;
}

/**
 * Assemble everything an agent needs for one run. `onLoop` is invoked when the
 * repeat guard detects a stuck tool loop (the runner stops the run).
 */
// biome-ignore lint/suspicious/noExplicitAny: tool inputs vary per tool
export async function assembleToolSet(host: RunnerHost, settings: ProviderSettings, task: string, onLoop: () => void, opts?: { repeatGuard?: boolean }): Promise<ToolSet> {
	const tools = host.tools
		? await host.tools()
		: [
				...createFileTools({
					root: host.workspaceRoot,
					isDirty: host.isDirty,
					onFileChanged: (abs, kind, stats) => host.emit({ type: "file-changed", path: host.relativePath(abs), kind, ...stats }),
					onBeforeWrite: host.files?.onBeforeWrite,
					execCommand: host.files?.execCommand,
					planDir: host.planDir ? () => host.planDir! : undefined,
					onMemoryFact: host.memory?.onFact,
				}),
				...createFetchTools(host.webSearch),
			];
	// MCP tools without a readOnlyHint are writes — they join the write set so
	// ask denies them, plan/code route them to approval, and read-only modes hide them.
	const mcpWrites = new Set(tools.filter((t) => t.name.startsWith("mcp_") && !isReadOnlyMcpTool(t)).map((t) => t.name));
	const pipeline = new ToolPipeline();
	// The repeat guard is the legacy engines' only loop detector. Harness runs
	// must not include it: the kernel's LoopControlPolicy is authoritative there
	// — recap-aware and strike-based — while this guard's fixed window counts
	// post-compaction re-reads as loops and escalates on its own denials.
	if (opts?.repeatGuard !== false) {
		pipeline.pre(
			createRepeatGuard({
				onLoopDetected: (tool, count) => host.emit({ type: "loop-detected", tool, count }),
				onStop: onLoop,
			}),
		);
	}
	pipeline.pre(createSavePlanGuard(host.currentMode));
	if (host.approvals?.check) pipeline.pre(createPermissionGuard(host.approvals.check));
	pipeline.pre(
		createWriteModeGuard({
			currentMode: host.currentMode,
			writeTools: new Set([...WRITE_TOOL_NAMES, ...mcpWrites]),
			root: host.workspaceRoot,
			...(host.planDir ? { planDir: host.planDir } : {}),
			onModeBlocked: (mode) => host.emit({ type: "mode-blocked", mode }),
		}),
	);
	pipeline.pre(createApprovalGuard(host.approvals));
	const mode = host.currentMode();
	const ide = host.ideTools === true;
	// Parallel markers survive in ask/plan only for pure reads (IDE host); every other call is an ordered boundary.
	const readOnly = mode === "ask" || mode === "plan";
	const execTools = (list: AgentTool<any, string>[]) =>
		list.map((t) => (t.executionMode === "parallel" && (!readOnly || (ide && READ_PARALLEL.has(t.name))) ? t : { ...t, executionMode: "sequential" as const }));
	// Read-only modes don't ship the write/env tool schemas — the hook would
	// deny them anyway, and each schema costs tokens on every request. Plan mode
	// is the exception: file-write and shell tools stay visible — writes fall
	// through to the approval stage so the user decides, and .kronyx/** + tmpdir
	// writes still pass without a prompt for harness-owned artifacts.
	const visible = readOnly
		? tools.filter((t) => !mcpWrites.has(t.name) && (!READ_ONLY_HIDDEN.has(t.name) || (mode === "plan" && PLAN_VISIBLE.has(t.name))) && (mode === "plan" || t.name !== "save_plan"))
		: tools;
	// Deferred tools (browser_use, switch_environment, fetch_url) stay out of
	// the per-request schemas; the model reaches them through use_tool.
	const deferred = visible.filter((t) => DEFERRED_TOOLS.has(t.name));
	// Repo skills: index into the prompt, bodies behind load_skill.
	const skills = (((await host.files?.listSkillFiles?.().catch(() => [])) ?? []) as { path: string; content: string }[]).map((f) =>
		parseSkill(f.path, f.content),
	);
	if (skills.length) deferred.push(createLoadSkillTool(skills));
	const loaded = visible.filter((t) => !DEFERRED_TOOLS.has(t.name));
	const pipelineTools = [
		...execTools(loaded),
		...(ide ? [progressTool((e) => host.emit(e))] : []),
		...(deferred.length ? [createDispatchTool(deferred)] : []),
		createExploreTool({ settings, tools: visible, onEvent: (text) => host.emit({ type: "info", text }) }),
		...(host.recall?.enabled === false
			? []
			: execTools([createRecallTool({ priorTranscripts: host.recall?.transcripts, scorer: host.recall?.scorer })])),
	];
	// aroundTool listeners wrap the tool body at registration time — the
	// agent loop exposes before/after hooks but no around-execution hook.
	// The gate bounds in-flight tool bodies; approvals run before it, so a
	// pending confirmation never holds a slot.
	const gate = ide ? new Semaphore(settings.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS) : undefined;
	// Every model-facing result passes redaction here, so shell output, MCP
	// results, process logs, and browser snapshots are scrubbed for all engines.
	const redact = (out: string) => redactForModel(out, host.secretValues?.() ?? []);
	const wrapped = pipelineTools.map((t) =>
		t.execute
			? {
					...t,
					execute: async (input: any, ctx: Parameters<NonNullable<typeof t.execute>>[1]) => {
						const out = await pipeline.runAround({ name: t.name, input }, () => (gate ? gate.run(() => t.execute!(input, ctx)) : Promise.resolve(t.execute!(input, ctx))));
						return typeof out === "string" ? redact(out) : out;
					},
				}
			: t,
	);
	// Names the model can reach this run (loaded + deferred via use_tool) — prompt rules only cite these.
	const available = new Set([...pipelineTools, ...deferred].map((t) => t.name));
	const systemPrompt = buildSystemPrompt(
		host.workspaceRoot,
		mode,
		(await host.memory?.context?.(task, settings)) ?? "",
		host.environment,
		skillsIndex(skills),
		available,
	);
	return { pipeline, tools: wrapped, systemPrompt, available };
}
