/**
 * Harness state machine (vscode-free). Only this class transitions the phase:
 *
 *   ModelCall → ToolBatch → ModelCall …
 *   ModelCall → StopCheck → (refused → ModelCall) | Verify → Done
 *   any → Paused (turn / input budget / refusals / loop) | Failed (port error, invariant)
 *
 * The model proposes tool calls and says when it has finished. Steering rules
 * and the loop controller decide what runs; the model cannot skip StopCheck or Verify.
 */

import {
	DEFAULT_LOOP_DETECTOR,
	SchemaError,
	type ImageInput,
	type EventBody,
	type LoopDetectorConfig,
	type ModelPort,
	type SessionEvent,
	type Task,
	type ToolCall,
	type ToolPort,
	type ToolResult,
	type ToolSpec,
	type Usage,
	type VerifierPort,
} from "./contracts";
import { callFingerprint } from "./canonical";
import { expandBraces, ownsMatch } from "../agent/decompose";
import { buildContext, CONTEXT_BUDGET_CHARS, estimateChars, KEEP_RECENT_MESSAGES, LOG_SLICE, LOG_SLICE_SPEC, SYSTEM_INSTRUCTIONS } from "./context";
import { makePlan } from "./planner";
import { READ_FILES } from "./batchReads";
import { makeRecap } from "./recap";
import type { EventLog } from "./eventLog";
import { detect, levelForStrikes, type LoopReason } from "./loopControl";
import { initialState, project, reduce, type HarnessState } from "./projections";
import { builtinRules, callIsReadOnly, SteeringRegistry } from "./steering";
import {
	applyLedgerEvent,
	checkAdopt,
	checkCreate,
	checkRemove,
	checkStepAdd,
	checkStepUpdate,
	checkTransition,
	blockedTasks,
	openTasks,
	tasksOfRun,
	parseTaskCreateInput,
	parseTaskRemoveInput,
	parseTaskStepAddInput,
	parseTaskStepUpdateInput,
	parseTaskUpdateInput,
	TASK_TOOL_NAMES,
	TASK_TOOL_SET,
	TASK_TOOLS,
	type Ledger,
} from "./taskLedger";

/**
 * Whether a successful tool call satisfies a step's completion signal. Path
 * signals match per-tool args: read_file/list_files use `path`, read_files its
 * `files[]`, search_files `path`/`file_glob` plus literal filenames from the
 * signal glob matched inside `pattern` (a search for "package.json" hits a
 * signal glob naming it). explore_codebase needs only the tool name — one call
 * covers whatever area the signal meant.
 */
const signalHits = (signal: { tool: string; path?: string }, call: ToolCall): boolean => {
	// A read_files batch satisfies read_file signals for any file it covered.
	const names = call.name === READ_FILES ? [READ_FILES, "read_file"] : [call.name];
	if (!names.includes(signal.tool)) return false;
	if (signal.tool === "explore_codebase") return true;
	if (!signal.path) return true;
	const input = (call.input ?? {}) as { path?: unknown; files?: unknown; pattern?: unknown; file_glob?: unknown };
	const paths: string[] = [];
	if (typeof input.path === "string") paths.push(input.path);
	if (call.name === READ_FILES && Array.isArray(input.files)) {
		for (const f of input.files as { path?: unknown }[]) if (typeof f?.path === "string") paths.push(f.path);
	}
	if (typeof input.file_glob === "string") paths.push(input.file_glob);
	if (paths.some((p) => ownsMatch([signal.path!], p))) return true;
	// Filename-style signal globs (**/{a,b}) also hit when the file's literal
	// basename appears in the call's search pattern or file glob.
	const literals = expandBraces(signal.path).map((g) => g.split("/").pop() ?? "").filter((b) => b && !/[*?{}]/.test(b));
	// `pattern` is regex — the model often escapes dots (Cargo\.toml), so compare unescaped.
	const pattern = typeof input.pattern === "string" ? input.pattern.replace(/\\/g, "") : "";
	return literals.some((b) => pattern.includes(b) || (typeof input.file_glob === "string" && input.file_glob.includes(b)));
};

/** Earlier plans rendered per run, for the planner: each run's tasks with step statuses. */
const priorPlans = (ledger: Ledger): string => {
	const byRun = new Map<string, string[]>();
	for (const id of ledger.order) {
		const key = ledger.tasks[id]?.runId?.slice(0, 8) ?? "unscoped";
		const list = byRun.get(key) ?? [];
		list.push(id);
		byRun.set(key, list);
	}
	const runs: string[] = [];
	for (const [run, ids] of byRun) {
		const lines = ids.map((id) => {
			const t = ledger.tasks[id]!;
			const steps = t.steps.map((s) => `    - ${s.id} [${s.status}] ${s.text}`).join("\n");
			return `  - ${t.id} [${t.status}] ${t.title}${steps ? `\n${steps}` : ""}`;
		});
		runs.push(`Run ${run}:\n${lines.join("\n")}`);
	}
	return runs.join("\n");
};

export type LoopPhase = "Idle" | "ModelCall" | "ToolBatch" | "StopCheck" | "Verify" | "Done" | "Paused" | "Failed";

export interface HarnessLimits {
	/** Model calls allowed per window (a window is one run or one resume). */
	maxTurns: number;
	/** Input tokens allowed for the whole session. */
	maxInputTokens: number;
	/** Finish attempts refused per window before the run pauses. */
	maxRefusals: number;
}

const STRIP_STRIKES = 3;
const LOG_SLICE_CAP = 8000;

export const DEFAULT_LIMITS: HarnessLimits = { maxTurns: 50, maxInputTokens: 2_000_000, maxRefusals: 3 };

export interface HarnessDeps {
	runId: string;
	log: EventLog;
	model: ModelPort;
	tools: ToolPort;
	verifier?: VerifierPort;
	limits?: Partial<HarnessLimits>;
	/** Called when a window hits maxTurns or the session input budget. Returning
	 *  true extends the ceiling by the configured amount; false/undefined pauses. */
	onTurnLimit?: (used: number, limit: number, kind?: "turns" | "input_tokens", contextTokens?: number) => Promise<boolean>;
	/** Rules out a steering "ask" verdict (e.g. plan.drift). True continues the
	 *  run; false or absent pauses with the question as the reason. */
	onSteerAsk?: (question: string) => Promise<boolean>;
	loop?: Partial<LoopDetectorConfig>;
	/** Defaults to the built-in rules. Pass a registry to add or replace rules. */
	steering?: SteeringRegistry;
	/** Aborting this (the user's Stop) stops the run at the next step, cancelling any in-flight model request. */
	signal?: AbortSignal;
	/** Write modes: a run that ends without any tool call gets one nudge to proceed. */
	nudgeWrites?: boolean;
	/** False in read-only modes (ask/plan): the planner must not emit write steps and command acceptances are coerced to none. Defaults to true. */
	writable?: boolean;
	/** Called after each event is applied to the projection. Used by the UI for the task board. */
	onState?: (state: HarnessState, event: SessionEvent) => void;
	/** System prompt for every request. Defaults to the harness instructions. Must stay identical across runs for cache hits. */
	system?: string;
	/** Streams reasoning/thinking chunks to the UI as they arrive, when the provider emits them. */
	onReasoningDelta?: (text: string) => void;
}

export interface RunOutcome {
	status: "completed" | "paused" | "failed";
	reason?: string;
	phases: LoopPhase[];
}

interface Verdict {
	level: "none" | "warn" | "block" | "strip" | "pause";
	fingerprint: string;
	reason?: LoopReason;
}

const defaultSteering = (writable: boolean, runId: string): SteeringRegistry => {
	const registry = new SteeringRegistry();
	for (const { point, rule } of builtinRules({ writable, runId })) registry.add(point, rule);
	return registry;
};

export class HarnessLoop {
	private phase: LoopPhase = "Idle";
	private state: HarnessState = initialState();
	private phases: LoopPhase[] = [];
	private reason: string | undefined;
	private window = { turns: 0, refusals: 0, calls: 0, nudged: false };
	private forceRecap = false;
	/** Set when a task closes: the next model call writes a recap so the finished
	 *  task's span compresses to a brief instead of staying raw in context. */
	private taskRecapPending = false;
	private pendingCalls: ToolCall[] = [];
	private budgetWarned = false;
	/** Last request's input usage — the real context size, unlike the cumulative counter. */
	private lastInputTokens = 0;
	private lastCachedTokens = 0;
	private running = false;
	private readonly limits: HarnessLimits;
	/** Per-extension quantum when the user continues past a turn limit. */
	private readonly turnWindow: number;
	/** Per-extension quantum when the user continues past the input budget. */
	private readonly tokenWindow: number;
	private readonly loopCfg: LoopDetectorConfig;
	/** Every spec the loop can handle, including harness-reserved task tools (kept for back-compat calls). */
	private readonly tools: readonly ToolSpec[];
	/** Specs actually offered to the model. The task board is harness-owned, so task tools are handled but never advertised. */
	private readonly offered: readonly ToolSpec[];
	private readonly steering: SteeringRegistry;
	private readonly system: string;
	private readonly abort = new AbortController();

	constructor(private readonly deps: HarnessDeps) {
		deps.signal?.addEventListener("abort", () => this.abort.abort(), { once: true });
		if (deps.signal?.aborted) this.abort.abort();
		this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
		this.turnWindow = this.limits.maxTurns;
		this.tokenWindow = this.limits.maxInputTokens;
		this.loopCfg = { ...DEFAULT_LOOP_DETECTOR, ...deps.loop };
		this.steering = deps.steering ?? defaultSteering(deps.writable !== false, deps.runId);
		this.system = deps.system ?? SYSTEM_INSTRUCTIONS;
		const external = deps.tools.specs();
		const clash = external.find((t) => TASK_TOOL_SET.has(t.name) || t.name === LOG_SLICE);
		if (clash) throw new Error(`tool name ${clash.name} is reserved by the harness`);
		this.tools = [...TASK_TOOLS, LOG_SLICE_SPEC, ...external];
		this.offered = this.tools.filter((t) => !TASK_TOOL_SET.has(t.name));
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Compact now: the next model call writes a recap of everything older than the recent window. */
	requestCompact(): boolean {
		if (!this.running) return false;
		this.forceRecap = true;
		return true;
	}

	/** The current projection. Equal to project(await log.read()) at every point. */
	get projection(): HarnessState {
		return this.state;
	}

	get currentPhase(): LoopPhase {
		return this.phase;
	}

	/**
	 * Starts a run. `context` is per-run material (memory, workspace state) placed
	 * at the start of this run's user message, so the system prompt stays identical.
	 */
	async run(text: string, context?: string, images?: ImageInput[], opts?: { plan?: boolean }): Promise<RunOutcome> {
		this.begin();
		await this.emit({ type: "run.status", status: "running" });
		await this.emit({ type: "user.input", text: context ? `${context}\n\n${text}` : text, ...(images?.length ? { images } : {}) });
		if (opts?.plan) await this.planBoard(text);
		this.enter("ModelCall");
		return this.guarded(() => this.drive());
	}

	/**
	 * Harness-owned board: one planner call decomposes the task into ledger
	 * events before the first model turn. Ids are remapped into the session's
	 * id space and invalid entries are skipped, so a bad plan degrades to fewer
	 * tasks, never a failed run. The planner's token usage rides on the first
	 * task.created event so it counts against the session budget.
	 */
	private async planBoard(taskText: string): Promise<void> {
		const writable = this.deps.writable !== false;
		// Give the planner the earlier runs' plans, grouped per run, so a
		// continuation ("redo", "same task") adopts the matching layer instead of
		// minting meta-tasks to rediscover prior work.
		const board = this.state.ledger.order.length ? priorPlans(this.state.ledger) : undefined;
		// Prior deliverables are cheap to reuse — let the planner say "the saved
		// plan already answers this" instead of re-deriving the analysis.
		let savedPlans: string[] | undefined;
		if (this.deps.tools.specs().some((s) => s.name === "list_plans")) {
			try {
				const res = await this.deps.tools.execute("list_plans", {});
				if (res.ok && res.output.trim()) savedPlans = res.output.trim().split("\n").map((l) => l.trim()).filter(Boolean);
			} catch {
				savedPlans = undefined;
			}
		}
		const plan = await makePlan(this.deps.model, taskText, { signal: this.abort.signal, writable, board, plans: savedPlans });
		if (plan.reusePlan) {
			await this.emit({ type: "steer.note", rule: "plan.reuse", text: `A saved plan "${plan.reusePlan}" already covers this — recall it with read_plan and answer from it. No new tasks.` });
			return;
		}
		// Adopt the tasks the planner says this run continues — their ids keep
		// their history; ownership moves to this run via task.adopted.
		for (const id of plan.continueIds) {
			if (checkAdopt(this.state.ledger, id).ok) await this.emit({ type: "task.adopted", id });
		}
		if (plan.tasks.length === 0 && plan.continueIds.length === 0 && board) {
			// Nothing new and nothing adopted: continue the most recent run's open work.
			const prior = this.state.ledger.order.filter((id) => this.state.ledger.tasks[id]?.runId !== this.deps.runId);
			const lastRun = prior.length ? this.state.ledger.tasks[prior[prior.length - 1]!]?.runId : undefined;
			const adopted = prior.filter((id) => this.state.ledger.tasks[id]?.runId === lastRun && checkAdopt(this.state.ledger, id).ok);
			if (adopted.length === 0) {
				await this.emit({ type: "steer.note", rule: "plan.reuse", text: "The task continues work already on the board — reusing it, no new tasks." });
			} else {
				for (const id of adopted) await this.emit({ type: "task.adopted", id });
				await this.emit({ type: "steer.note", rule: "plan.reuse", text: `Continuing ${adopted.length} task${adopted.length === 1 ? "" : "s"} from the earlier run's plan.` });
			}
			await this.advanceBoard();
			return;
		}
		// A signal for a tool this run can't call would deadlock its step at
		// close-out — strip it (the step still completes via acceptance).
		const signalable = (tool: string) => this.signalable(tool);
		const base = this.state.ledger.order.length;
		const idMap = new Map(plan.tasks.map((t, i) => [t.id, `t${base + i + 1}`]));
		const known = new Set([...this.state.ledger.order, ...idMap.values()]);
		const sanitized = plan.tasks.map((t) => ({
			...t,
			id: idMap.get(t.id)!,
			dependsOn: t.dependsOn.map((d) => idMap.get(d) ?? d).filter((d) => known.has(d)),
			// A command acceptance in a read-only run can check a file the run can
			// never create — coerce to none so the board can't wedge at close-out.
			acceptance: !writable && t.acceptance.kind === "command" ? ({ kind: "none" } as const) : t.acceptance,
			steps: t.steps.map((s) => (s.signal && !signalable(s.signal.tool) ? { ...s, signal: undefined } : s)),
		}));
		// Dependencies first; cycles fall back to declaration order and checkCreate skips whatever is invalid.
		const emitted = new Set(this.state.ledger.order);
		const pending = [...sanitized];
		const ordered: typeof sanitized = [];
		while (pending.length) {
			const idx = pending.findIndex((t) => t.dependsOn.every((d) => emitted.has(d)));
			if (idx < 0) {
				ordered.push(...pending);
				break;
			}
			const [t] = pending.splice(idx, 1);
			ordered.push(t);
			emitted.add(t.id);
		}
		let sim = this.state.ledger;
		let first = true;
		for (const task of ordered) {
			if (!checkCreate(sim, task).ok) continue;
			await this.emit({ type: "task.created", task, ...(first && plan.usage ? { usage: plan.usage } : {}) });
			sim = applyLedgerEvent(sim, { type: "task.created", task });
			first = false;
		}
		await this.advanceBoard();
	}

	/**
	 * Rebuilds state from the log after a restart. Any tool call the model asked
	 * for that has no recorded result gets an explicit interrupted result, so the
	 * transcript stays valid. A run left "running" is paused and can be resumed.
	 * Calls with recorded results are never re-run.
	 */
	async recover(): Promise<{ interrupted: number }> {
		if (this.running) throw new Error("cannot recover while a run is in progress");
		const events = await this.deps.log.read();
		this.state = project(events);
		this.budgetWarned = events.some((e) => e.type === "budget.warning");
		const pending = new Map<string, string>();
		for (const e of events) {
			if (e.type === "model.response") for (const c of e.toolCalls) pending.set(c.callId, c.name);
			if (e.type === "tool.finished") pending.delete(e.callId);
		}
		for (const [callId, name] of pending) {
			await this.emit({ type: "tool.finished", callId, name, ok: false, output: "interrupted: the harness stopped before this tool returned. Its result is unknown; retry it if it is still needed." });
		}
		if (this.state.run.status === "running") {
			this.phases = [];
			await this.pause("recovered");
		}
		return { interrupted: pending.size };
	}

	/** Continues a paused run with a fresh window of turns and refusals. Loop strikes persist. */
	async resume(): Promise<RunOutcome> {
		if (this.phase !== "Paused") throw new Error(`cannot resume from ${this.phase}`);
		// Resuming past a spent input budget would pause again on the first call —
		// a resume is an explicit continue, so extend the ceiling first.
		if (this.state.counters.inputTokens >= this.limits.maxInputTokens) {
			this.limits.maxInputTokens += this.tokenWindow;
			this.budgetWarned = false;
		}
		this.begin();
		await this.emit({ type: "run.status", status: "running" });
		this.enter("ModelCall");
		return this.guarded(() => this.drive());
	}

	private begin(): void {
		if (this.running) throw new Error("a run is already in progress");
		this.running = true;
		this.window = { turns: 0, refusals: 0, calls: 0, nudged: false };
		this.phases = [];
		this.reason = undefined;
	}

	private async guarded(step: () => Promise<RunOutcome>): Promise<RunOutcome> {
		try {
			return await step();
		} finally {
			this.running = false;
		}
	}

	private enter(phase: LoopPhase): void {
		this.phase = phase;
		this.phases.push(phase);
	}

	private async emit(body: EventBody): Promise<void> {
		const event = await this.deps.log.append({ ...body, runId: this.deps.runId });
		this.state = reduce(this.state, event);
		if (body.type === "task.updated" && body.to === "done") this.taskRecapPending = true;
		this.deps.onState?.(this.state, event);
	}

	private async noteAll(notes: Array<{ rule: string; text: string }>): Promise<void> {
		for (const note of notes) await this.emit({ type: "steer.note", rule: note.rule, text: note.text });
	}

	private outcome(status: RunOutcome["status"]): RunOutcome {
		return { status, ...(this.reason === undefined ? {} : { reason: this.reason }), phases: [...this.phases] };
	}

	/** Stops the run. Idempotent. The run pauses with reason `stopped` and can be continued by sending a new message. */
	stop(): void {
		this.abort.abort();
	}

	private async drive(): Promise<RunOutcome> {
		try {
			for (;;) {
				if (this.abort.signal.aborted && !["Paused", "Done", "Failed"].includes(this.phase)) {
					await this.pause("stopped");
				}
				switch (this.phase) {
					case "ModelCall":
						await this.modelCall();
						break;
					case "ToolBatch":
						await this.toolBatch();
						break;
					case "StopCheck":
						await this.stopCheck();
						break;
					case "Verify":
						await this.verify();
						break;
					case "Done":
						await this.emit({ type: "run.status", status: "completed" });
						return this.outcome("completed");
					case "Paused":
						return this.outcome("paused");
					case "Failed":
						return this.outcome("failed");
					default:
						throw new Error(`no transition from ${this.phase}`);
				}
			}
		} catch (err) {
			if (this.abort.signal.aborted) {
				await this.pause("stopped").catch(() => undefined);
				return this.outcome("paused");
			}
			const message = err instanceof Error ? err.message : String(err);
			await this.onError(message);
			await this.fail(message).catch(() => undefined);
			return this.outcome("failed");
		}
	}

	private async onError(message: string): Promise<void> {
		const result = await this.steering.run("onError", { message, ledger: this.state.ledger }).catch(() => undefined);
		if (result) await this.noteAll(result.notes).catch(() => undefined);
	}

	private async pause(reason: string): Promise<void> {
		this.reason = reason;
		this.enter("Paused");
		await this.emit({ type: "run.status", status: "paused", reason });
	}

	private async fail(reason: string): Promise<void> {
		this.reason = reason;
		this.enter("Failed");
		await this.emit({ type: "run.status", status: "failed", reason });
	}

	private async modelCall(): Promise<void> {
		const turn = this.state.counters.turns + 1;
		const recentTurns = this.state.messages
			.flatMap((m) =>
				m.kind === "assistant"
					? [{ calls: m.toolCalls.map((c) => c.name), readOnly: m.toolCalls.map((c) => callIsReadOnly(c.name, c.input)), text: m.text }]
					: [],
			)
			.slice(-24);
		const before = await this.steering.run("beforeModel", { turn, ledger: this.state.ledger, recentTurns });
		await this.noteAll(before.notes);
		if (before.verdict.kind === "deny") return this.pause(before.verdict.reason);
		if (before.verdict.kind === "ask") {
			const proceed = this.deps.onSteerAsk ? await this.deps.onSteerAsk(before.verdict.question) : false;
			if (!proceed) return this.pause(before.verdict.question);
		}
		if (this.window.turns >= this.limits.maxTurns) {
			const proceed = this.deps.onTurnLimit ? await this.deps.onTurnLimit(this.window.turns, this.limits.maxTurns, "turns") : false;
			if (!proceed) return this.pause("max_turns");
			this.limits.maxTurns += this.turnWindow;
		}
		if (this.state.counters.inputTokens >= this.limits.maxInputTokens) {
			// Spend crossing the allowance is not a user decision — compact so the
			// context stays small, note the extension, and keep going. Turns still
			// ask; runaway cost is bounded by maxTurns and per-call context size.
			this.forceRecap = true;
			await this.maybeRecap();
			const contextTokens = Math.ceil(estimateChars(buildContext(this.state, this.offered, this.system, this.deps.runId).messages) / 4);
			this.limits.maxInputTokens += this.tokenWindow;
			this.budgetWarned = false;
			await this.emit({ type: "steer.note", rule: "context.budget", text: `Session input spend crossed ${Math.round(this.state.counters.inputTokens / 1000)}k tokens — context compacted to ~${Math.round(contextTokens / 1000)}k, allowance extended to ${Math.round(this.limits.maxInputTokens / 1000)}k.` });
		}
		// Strip level (after two flagged calls) removes tools for the next model turn; derived from strikes so it survives recovery.
		await this.maybeRecap();
		const context = buildContext(this.state, this.offered, this.system, this.deps.runId);
		const tools = this.state.strikes === STRIP_STRIKES ? [] : context.tools;
		const response = await this.deps.model.complete({ turn, system: context.system, messages: context.messages, ledger: this.state.ledger, tools, signal: this.abort.signal, onReasoningDelta: this.deps.onReasoningDelta });
		const ids = new Set(response.toolCalls.map((c) => c.callId));
		if (ids.size !== response.toolCalls.length) throw new Error("model returned duplicate tool call ids");
		const usage: Usage | undefined = response.usage;
		if (usage?.inputTokens) this.lastInputTokens = usage.inputTokens;
		if (usage?.cachedTokens) this.lastCachedTokens = usage.cachedTokens;
		await this.emit({ type: "model.response", turn, text: response.text, toolCalls: response.toolCalls, ...(usage ? { usage } : {}), ...(response.reasoning ? { reasoning: response.reasoning } : {}) });
		this.window.turns++;
		await this.checkBudgetWarning();
		this.pendingCalls = response.toolCalls;
		this.enter(response.toolCalls.length ? "ToolBatch" : "StopCheck");
	}

	/**
	 * Writes a recap when the compaction boundary moves past the last recap. A
	 * failed recap is not fatal: the older messages simply stay stubbed.
	 */
	private async maybeRecap(): Promise<void> {
		// Triggers: the manual Compact control, a just-closed task (per-task
		// summarization), or context pressure — the last request exceeding the
		// projected-context design budget. This keys off the per-call context
		// size (which recaps actually shrink), not cumulative spend.
		const pressured = this.lastInputTokens * 4 > CONTEXT_BUDGET_CHARS;
		const taskDone = this.taskRecapPending;
		this.taskRecapPending = false;
		const forced = this.forceRecap;
		this.forceRecap = false;
		if (!forced && !taskDone && !pressured) return;
		const boundary = Math.max(0, this.state.messages.length - KEEP_RECENT_MESSAGES);
		const covered = this.state.recap?.covers ?? 0;
		if (boundary <= covered) return;
		let recap: Awaited<ReturnType<typeof makeRecap>>;
		try {
			recap = await makeRecap(this.deps.model, this.state.recap?.text, this.state.messages.slice(covered, boundary), this.abort.signal);
		} catch (err) {
			await this.emit({ type: "steer.note", rule: "context.recap", text: `compaction failed — continuing without it (${err instanceof Error ? err.message : String(err)})` });
			return;
		}
		if (!recap) return;
		await this.emit({ type: "context.recap", covers: boundary, text: recap.text, ...(recap.usage ? { usage: recap.usage } : {}) });
	}

	private async checkBudgetWarning(): Promise<void> {
		const used = this.state.counters.inputTokens;
		if (this.budgetWarned || used < this.limits.maxInputTokens * 0.8) return;
		this.budgetWarned = true;
		await this.emit({ type: "budget.warning", kind: "input_tokens", used, limit: this.limits.maxInputTokens });
	}

	/**
	 * Runs one model batch in order. Gates (loop control, steering) run per call.
	 * Adjacent calls to parallel read-only tools run concurrently; any other call
	 * is an ordered boundary, as in the Cline loop.
	 */
	private async toolBatch(): Promise<void> {
		this.window.calls += this.pendingCalls.length;
		let stopped: string | undefined;
		let group: ToolCall[] = [];
		const flush = async () => {
			if (group.length === 0) return;
			const results = await Promise.all(group.map((c) => this.runExternal(c)));
			for (let k = 0; k < group.length; k++) await this.finish(group[k]!, results[k]!.ok, results[k]!.output, results[k]!.usage);
			group = [];
		};
		for (const call of this.pendingCalls) {
			if (this.abort.signal.aborted) stopped ??= "stopped";
			if (stopped) {
				await flush();
				await this.refused(call, `Not run: ${stopped}.`);
				continue;
			}
			if (this.state.outcomes[call.callId] !== undefined) continue;
			const gate = await this.gate(call);
			if (gate === "stop") {
				await flush();
				stopped = this.stopReason ?? "loop";
				continue;
			}
			if (gate === "done") {
				await flush();
				continue;
			}
			if (gate === "parallel") {
				group.push(call);
				continue;
			}
			await flush();
			const result = call.name === LOG_SLICE ? await this.runLogSlice(call) : TASK_TOOL_SET.has(call.name) ? await this.applyTaskTool(call) : await this.runExternal(call);
			await this.finish(call, result.ok, result.output, result.usage);
		}
		await flush();
		this.pendingCalls = [];
		if (stopped) return this.pause(stopped);
		this.enter("ModelCall");
	}

	private stopReason: string | undefined;

	/** Per-call gates: loop control, then steering. Returns what the batch should do with the call. */
	private async gate(call: ToolCall): Promise<"done" | "stop" | "parallel" | "execute"> {
		// Loop check first: detection reads history, and the call must not count itself.
		const verdict = await this.checkLoop(call);
		await this.emit({ type: "tool.requested", callId: call.callId, name: call.name, input: call.input });
		if (verdict.level === "pause") {
			this.stopReason = `loop (${verdict.reason})`;
			await this.finish(call, false, `Stopped: repeated tool calls (${verdict.reason}). Change approach.`);
			return "stop";
		}
		if (verdict.level === "block" || verdict.level === "strip") {
			await this.finish(call, false, `Blocked: this call repeats earlier calls (${verdict.reason}). Change approach.`);
			return "done";
		}
		if (verdict.level === "warn") {
			await this.noteAll([{ rule: "loop.warn", text: `You are repeating ${call.name} (${verdict.reason}). Try a different approach.` }]);
		}
		const beforeTool = await this.steering.run("beforeTool", { call, ledger: this.state.ledger, outcomes: this.state.outcomes });
		await this.noteAll(beforeTool.notes);
		if (beforeTool.verdict.kind !== "allow") {
			const why = beforeTool.verdict.kind === "deny" ? beforeTool.verdict.reason : `needs approval: ${beforeTool.verdict.question}`;
			await this.finish(call, false, `Refused by ${beforeTool.verdict.rule}: ${why}`);
			return "done";
		}
		const isExternal = call.name !== LOG_SLICE && !TASK_TOOL_SET.has(call.name);
		return isExternal && this.tools.find((t) => t.name === call.name)?.parallel ? "parallel" : "execute";
	}

	/** Classifies a call against recent history before it is recorded. Emits a verdict when flagged or when it clears strikes. */
	private async checkLoop(call: ToolCall): Promise<Verdict> {
		const fingerprint = callFingerprint(call.name, call.input);
		const reason = detect(this.state.history, fingerprint, this.loopCfg);
		if (!reason) {
			if (this.state.strikes > 0) await this.emit({ type: "loop.verdict", level: "none", fingerprint });
			return { level: "none", fingerprint };
		}
		const level = levelForStrikes(this.state.strikes);
		await this.emit({ type: "loop.verdict", level, fingerprint, reason: reason });
		return { level, fingerprint, reason };
	}

	private async refused(call: ToolCall, output: string): Promise<void> {
		await this.emit({ type: "tool.requested", callId: call.callId, name: call.name, input: call.input });
		await this.finish(call, false, output);
	}

	private async finish(call: ToolCall, ok: boolean, output: string, usage?: Usage): Promise<void> {
		await this.emit({ type: "tool.finished", callId: call.callId, name: call.name, ok, output, ...(usage ? { usage } : {}) });
		const after = await this.steering.run("afterTool", { call, ok, ledger: this.state.ledger });
		await this.noteAll(after.notes);
		await this.advanceBoard(call, ok);
	}

	/**
	 * Board advancement, driven by the harness — never the model. A finished ok
	 * call satisfies the current step's predicted `signal` (first open step per
	 * task, callId cited as evidence). Then open tasks and their first open
	 * steps move to in_progress. All transitions are pre-checked, so this is a
	 * no-op when the board is already current.
	 */
	private async advanceBoard(call?: ToolCall, ok = false): Promise<void> {
		// The board is run-scoped: only this run's tasks (incl. adopted ones) advance.
		const runTasks = () => tasksOfRun(this.state.ledger, this.deps.runId);
		if (call && ok) {
			for (const id of runTasks()) {
				const task = this.state.ledger.tasks[id];
				if (!task || task.status === "done") continue;
				const step = task.steps.find((s) => s.status !== "done");
				const signal = step?.signal;
				if (!step || !signal) continue;
				if (!signalHits(signal, call)) continue;
				if (step.status !== "in_progress" && checkStepUpdate(this.state.ledger, id, step.id, "in_progress", [], this.state.outcomes).ok) {
					await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "in_progress", callIds: [] });
				}
				if (checkStepUpdate(this.state.ledger, id, step.id, "done", [call.callId], this.state.outcomes).ok) {
					await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "done", callIds: [call.callId] });
				}
			}
		}
		for (const id of runTasks()) {
			const task = this.state.ledger.tasks[id];
			if (!task || task.status === "done") continue;
			if (task.status === "pending" && checkTransition(this.state.ledger, id, "in_progress").ok) {
				await this.emit({ type: "task.updated", id, to: "in_progress" });
			}
			const current = this.state.ledger.tasks[id];
			if (!current || current.status === "done") continue;
			const step = current.steps.find((s) => s.status !== "done");
			if (step && step.status === "pending" && checkStepUpdate(this.state.ledger, id, step.id, "in_progress", [], this.state.outcomes).ok) {
				await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "in_progress", callIds: [] });
			}
		}
	}

	/**
	 * Harness close-out at StopCheck: the model said it is done, so the harness
	 * verifies the board itself. A task is eligible once no open step still
	 * waits on a signal — its acceptance check then covers any remaining
	 * unsignaled steps. Open signaled steps must complete during work; they are
	 * never force-closed, so a premature finish just refuses without spending
	 * an acceptance run.
	 */
	/** True when this run's tools can fire a step signal (read_files counts for read_file signals). */
	private signalable(tool: string): boolean {
		const available = new Set(this.deps.tools.specs().map((s) => s.name));
		return available.has(tool) || (tool === "read_file" && available.has(READ_FILES));
	}

	private async closeBoard(): Promise<void> {
		// Only this run's tasks close — prior runs' plans are their own record.
		for (const id of [...tasksOfRun(this.state.ledger, this.deps.runId)]) {
			const task = this.state.ledger.tasks[id];
			if (!task || task.status === "done" || task.status === "blocked") continue;
			// A blocked dependency can never go done, so its dependents can't either.
			const blockedDep = task.dependsOn.find((d) => this.state.ledger.tasks[d]?.status === "blocked");
			if (blockedDep) {
				await this.blockTask(id, `dependency ${blockedDep} is blocked`);
				continue;
			}
			if (task.dependsOn.some((d) => this.state.ledger.tasks[d]?.status !== "done")) continue;
			const openSteps = task.steps.filter((s) => s.status !== "done" && s.status !== "blocked");
			// Signals for tools this run can't call (mode-stripped or adopted from
			// a different tool set) can't deadlock the board — acceptance covers them.
			const stranded = openSteps.filter((s) => s.signal && this.signalable(s.signal.tool));
			if (stranded.length) {
				await this.stallTask(id, `signaled step(s) never completed: ${stranded.map((s) => s.id).join(", ")}`);
				continue;
			}
			if (task.status !== "in_progress" && checkTransition(this.state.ledger, id, "in_progress").ok) {
				await this.emit({ type: "task.updated", id, to: "in_progress" });
			}
			let verified = this.state.ledger.verified.includes(id);
			let failDetail = "";
			if (!verified) {
				const current = this.state.ledger.tasks[id]!;
				if (current.acceptance.kind === "none") {
					await this.emit({ type: "verifier.result", taskId: id, ok: true, detail: "no acceptance check" });
					verified = true;
				} else if (current.acceptance.kind === "command" && this.deps.verifier) {
					const verdict = await this.deps.verifier.check(current);
					await this.emit({ type: "verifier.result", taskId: id, ok: verdict.ok, detail: verdict.detail });
					verified = verdict.ok;
					failDetail = verdict.detail ?? "";
				}
			}
			if (!verified) {
				await this.stallTask(id, `acceptance check did not pass${failDetail ? `: ${failDetail}` : ""}`);
				continue;
			}
			for (const step of this.state.ledger.tasks[id]!.steps.filter((s) => s.status !== "done")) {
				if (step.status !== "in_progress" && checkStepUpdate(this.state.ledger, id, step.id, "in_progress", [], this.state.outcomes).ok) {
					await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "in_progress", callIds: [] });
				}
				if (checkStepUpdate(this.state.ledger, id, step.id, "done", [], this.state.outcomes).ok) {
					await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "done", callIds: [] });
				}
			}
			if (checkTransition(this.state.ledger, id, "done").ok) await this.emit({ type: "task.updated", id, to: "done" });
		}
	}

	/** Close-out attempts per task — a stalled task gets one refusal cycle to recover before the harness marks it blocked. */
	private closeAttempts = new Map<string, number>();

	/** Emit task.updated → blocked when the transition is legal, with the reason recorded on the event. */
	private async blockTask(id: string, reason: string): Promise<void> {
		const task = this.state.ledger.tasks[id];
		if (!task || task.status === "done" || task.status === "blocked") return;
		if (task.status !== "in_progress" && checkTransition(this.state.ledger, id, "in_progress").ok) {
			await this.emit({ type: "task.updated", id, to: "in_progress" });
		}
		if (checkTransition(this.state.ledger, id, "blocked").ok) {
			await this.emit({ type: "task.updated", id, to: "blocked", reason });
		}
	}

	/** First stall just refuses (the model gets another turn); a second consecutive stall means the task can't complete — block it. */
	private async stallTask(id: string, reason: string): Promise<void> {
		const n = (this.closeAttempts.get(id) ?? 0) + 1;
		this.closeAttempts.set(id, n);
		if (n >= 2) await this.blockTask(id, reason);
	}

	/** Returns session-log events by seq so the model can recover elided output. Capped to keep the reply small. */
	private async runLogSlice(call: ToolCall): Promise<ToolResult> {
		const input = (call.input ?? {}) as { from?: unknown; to?: unknown };
		if (!Number.isInteger(input.from) || !Number.isInteger(input.to) || (input.from as number) < 1 || (input.to as number) < (input.from as number)) {
			return { ok: false, output: "log_slice needs integers from and to, with 1 <= from <= to." };
		}
		const events = (await this.deps.log.read()).filter((e) => e.seq >= (input.from as number) && e.seq <= (input.to as number));
		const text = events.map((e) => JSON.stringify(e)).join("\n");
		return { ok: true, output: text.length > LOG_SLICE_CAP ? `${text.slice(0, LOG_SLICE_CAP)}\n...[truncated, narrow the range]` : text || "No events in that range." };
	}

	private async runExternal(call: ToolCall): Promise<ToolResult> {
		try {
			return await this.deps.tools.execute(call.name, call.input);
		} catch (err) {
			// A failing tool is a result the model can react to, not a failed run.
			return { ok: false, output: `tool error: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	private async applyTaskTool(call: ToolCall): Promise<ToolResult> {
		const rejected = (message: string): ToolResult => ({ ok: false, output: message });
		try {
			switch (call.name) {
				case TASK_TOOL_NAMES.create: {
					const input = parseTaskCreateInput(call.input);
					if (input.acceptance.kind === "reviewer") return rejected("Reviewer acceptance is not enabled yet; use kind command.");
					const task: Task = {
						id: input.id,
						title: input.title,
						acceptance: input.acceptance,
						dependsOn: input.dependsOn,
						status: "pending",
						steps: input.steps.map((s) => ({ id: s.id, text: s.text, status: "pending" as const, callIds: [], ...(s.signal ? { signal: s.signal } : {}) })),
						evidence: [],
					};
					const check = checkCreate(this.state.ledger, task);
					if (!check.ok) return rejected(check.message);
					await this.emit({ type: "task.created", task });
					return { ok: true, output: `Created task ${task.id} with ${task.steps.length} step(s).` };
				}
				case TASK_TOOL_NAMES.stepAdd: {
					const { taskId, step } = parseTaskStepAddInput(call.input);
					const check = checkStepAdd(this.state.ledger, taskId, step);
					if (!check.ok) return rejected(check.message);
					await this.emit({ type: "step.added", taskId, step });
					return { ok: true, output: `Added step ${step.id} to ${taskId}.` };
				}
				case TASK_TOOL_NAMES.stepUpdate: {
					const input = parseTaskStepUpdateInput(call.input);
					const check = checkStepUpdate(this.state.ledger, input.taskId, input.stepId, input.status, input.callIds, this.state.outcomes);
					if (!check.ok) return rejected(check.message);
					await this.emit({ type: "step.updated", taskId: input.taskId, stepId: input.stepId, to: input.status, callIds: input.callIds });
					return { ok: true, output: `Step ${input.stepId} is now ${input.status}.` };
				}
				case TASK_TOOL_NAMES.remove: {
					const { id } = parseTaskRemoveInput(call.input);
					const check = checkRemove(this.state.ledger, id);
					if (!check.ok) return rejected(check.message);
					await this.emit({ type: "task.removed", id });
					return { ok: true, output: `Removed task ${id}.` };
				}
				default:
					return await this.updateTask(parseTaskUpdateInput(call.input));
			}
		} catch (err) {
			if (err instanceof SchemaError) return rejected(`invalid input: ${err.message}`);
			throw err;
		}
	}

	private async updateTask(input: { id: string; status: Task["status"]; reason?: string }): Promise<ToolResult> {
		const rejected = (message: string): ToolResult => ({ ok: false, output: message });
		const reasonField = input.reason === undefined ? {} : { reason: input.reason };
		const check = checkTransition(this.state.ledger, input.id, input.status);
		if (check.ok) {
			await this.emit({ type: "task.updated", id: input.id, to: input.status, ...reasonField });
			return { ok: true, output: `Task ${input.id} is now ${input.status}.` };
		}
		if (check.code !== "needs_verification") return rejected(check.message);
		const task = this.state.ledger.tasks[input.id];
		if (!task) return rejected(`unknown task ${input.id}`);
		if (task.acceptance.kind === "none") {
			await this.emit({ type: "verifier.result", taskId: input.id, ok: true, detail: "no acceptance check" });
		} else if (task.acceptance.kind === "command") {
			if (!this.deps.verifier) return rejected("No acceptance verifier is configured, so a task cannot be marked done.");
			const verdict = await this.deps.verifier.check(task);
			await this.emit({ type: "verifier.result", taskId: input.id, ok: verdict.ok, detail: verdict.detail });
			if (!verdict.ok) return rejected(`Acceptance check failed for ${input.id}: ${verdict.detail}`);
		} else {
			return rejected("Reviewer acceptance is not enabled; use a command check");
		}
		const recheck = checkTransition(this.state.ledger, input.id, input.status);
		if (!recheck.ok) return rejected(recheck.message);
		await this.emit({ type: "task.updated", id: input.id, to: input.status, ...reasonField });
		return { ok: true, output: `Task ${input.id} is done; the acceptance check passed.` };
	}

	private async stopCheck(): Promise<void> {
		await this.closeBoard();
		const ledger: Ledger = this.state.ledger;
		const open = openTasks(ledger, this.deps.runId);
		if (open.length === 0) {
			const verdict = await this.steering.run("onStop", { ledger });
			await this.noteAll(verdict.notes);
			if (verdict.verdict.kind === "allow") {
				const blocked = blockedTasks(ledger).filter((id) => ledger.tasks[id]?.runId === this.deps.runId).map((id) => {
					const t = ledger.tasks[id]!;
					return `${id} ${t.title}${t.evidence.length ? ` — ${t.evidence.at(-1)}` : ""}`;
				});
				if (blocked.length) await this.emit({ type: "steer.note", rule: "finish.blocked", text: `Finished with blocked task(s): ${blocked.join("; ")}` });
				if (this.deps.nudgeWrites && this.window.calls === 0 && !this.window.nudged) {
					this.window.nudged = true;
					await this.emit({ type: "steer.note", rule: "nudge.proceed", text: "You ended the run without calling any tools or changing files. If the task asks for implementation or exploration, do it now using your tools. If you are blocked on something only the user can provide, state exactly what is missing." });
					return this.enter("ModelCall");
				}
				return this.enter("Verify");
			}
		}
		if (this.window.refusals >= this.limits.maxRefusals) return this.pause("open_tasks");
		this.window.refusals++;
		await this.emit({ type: "stop.refused", openTaskIds: openTasks(this.state.ledger, this.deps.runId) });
		this.enter("ModelCall");
	}

	private async verify(): Promise<void> {
		const ledger: Ledger = this.state.ledger;
		const open = openTasks(ledger, this.deps.runId);
		if (open.length) throw new Error(`invariant: finish reached with open tasks ${open.join(", ")}`);
		const unverified = tasksOfRun(ledger, this.deps.runId).filter((id) => ledger.tasks[id]?.status === "done" && !ledger.verified.includes(id));
		if (unverified.length) throw new Error(`invariant: done without a passing check: ${unverified.join(", ")}`);
		this.enter("Done");
	}
}
