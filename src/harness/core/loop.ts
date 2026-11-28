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
	SchemaError,
	type ImageInput,
	type EventBody,
	type LoopDetectorConfig,
	type ModelPort,
	type SessionEvent,
	type Acceptance,
	type Task,
	type ToolCall,
	type ToolPort,
	type ToolResult,
	type ToolSpec,
	type Usage,
	type VerifierPort,
} from "./contracts";
import { callFingerprint } from "./canonical";
import { LOG_SLICE, LOG_SLICE_SPEC, SYSTEM_INSTRUCTIONS } from "../defaults/context";
import { settledCalls } from "../defaults/evidence";
import { statelessStrategy } from "../defaults/strategy";
import { READ_FILES } from "../tools/batchReads";
import type { EventLog } from "./eventLog";
import type { LoopReason } from "./policies/loopControl";
import type { RequestStrategy, StrategyCtx } from "./policies/requestStrategy";
import { defaultBehavior, type HarnessBehavior } from "./behavior";
import { initialState, project, reduce, type HarnessState } from "./projections";
import { callIsReadOnly, SteeringRegistry } from "../defaults/steering";
import { inferStepSignal } from "../planning/planSeed";
import { acceptanceProblem,
	applyLedgerEvent,
	checkCreate,
	checkRemove,
	checkStepAdd,
	checkStepUpdate,
	checkTransition,
	blockedTasks,
	activePlanId,
	nextPlanId,
	openSteps,
	openTasks,
	signalHits,
	stepSettled,
	tasksOfRun,
	parseTaskCreateInput,
	parseTaskRemoveInput,
	parseTaskReplaceInput,
	parseTaskStepAddInput,
	parseTaskStepUpdateInput,
	parseTaskUpdateInput,
	resolveTaskId,
	TASK_TOOL_NAMES,
	TASK_TOOL_SET,
	TASK_TOOLS,
	type Ledger,
} from "./taskLedger";

/** Turns in a row the model may write a tool call as text before the run stops asking. */
const TEXT_TOOL_RETRIES = 2;

/** The name of a tool the model wrote as text instead of calling it: JSON ({"name":"read_file","args":{...}}) or markup (<function=read_file> / <invoke name="read_file">). Only names this run offers count, so quoted examples of anything else never trip it. */
const TEXT_TOOL_FORMS = [/\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:args|arguments|input|parameters)"\s*:/g, /<function=([A-Za-z_][\w.-]*)\s*>/g, /<invoke\s+name="([^"]+)"/g];
const textToolCall = (text: string, names: ReadonlySet<string>): string | undefined => {
	for (const form of TEXT_TOOL_FORMS) {
		for (const m of text.matchAll(form)) if (names.has(m[1]!)) return m[1];
	}
	return undefined;
};

/** A board task supplied by the host instead of the planner (e.g. a plan file's steps). */
export interface SeedTask {
	title: string;
	steps: string[];
	acceptance?: Acceptance;
}


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

/** Structured user questions: the model asks through the tool instead of ending
 *  a turn with prose questions. The kernel intercepts the call, logs the
 *  questions as data, and pauses — the UI renders them as an interactive
 *  survey rather than parsing natural text. */
export const ASK_USER = "ask_user";
const ASK_USER_SPEC: ToolSpec = {
	name: ASK_USER,
	description:
		"Ask the user questions and wait for their answers. Use whenever you need information only the user has — decisions, missing requirements, credentials, or a choice between approaches. Each question may carry options the user can pick from; the user can always answer in free text instead. The run pauses until they reply, so ask everything blocking you in one call. Do not end a turn with questions in plain text — always use this tool.",
	inputSchema: {
		type: "object",
		properties: {
			questions: {
				type: "array",
				items: {
					type: "object",
					properties: {
						question: { type: "string", description: "One concrete question." },
						options: { type: "array", items: { type: "string" }, description: "Selectable choices, when the answer space is known." },
					},
					required: ["question"],
				},
			},
		},
		required: ["questions"],
	},
};

/** Reads ask_user input into the logged shape — tolerates the loose objects models emit. */
function sanitizeQuestions(input: unknown): Array<{ question: string; options?: string[] }> {
	const list = (input as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(list)) return [];
	const out: Array<{ question: string; options?: string[] }> = [];
	for (const item of list.slice(0, 8)) {
		const q = (item as { question?: unknown })?.question;
		const question = typeof q === "string" ? q.trim() : "";
		if (!question) continue;
		const raw = (item as { options?: unknown }).options;
		const options = Array.isArray(raw) ? raw.filter((o): o is string => typeof o === "string" && o.trim().length > 0).slice(0, 6) : undefined;
		out.push(options?.length ? { question, options } : { question });
	}
	return out;
}

export const DEFAULT_LIMITS: HarnessLimits = { maxTurns: 50, maxInputTokens: 2_000_000, maxRefusals: 3 };

export interface HarnessDeps {
	runId: string;
	log: EventLog;
	model: ModelPort;
	tools: ToolPort;
	verifier?: VerifierPort;
	limits?: Partial<HarnessLimits>;
	/** Called when a window hits maxTurns. Returning true extends the ceiling by the configured amount; false/undefined pauses. */
	onTurnLimit?: (used: number, limit: number) => Promise<boolean>;
	/** Rules out a steering "ask" verdict (e.g. plan.drift). True continues the
	 *  run; false or absent pauses with the question as the reason. */
	onSteerAsk?: (question: string) => Promise<boolean>;
	loop?: Partial<LoopDetectorConfig>;
	/** Resolved provider/model behavior; defaults to the shared implementations. */
	behavior?: HarnessBehavior;
	/** Defaults to the behavior's steering rules. Pass a registry to add or replace rules. */
	steering?: SteeringRegistry;
	/** Aborting this (the user's Stop) stops the run at the next step, cancelling any in-flight model request. */
	signal?: AbortSignal;
	/** Write modes: a run that ends without any tool call gets one nudge to proceed. */
	nudgeWrites?: boolean;
	/** False in read-only modes (ask/plan): the planner must not emit write steps and command acceptances are coerced to none. Defaults to true.
	 * May be an accessor — mode decisions (write gating, stop logic, plan
	 * termination) evaluate the mode at the moment they're made, so a composer
	 * mode flip mid-run takes effect instead of the run keeping its birth mode. */
	writable?: boolean | (() => boolean);
	/** Called after each event is applied to the projection. Used by the UI for the task board. */
	onState?: (state: HarnessState, event: SessionEvent) => void;
	/** System prompt for every request. Defaults to the harness instructions. Must stay identical across runs for cache hits. */
	system?: string;
	/** Streams reasoning/thinking chunks to the UI as they arrive, when the provider emits them. */
	onReasoningDelta?: (text: string) => void;
	/** Streams assistant text chunks to the UI as they arrive, when the provider emits them. */
	onTextDelta?: (text: string) => void;
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

const registryFor = (rules: ReturnType<HarnessBehavior["steering"]["rules"]>): SteeringRegistry => {
	const registry = new SteeringRegistry();
	for (const { point, rule } of rules) registry.add(point, rule);
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
	private textToolStrikes = 0;
	private budgetWarned = false;
	/** Session input counter when this run began — the run's own spend is measured from here. */
	private runSpendStart = 0;
	/** Log seq when this run began — a passing acceptance check counts as proof anywhere in the run, not only after a task started. */
	private runStartSeq = 0;
	/** Last request's input usage — the real context size, unlike the cumulative counter. */
	private lastInputTokens = 0;
	private lastCachedTokens = 0;
	/** Open divergence episode id. Off-plan write/run work is recorded as board
	 *  tasks (origin: divergence) with the normal lifecycle — the report reads
	 *  them as what the model actually did outside the plan, not noise. */
	private divergenceId: string | undefined;
	private divergenceScanned = false;
	private running = false;
	private readonly limits: HarnessLimits;
	/** Per-extension quantum when the user continues past a turn limit. */
	private readonly turnWindow: number;
	/** Per-extension quantum when the user continues past the input budget. */
	private readonly tokenWindow: number;
	private readonly loopCfg: LoopDetectorConfig;
	/** Every spec the loop can handle, including harness-reserved task tools (kept for back-compat calls). */
	private readonly tools: readonly ToolSpec[];
	/** Specs actually offered to the model. The task board is harness-owned, so task tools are handled but never advertised — except in seeded runs, whose steps carry no signals and can only be closed by the model. */
	private offered: readonly ToolSpec[];
	private readonly steering: SteeringRegistry;
	private readonly system: string;
	private readonly abort = new AbortController();
	/** Resolved provider/model policies. The kernel holds all invariants; these hold the per-model judgment. */
	private readonly behavior: HarnessBehavior;
	/** Request lifecycle for this model — the port's own strategy, or the stateless projection default. */
	private readonly strategy: RequestStrategy;

	constructor(private readonly deps: HarnessDeps) {
		deps.signal?.addEventListener("abort", () => this.abort.abort(), { once: true });
		if (deps.signal?.aborted) this.abort.abort();
		this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
		this.turnWindow = this.limits.maxTurns;
		this.tokenWindow = this.limits.maxInputTokens;
		this.behavior = deps.behavior ?? defaultBehavior();
		this.loopCfg = this.behavior.loopControl.config(deps.loop);
		this.strategy = deps.model.strategy ?? statelessStrategy;
		this.steering = deps.steering ?? registryFor(this.behavior.steering.rules({ writable: typeof deps.writable === "function" ? deps.writable() : deps.writable !== false, runId: deps.runId }));
		this.system = deps.system ?? SYSTEM_INSTRUCTIONS;
		const external = deps.tools.specs();
		const clash = external.find((t) => TASK_TOOL_SET.has(t.name) || t.name === LOG_SLICE || t.name === ASK_USER);
		if (clash) throw new Error(`tool name ${clash.name} is reserved by the harness`);
		this.tools = [...TASK_TOOLS, LOG_SLICE_SPEC, ASK_USER_SPEC, ...external];
		// Task creation/removal stays planner-owned. Revisions and status moves are
		// the model's job — steering already names task_step_add/task_update, so they
		// must be callable. The kernel validates every proposal before it lands.
		const harnessOwned: ReadonlySet<string> = new Set([TASK_TOOL_NAMES.create, TASK_TOOL_NAMES.remove]);
		this.offered = this.tools
			.filter((t) => !harnessOwned.has(t.name))
			.map((t) => (t.name === TASK_TOOL_NAMES.stepUpdate ? this.behavior.evidence.stepTool() : t));
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Compact now: the next model call writes a recap of everything older than the recent window. A port with its own request lifecycle compacts server-side, so there is nothing to request. */
	requestCompact(): boolean {
		if (!this.running || this.deps.model.strategy) return false;
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
	async run(text: string, context?: string, images?: ImageInput[], opts?: { plan?: boolean; seed?: SeedTask[]; notes?: string[] }): Promise<RunOutcome> {
		this.begin();
		this.planDelivered = false;
		await this.emit({ type: "run.status", status: "running" });
		// Internal steps the harness performed before the loop (reading AGENTS.md,
		// parsing the plan document) are surfaced as durable notes — visible in the
		// chat like every other harness decision, and replayed with the session.
		await this.emit({ type: "user.input", text: context ? `${context}\n\n${text}` : text, ...(images?.length ? { images } : {}) });
		for (const note of opts?.notes ?? []) await this.emit({ type: "steer.note", rule: "harness.step", text: note });
		this.planDocFromTaskText(text);
		if (opts?.seed?.length) await this.seedBoard(opts.seed);
		else if (opts?.plan) await this.planBoard(text);
		if (this.phase !== "Paused") this.enter("ModelCall");
		return this.guarded(() => this.drive());
	}

	/**
	 * Host-seeded board ("implement this plan"): the plan document already
	 * declares the work, so its steps land on the ledger as this run's tasks
	 * without a planner call. The model's scope is bounded to the seed — the
	 * run shows only these tasks, and a seeded acceptance command becomes the
	 * close-out gate: a failed check stalls the task and reports the failure,
	 * so the model fixes the cause or finds an alternative instead of passing.
	 */
	private async seedBoard(seed: readonly SeedTask[]): Promise<void> {
		const base = this.state.ledger.order.length;
		let seeded = 0;
		for (const s of seed) {
			// Plan phases are sequential by construction — chaining dependencies is
			// what keeps one phase active at a time. Without it every seeded task
			// activates at once and the model works all phases in parallel while
			// the drift detector counts that in-order work as unproductive.
			const task: Task = {
				id: `t${base + seeded + 1}`,
				title: s.title,
				acceptance: s.acceptance ?? { kind: "none" },
				dependsOn: seeded > 0 ? [`t${base + seeded}`] : [],
				status: "pending",
				steps: s.steps.map((text, i) => {
					// Seeded steps carry inferred signals where the plan names a
					// command — the harness then auto-closes them when the work
					// happens, and the model only manually closes what inference
					// can't cover. State moves both ways: the board flows to the
					// model each turn, tool evidence flows back into the board.
					const signal = inferStepSignal(text);
					return { id: `s${i + 1}`, text, status: "pending" as const, callIds: [], ...(signal ? { signal } : {}) };
				}),
				evidence: [],
				runId: this.deps.runId,
				planId: activePlanId(this.state.ledger, this.deps.runId) ?? nextPlanId(this.state.ledger),
			};
			const check = checkCreate(this.state.ledger, task);
			if (!check.ok) {
				await this.emit({ type: "steer.note", rule: "plan.seed", text: `Skipped an invalid seeded task "${task.title}": ${check.message}` });
				continue;
			}
			await this.emit({ type: "task.created", task });
			seeded++;
		}
		if (seeded) await this.emit({ type: "steer.note", rule: "plan.seed", text: `Plan seeded: ${seeded} task${seeded === 1 ? "" : "s"} on the board, one phase at a time. Work the active task's steps in order; when a step's work is done close it — task_step_update with status "done" (the harness attaches the proving calls itself).` });
		await this.advanceBoard();
	}

	/**
	 * Harness-owned board: one planner call decomposes the task into ledger
	 * events before the first model turn. Ids are remapped into the session's
	 * id space and invalid entries are skipped, so a bad plan degrades to fewer
	 * tasks, never a failed run. The planner's token usage rides on the first
	 * task.created event so it counts against the session budget.
	 */
	/** The plan document this run works from (task-text path or a plan tool
	 * call). When the board is replaced the doc goes stale — tracked so the
	 * harness can offer to bring it back in sync. */
	private planDoc?: { label: string; how: string };

	private planDocFromTaskText(text: string): void {
		const paths = text.match(/[\w./~:-]+\.md\b/g) ?? [];
		const planish = paths.find((p) => /plan/i.test(p)) ?? paths[0];
		if (planish) this.planDoc = { label: planish, how: `edit_file/write_file on ${planish}` };
	}

	private planDelivered = false;

	/** The run's writability right now — live when the host passes an accessor. */
	private isWritable(): boolean {
		const w = this.deps.writable;
		return typeof w === "function" ? w() : w !== false;
	}

	private planDocFromCall(call: ToolCall, ok: boolean, output: string): void {
		if (!ok) return;
		if (call.name === "save_plan") {
			const rel = /Plan saved to (\S+)/.exec(output)?.[1];
			if (rel) this.planDoc = { label: rel, how: `save_plan (same slug/path) or edit_file on ${rel}` };
		} else if (call.name === "read_plan") {
			const slug = typeof call.input === "object" && call.input ? String((call.input as Record<string, unknown>).slug ?? "") : "";
			if (slug) this.planDoc ??= { label: `the saved plan "${slug}"`, how: `save_plan with slug "${slug}"` };
		}
	}

	private async planBoard(taskText: string): Promise<void> {
		const writable = this.isWritable();
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
		// No plan-document injection here: implementation intent toward a doc is
		// seeded deterministically upstream and never reaches the planner, and
		// reference docs ride in the task text via @-expansion. The planner
		// grounds free-form tasks only.
		// The planner call is a full unstreamed model call — surface it so the
		// gap between run start and the first task reads as work, not a hang.
		await this.emit({ type: "steer.note", rule: "plan.start", text: "Planning this run's task board…" });
		const plan = await this.behavior.planner.plan(this.deps.model, taskText, { signal: this.abort.signal, writable, board, plans: savedPlans });
		// The planner failed or returned garbage — the fallback board ("Complete
		// the task") fits nothing, so every real call scores as drift. Ask the
		// user before burning turns on a dead board: continue means the model
		// writes its own board, reject stops here so a real plan can be given.
		if (plan.fallback) {
			const question = "Planning failed — the task board is just a placeholder, so progress can't be scored. Continue anyway (the agent writes its own board), or stop and send the plan?";
			const proceed = this.deps.onSteerAsk ? await this.deps.onSteerAsk(question) : true;
			if (!proceed) {
				await this.pause(question);
				return;
			}
			await this.emit({ type: "steer.note", rule: "plan.fallback", text: "Planning failed, so the board is a placeholder task. Replace it with your real plan — task_replace writes the new board in one call (or reuse a saved plan with read_plan), then work it. Calls can't score until the board matches." });
		}
		if (plan.reusePlan) {
			await this.emit({ type: "steer.note", rule: "plan.reuse", text: `A saved plan "${plan.reusePlan}" already covers this — recall it with read_plan and answer from it. No new tasks.` });
			return;
		}
		// Scope rule: a new run's board holds only tasks created for it — prior
		// runs are context (the board the planner sees, run digests, recall),
		// never executable scope. continueIds are therefore not adopted here;
		// continuing an unfinished run is what resume() is for: it re-enters
		// under the same runId and inherits the board untouched.
		if (plan.tasks.length === 0 && board) {
			await this.emit({ type: "steer.note", rule: "plan.reuse", text: "No new tasks for this ask — earlier runs' work is context, not this run's scope. Send \"continue\" to resume that run's own board." });
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
		const boardPlan = nextPlanId(this.state.ledger);
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
			const planned = { ...task, planId: boardPlan };
			if (!checkCreate(sim, planned).ok) continue;
			await this.emit({ type: "task.created", task: planned, ...(first && plan.usage ? { usage: plan.usage } : {}) });
			sim = applyLedgerEvent(sim, { type: "task.created", task: planned });
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
		this.begin();
		await this.emit({ type: "run.status", status: "running" });
		this.enter("ModelCall");
		return this.guarded(() => this.drive());
	}

	private begin(): void {
		if (this.running) throw new Error("a run is already in progress");
		this.running = true;
		this.runSpendStart = this.state.counters.inputTokens;
		this.runStartSeq = this.state.lastSeq;
		this.window = { turns: 0, refusals: 0, calls: 0, nudged: false };
		this.phases = [];
		this.reason = undefined;
		this.userAsked = false;
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
		if (this.planDelivered) {
			// The plan document is saved — the run's deliverable exists. End here
			// rather than handing the model another turn it would spend implementing.
			await this.emit({ type: "steer.note", rule: "plan.delivered", text: "Plan saved — the run ends here. Review the plan and start implementation when ready." });
			return this.enter("Done");
		}
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
		// A beforeModel denial instructs the MODEL ("stop exploring — report what
		// you found") — pausing here froze the run so it could never comply, and
		// the user inherited a model-behavior problem. Instead the denial rides
		// as a strong note and this turn's tools are stripped: with nothing to
		// call, the model can only write up or state its blocker, then the run
		// finishes or continues honestly. The deny rules carry their own
		// hysteresis, so compliance is never punished by an instant re-deny.
		if (before.verdict.kind === "deny") {
			await this.noteAll([{ rule: before.verdict.rule, text: `${before.verdict.reason} Tools are stripped for this turn — respond with text.` }]);
			this.stripOnce = true;
		}
		if (before.verdict.kind === "ask") {
			const proceed = this.deps.onSteerAsk ? await this.deps.onSteerAsk(before.verdict.question) : false;
			if (!proceed) return this.pause(before.verdict.question);
		}
		if (this.window.turns >= this.limits.maxTurns) {
			const proceed = this.deps.onTurnLimit ? await this.deps.onTurnLimit(this.window.turns, this.limits.maxTurns) : false;
			if (!proceed) return this.pause("max_turns");
			this.limits.maxTurns += this.turnWindow;
		}
		if (this.runSpend() >= this.limits.maxInputTokens) {
			// This run's own spend reached its allowance: extend it and say so.
			// Spend is a meter, not context — nothing is compacted and nothing is asked.
			this.limits.maxInputTokens += this.tokenWindow;
			this.budgetWarned = false;
			await this.emit({ type: "steer.note", rule: "context.budget", text: `This run has spent ${Math.round(this.runSpend() / 1000)}k input tokens — allowance extended to ${Math.round(this.limits.maxInputTokens / 1000)}k. Context is unchanged.` });
		}
		// Strip level (after two flagged calls) removes tools for the next model turn; derived from strikes so it survives recovery.
		const tools = this.state.strikes === STRIP_STRIKES || this.stripOnce ? [] : this.offered;
		this.stripOnce = false;
		// ask_user is always available, even on stripped turns — a model ordered
		// to write up may instead need the user, and that is a legitimate escape.
		this.turnTools = new Set([...tools.map((t) => t.name), ASK_USER]);
		// Recap triggers are consumed here and handed to the strategy, which decides whether they apply (the stateless lifecycle recaps; server-side lifecycles compact remotely).
		const recap = { lastInputTokens: this.lastInputTokens, taskDone: this.taskRecapPending, forced: this.forceRecap };
		this.taskRecapPending = false;
		this.forceRecap = false;
		const getState = () => this.state;
		const ctx: StrategyCtx = {
			get state() {
				return getState();
			},
			offered: this.offered,
			tools,
			system: this.system,
			turn,
			runId: this.deps.runId,
			emit: (body) => this.emit(body),
			signal: this.abort.signal,
			onReasoningDelta: this.deps.onReasoningDelta,
			onTextDelta: this.deps.onTextDelta,
			behavior: this.behavior,
			model: this.deps.model,
			recap,
			complete: (request) => this.deps.model.complete(request),
		};
		const request = await this.strategy.call(ctx);
		const response = request.response;
		const ids = new Set(response.toolCalls.map((c) => c.callId));
		if (ids.size !== response.toolCalls.length) throw new Error("model returned duplicate tool call ids");
		const usage: Usage | undefined = response.usage;
		if (usage?.inputTokens) this.lastInputTokens = usage.inputTokens;
		if (usage?.cachedTokens) this.lastCachedTokens = usage.cachedTokens;
		await this.emit({
			type: "model.response",
			turn,
			text: response.text,
			toolCalls: response.toolCalls,
			...(usage ? { usage } : {}),
			...(response.reasoning ? { reasoning: response.reasoning } : {}),
			...(response.providerItems ? { providerItems: response.providerItems } : {}),
		});
		// The response is logged; the request lifecycle commits whatever it now knows (e.g. a server copy is synced).
		await this.strategy.committed?.(ctx, request);
		this.window.turns++;
		await this.checkBudgetWarning();
		const unexecuted = response.toolCalls.length ? undefined : textToolCall(response.text, new Set(this.tools.map((t) => t.name)));
		if (!unexecuted) this.textToolStrikes = 0;
		else {
			// The text was never a call, so nothing ran: say so and ask again while retries last.
			await this.emit({ type: "steer.note", rule: "tool.text", text: `Your last message wrote a "${unexecuted}" call as text, so nothing ran. Call tools through the tool interface — text is never executed.` });
			if (this.textToolStrikes < TEXT_TOOL_RETRIES) {
				this.textToolStrikes++;
				this.enter("ModelCall");
				return;
			}
		}
		this.pendingCalls = response.toolCalls;
		this.enter(response.toolCalls.length ? "ToolBatch" : "StopCheck");
	}

	/** This run's input spend so far — the session counter is cumulative across runs. */
	private runSpend(): number {
		return this.state.counters.inputTokens - this.runSpendStart;
	}

	private async checkBudgetWarning(): Promise<void> {
		const used = this.runSpend();
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
		for (const pending of this.pendingCalls) {
			// Server-conversation transports manage ids end-to-end; anything the model puts in callIds is noise.
			const call = this.behavior.evidence.attach(pending, this.state, { ignoreCited: this.deps.model.capabilities?.wire === "conversations" });
			if (this.abort.signal.aborted) stopped ??= "stopped";
			if (stopped) {
				await flush();
				await this.refused(call, `Not run: ${stopped}.`);
				continue;
			}
			if (this.state.outcomes[call.callId] !== undefined) continue;
			// Structured user questions bypass the gates — nothing executes, the
			// questions are logged as data and the run pauses once the batch drains.
			if (call.name === ASK_USER) {
				await flush();
				const questions = sanitizeQuestions(call.input);
				if (!questions.length) {
					await this.finish(call, false, "ask_user needs at least one question — ask what is blocking you, with options when the choices are known.");
					continue;
				}
				await this.emit({ type: "user.question", questions });
				this.userAsked = true;
				await this.finish(call, true, "Questions delivered. The run is paused until the user answers — do not call more tools this turn.");
				continue;
			}
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
			// Defense in depth: a call the model was never offered (hallucinated,
			// or stripped this turn) never executes — it is refused with the
			// alternates the model does have, so it can adapt instead of stopping.
			// This runs after the loop gate on purpose: repetition of even a
			// refused call is still a loop, and the detector must see it.
			if (!TASK_TOOL_SET.has(call.name) && call.name !== LOG_SLICE && !this.turnTools.has(call.name)) {
				await flush();
				const alternates = this.offered.filter((t) => this.turnTools.has(t.name)).map((t) => t.name);
				const why = alternates.length
					? `"${call.name}" is not available — it was never offered this turn. Use what you have: ${alternates.slice(0, 12).join(", ")}${alternates.length > 12 ? "…" : ""}.`
					: `"${call.name}" is not available — no tools are offered this turn. Respond with text only.`;
				await this.finish(call, false, `Refused: ${why}`);
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
		if (this.userAsked) return this.pause("question");
		this.enter("ModelCall");
	}

	private stopReason: string | undefined;
	/** One-turn tool strip from a beforeModel denial — forces a write-up turn instead of pausing the run. */
	private stripOnce = false;
	/** Tools actually offered on the current turn — calls outside this set are refused, never executed. */
	private turnTools: ReadonlySet<string> = new Set();
	/** Set when the model asked the user through ask_user — the batch completes, then the run pauses. */
	private userAsked = false;

	/** Per-call gates: loop control, then steering. Returns what the batch should do with the call. */

	/** The harness's own last acceptance result for this command: reusable when it passed earlier in this run and nothing that could change files ran after it. Only the harness's checks count; the model's commands are never inspected. */
	private reusableProof(task: Task): { seq: number } | undefined {
		if (task.acceptance.kind !== "command") return undefined;
		const command = task.acceptance.command;
		const mine = this.state.verdicts.filter((v) => v.command === command && v.seq > this.runStartSeq);
		const last = mine[mine.length - 1];
		if (!last?.ok) return undefined;
		return settledCalls(this.state, last.seq).every((s) => callIsReadOnly(s.call.name, s.call.input)) ? { seq: last.seq } : undefined;
	}

	/** The acceptance verdict for a task: a reusable harness result stands in for the verifier, otherwise the verifier runs. */
	private async acceptanceVerdict(task: Task, verifier: VerifierPort): Promise<{ ok: boolean; detail: string }> {
		const proof = this.reusableProof(task);
		if (proof && task.acceptance.kind === "command") return { ok: true, detail: `${task.acceptance.command} passed earlier in this run (check at seq ${proof.seq}) and nothing has changed since — not re-run.` };
		return verifier.check(task);
	}

	/** A signaled step that activates after its proof already ran is closed by that earlier call, so work done ahead of the board isn't lost. */
	private windowProof(taskId: string, step: Task["steps"][number]): string | undefined {
		const task = this.state.ledger.tasks[taskId];
		const signal = step.signal;
		if (!signal || !this.signalable(signal.tool) || task?.startedSeq === undefined) return undefined;
		return settledCalls(this.state, task.startedSeq).map((s) => s.call).find((c) => signalHits(signal, c))?.callId;
	}

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
		const reason = this.behavior.loopControl.detect(this.state.history, fingerprint, this.loopCfg);
		if (!reason) {
			if (this.state.strikes > 0) await this.emit({ type: "loop.verdict", level: "none", fingerprint });
			return { level: "none", fingerprint };
		}
		// Read-only calls escalate warn → block but never strip/pause. Warnings are
		// demonstrably ineffective on weaker models — the reasoning acknowledges
		// them and the action repeats anyway, so the second offense is refused:
		// a refusal forces a different action, a note doesn't. The first repeat
		// still only warns, so legitimate re-reads after compaction (which need
		// exactly one re-read, not a streak) are never blocked; and a blocked
		// read never strips tools or kills the run.
		const level = this.behavior.loopControl.levelForStrikes(this.state.strikes);
		const capped = callIsReadOnly(call.name, call.input) && level !== "none" ? (level === "warn" ? "warn" : "block") : level;
		await this.emit({ type: "loop.verdict", level: capped, fingerprint, reason: reason });
		return { level: capped, fingerprint, reason };
	}

	private async refused(call: ToolCall, output: string): Promise<void> {
		await this.emit({ type: "tool.requested", callId: call.callId, name: call.name, input: call.input });
		await this.finish(call, false, output);
	}

	private async finish(call: ToolCall, ok: boolean, output: string, usage?: Usage): Promise<void> {
		await this.emit({ type: "tool.finished", callId: call.callId, name: call.name, ok, output, ...(usage ? { usage } : {}) });
		this.planDocFromCall(call, ok, output);
		const after = await this.steering.run("afterTool", { call, ok, ledger: this.state.ledger });
		await this.noteAll(after.notes);
		// A saved/updated plan replaces what the run's board was built from —
		// nudge the model to realign open tasks before drift scores the new plan
		// as unproductive turns.
		if (ok && call.name === "save_plan" && !this.isWritable()) {
			// Plan mode's deliverable is the saved plan document, and saving it
			// ENDS the run — the user reviews the plan card and starts implementation
			// (or doesn't). Anything else traps the model: the board's implementation
			// tasks plus the open-work stop refusal physically force it to implement
			// the plan it just wrote, inside the mode that exists to prevent exactly
			// that. The batch drains first (call pairing), then modelCall ends the run.
			this.planDelivered = true;
		} else if (ok && call.name === "save_plan" && openSteps(this.state.ledger, this.deps.runId).length) {
			await this.noteAll([{ rule: "plan.saved", text: "Plan saved. If it replaces the current plan, realign the board now — task_replace rewrites it to the plan's phases in one call. Steps that no longer match the real work will stall and count as drift." }]);
		}
		// A replaced board strands the plan document this run works from — ask
		// the user whether to sync it, post-call so the card doesn't sit pending
		// on the question.
		if (ok && call.name === TASK_TOOL_NAMES.replace && this.planDoc) {
			const doc = this.planDoc;
			if (this.deps.onSteerAsk) {
				const sync = await this.deps.onSteerAsk(`The plan document ${doc.label} no longer matches the board — update it to the new plan?`);
				await this.noteAll([
					{
						rule: "plan.doc-sync",
						text: sync
							? `Approved: update ${doc.label} to match the new board — ${doc.how}. Keep it short: new phases, what changed, what's done.`
							: `${doc.label} stays stale as the user chose — don't update it.`,
					},
				]);
			} else {
				await this.noteAll([{ rule: "plan.doc-sync", text: `${doc.label} no longer matches the board — update it (${doc.how}) to keep the record current.` }]);
			}
		}
		await this.trackDivergence(call, ok);
		await this.advanceBoard(call, ok);
	}

	/**
	 * Board advancement, driven by the harness — never the model. A finished ok
	 * call satisfies the current step's predicted `signal` (first open step per
	 * task, callId cited as evidence). Then open tasks and their first open
	 * steps move to in_progress. All transitions are pre-checked, so this is a
	 * no-op when the board is already current.
	 */
	/** Write/run tools that count as work for divergence purposes — reads never do. */
	private static readonly DIVERGENCE_WRITES = new Set(["write_file", "edit_file", "file_editor", "append_file", "insert_lines", "apply_patch", "rename_symbol", "run_command", "start_process"]);

	/**
	 * Divergence tracking: the same on-plan test as the plan.offstep tripwire,
	 * but instead of only warning, the harness records the work as a board task
	 * (origin: divergence) with the normal lifecycle — opened pending →
	 * in_progress on the first off-plan write/run call, closed done when the
	 * model returns to plan work. Episodes left open at run end stay in_progress
	 * — the honest state of abandoned divergence. Reads and board edits are
	 * neutral: they neither extend nor close an episode. When no open step
	 * carries a signal the board predicts nothing, so nothing can diverge —
	 * an open episode closes there rather than branding all post-plan work.
	 */
	private async trackDivergence(call: ToolCall, ok: boolean): Promise<void> {
		if (TASK_TOOL_SET.has(call.name) || call.name === LOG_SLICE) return;
		if (callIsReadOnly(call.name, call.input)) return;
		if (!HarnessLoop.DIVERGENCE_WRITES.has(call.name)) return;
		// Resume-safe: the episode lives in the ledger, so rebuild the in-memory
		// pointer once rather than trusting constructor state.
		if (!this.divergenceScanned) {
			this.divergenceScanned = true;
			this.divergenceId = tasksOfRun(this.state.ledger, this.deps.runId)
				.filter((id) => this.state.ledger.tasks[id]?.origin === "divergence" && this.state.ledger.tasks[id]?.status === "in_progress")
				.at(-1);
		}
		const planTasks = tasksOfRun(this.state.ledger, this.deps.runId).filter((id) => {
			const t = this.state.ledger.tasks[id];
			return t && t.origin !== "divergence" && t.status !== "stale";
		});
		const open = planTasks
			.filter((id) => this.state.ledger.tasks[id]?.status !== "done")
			.flatMap((id) => (this.state.ledger.tasks[id]?.steps ?? []).filter((s) => s.status !== "done" && s.status !== "failed" && s.status !== "blocked" && s.signal).map((s) => ({ taskId: id, step: s })))
			.slice(0, 4);
		// Tracking is active once the board carries any signaled step, settled or
		// not — a fully-worked plan doesn't license unchecked writing: post-plan
		// writes are the purest divergence. A board that never had signals (seeded
		// signal-less steps) predicts nothing, so nothing can diverge from it.
		const anySignals = planTasks.some((id) => (this.state.ledger.tasks[id]?.steps ?? []).some((s) => s.signal));
		if (!anySignals) return;
		const onPlan =
			open.some((o) => signalHits(o.step.signal!, call)) ||
			// Writes serving a verify step are its fixup loop, not divergence.
			(HarnessLoop.DIVERGENCE_WRITES.has(call.name) && call.name !== "run_command" && call.name !== "start_process" && open.some((o) => o.step.signal!.tool === "run_command"));
		if (onPlan) {
			if (this.divergenceId) await this.closeDivergence();
			return;
		}
		if (this.divergenceId) return; // episode continues — the report reads the window
		// First off-plan call: open the episode. Ids use the x-prefix so they
		// never collide with plan tasks (t-prefix) — still scanned for safety.
		let n = 0;
		for (const id of Object.keys(this.state.ledger.tasks)) {
			const m = /^x(\d+)$/.exec(id);
			if (m) n = Math.max(n, Number(m[1]));
		}
		let id = `x${n + 1}`;
		while (this.state.ledger.tasks[id]) id = `x${++n + 1}`;
		this.divergenceId = id;
		const target = typeof (call.input as { path?: unknown })?.path === "string" ? ` ${(call.input as { path: string }).path.split("/").pop()}` : "";
		await this.emit({
			type: "task.created",
			task: { id, title: `Unplanned work — starting with ${call.name}${target}`, acceptance: { kind: "none" }, dependsOn: [], status: "pending", steps: [], evidence: [], runId: this.deps.runId, origin: "divergence" },
		});
		if (checkTransition(this.state.ledger, id, "in_progress").ok) {
			await this.emit({ type: "task.updated", id, to: "in_progress" });
		}
	}

	private async closeDivergence(): Promise<void> {
		const id = this.divergenceId!;
		this.divergenceId = undefined;
		// acceptance:none auto-verifies — the harness emits the result itself so
		// the done transition passes the verified-check.
		await this.emit({ type: "verifier.result", taskId: id, ok: true, detail: "no acceptance check" });
		if (checkTransition(this.state.ledger, id, "done").ok) {
			await this.emit({ type: "task.updated", id, to: "done" });
		}
	}

	private async advanceBoard(call?: ToolCall, ok = false): Promise<void> {
		// The board is run-scoped: only this run's tasks (incl. adopted ones) advance.
		const runTasks = () => tasksOfRun(this.state.ledger, this.deps.runId);
		// Steps only move on tasks that are actually running — a dep-blocked
		// task can't start, so its steps can't either (keeps startedSeq honest).
		const running = async (id: string): Promise<boolean> => {
			const task = this.state.ledger.tasks[id];
			if (!task || task.status === "done" || task.status === "blocked") return false;
			if (task.status === "in_progress") return true;
			if (checkTransition(this.state.ledger, id, "in_progress").ok) {
				await this.emit({ type: "task.updated", id, to: "in_progress" });
				return this.state.ledger.tasks[id]?.status === "in_progress";
			}
			return false;
		};
		if (call && ok) {
			// First hit only: identical verify commands recur across phases (every
			// plan ends each phase with the same `mvn compile`), and one run must
			// close exactly one step — the earliest open one — not all of them.
			for (const id of runTasks()) {
				const task = this.state.ledger.tasks[id];
				if (!task || task.status === "done" || task.status === "blocked") continue;
				const step = task.steps.find((s) => !stepSettled(s));
				const signal = step?.signal;
				if (!step || !signal) continue;
				if (!signalHits(signal, call)) continue;
				if (!(await running(id))) continue;
				if (step.status !== "in_progress" && checkStepUpdate(this.state.ledger, id, step.id, "in_progress", [], this.state.outcomes).ok) {
					await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "in_progress", callIds: [] });
				}
				if (checkStepUpdate(this.state.ledger, id, step.id, "done", [call.callId], this.state.outcomes).ok) {
					await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "done", callIds: [call.callId] });
				}
				break;
			}
		}
		for (const id of runTasks()) {
			if (!(await running(id))) continue;
			const current = this.state.ledger.tasks[id];
			const step = current?.steps.find((s) => !stepSettled(s));
			if (!step) continue;
			if (step.status === "pending" && checkStepUpdate(this.state.ledger, id, step.id, "in_progress", [], this.state.outcomes).ok) {
				await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "in_progress", callIds: [] });
			}
			// Re-check the window for already-running steps too — a proving call
			// may have landed before the step opened or under an earlier signal.
			const proof = this.state.ledger.tasks[id]?.steps.find((s) => s.id === step.id)?.status === "in_progress" ? this.windowProof(id, step) : undefined;
			if (proof && checkStepUpdate(this.state.ledger, id, step.id, "done", [proof], this.state.outcomes).ok) {
				await this.emit({ type: "step.updated", taskId: id, stepId: step.id, to: "done", callIds: [proof] });
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
			// Divergence records are harness-managed — they close on the return to
			// plan work or stay honestly in_progress, never force-closed here.
			if (task.origin === "divergence") continue;
			// A blocked dependency can never go done, so its dependents can't either.
			const blockedDep = task.dependsOn.find((d) => this.state.ledger.tasks[d]?.status === "blocked");
			if (blockedDep) {
				await this.blockTask(id, `dependency ${blockedDep} is blocked`);
				continue;
			}
			if (task.dependsOn.some((d) => this.state.ledger.tasks[d]?.status !== "done")) continue;
			const openSteps = task.steps.filter((s) => !stepSettled(s) && s.status !== "blocked");
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
					const verdict = await this.acceptanceVerdict(current, this.deps.verifier);
					await this.emit({ type: "verifier.result", taskId: id, ok: verdict.ok, detail: verdict.detail, command: current.acceptance.command });
					verified = verdict.ok;
					failDetail = verdict.detail ?? "";
				}
			}
			if (!verified) {
				await this.stallTask(id, `acceptance check did not pass${failDetail ? `: ${failDetail}` : ""}`);
				continue;
			}
			for (const step of this.state.ledger.tasks[id]!.steps.filter((s) => !stepSettled(s))) {
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

	/** Where a dep-blocked model should actually work: walk the dependency chain to the deepest unfinished task and name its first open step. */
	private depRedirect(depId: string): string {
		let current = depId;
		for (let depth = 0; depth < 8; depth++) {
			const task = this.state.ledger.tasks[current];
			if (!task) break;
			const waiting = task.status === "pending" ? task.dependsOn.find((d) => this.state.ledger.tasks[d]?.status !== "done") : undefined;
			if (waiting) {
				current = waiting;
				continue;
			}
			const open = task.steps.find((s) => s.status === "in_progress") ?? task.steps.find((s) => s.status !== "done" && s.status !== "failed" && s.status !== "blocked");
			if (open) return ` The open step is ${current}/${open.id} "${open.text.slice(0, 80)}" — work on that.`;
			return ` Finish ${current} first.`;
		}
		return ` Finish ${depId} first.`;
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
			return await this.deps.tools.execute(call.name, call.input, call.callId);
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
					if (input.acceptance.kind === "command") {
						const problem = acceptanceProblem(input.acceptance.command);
						if (problem) return rejected(`Refused: ${problem}`);
					}
					const task: Task = {
						id: input.id,
						title: input.title,
						acceptance: input.acceptance,
						dependsOn: input.dependsOn,
						status: "pending",
						steps: input.steps.map((s) => ({ id: s.id, text: s.text, status: "pending" as const, callIds: [], ...(s.signal ? { signal: s.signal } : {}) })),
						evidence: [],
						planId: activePlanId(this.state.ledger, this.deps.runId) ?? nextPlanId(this.state.ledger),
					};
					const check = checkCreate(this.state.ledger, task);
					if (!check.ok) return rejected(check.message);
					await this.emit({ type: "task.created", task });
					return { ok: true, output: `Created task ${task.id} with ${task.steps.length} step(s).` };
				}
				case TASK_TOOL_NAMES.replace: {
					// Whole-board replacement: the model declares the current plan
					// stale and supplies the new one atomically. Everything is
					// validated against a simulated ledger first — a bad
					// replacement leaves the old board untouched.
					const { tasks } = parseTaskReplaceInput(call.input);
					// Verification integrity: a replacement may not carry trivially-passing or
					// impossible acceptance commands — rewriting the board is not a way out of verification.
					for (const t of tasks) {
						if (t.acceptance.kind === "command") {
							const problem = acceptanceProblem(t.acceptance.command);
							if (problem) return rejected(`Refused: task ${t.id} — ${problem}`);
						}
					}
					const planId = nextPlanId(this.state.ledger);
					const prevPlan = activePlanId(this.state.ledger, this.deps.runId);
					// The old plan isn't deleted — its unfinished tasks go stale so
					// the board keeps the superseded plan as visible history.
					const drop = tasksOfRun(this.state.ledger, this.deps.runId).filter((id) => {
						const t = this.state.ledger.tasks[id];
						return t?.origin !== "divergence" && t?.status !== "done" && t?.status !== "stale";
					});
					let sim = this.state.ledger;
					for (const id of drop) sim = applyLedgerEvent(sim, { type: "task.updated", id, to: "stale" });
					// Topo-order the new tasks so dependsOn resolves declaration-independently.
					const known = new Set(sim.order);
					const emitted = new Set(sim.order);
					const pending = [...tasks];
					const ordered: typeof tasks = [];
					while (pending.length) {
						const idx = pending.findIndex((t) => t.dependsOn.every((d) => emitted.has(d) || pending.every((p) => p.id !== d)));
						if (idx < 0) return rejected(`replacement board has unsatisfiable dependsOn: ${pending.map((t) => t.id).join(", ")}`);
						const [t] = pending.splice(idx, 1);
						ordered.push(t!);
						emitted.add(t!.id);
					}
					const built: Task[] = [];
					for (const input of ordered) {
						if (input.acceptance.kind === "reviewer") return rejected("Reviewer acceptance is not enabled yet; use kind command.");
						const task: Task = {
							id: input.id,
							title: input.title,
							acceptance: input.acceptance,
							dependsOn: input.dependsOn.filter((d) => known.has(d) || ordered.some((o) => o.id === d)),
							status: "pending",
							steps: input.steps.map((s) => ({ id: s.id, text: s.text, status: "pending" as const, callIds: [], ...(s.signal ? { signal: s.signal } : {}) })),
							evidence: [],
							planId,
						};
						const check = checkCreate(sim, task);
						if (!check.ok)
							return rejected(
								check.message.includes("already exists")
									? `task "${task.id}" already exists on the board — done and stale tasks keep their ids as history, so replacement tasks need fresh ids`
									: check.message,
							);
						sim = applyLedgerEvent(sim, { type: "task.created", task });
						built.push(task);
					}
					for (const id of drop) await this.emit({ type: "task.updated", id, to: "stale" });
					for (const task of built) await this.emit({ type: "task.created", task });
					return { ok: true, output: `Plan ${planId} replaces ${prevPlan ?? "the old board"}: ${drop.length} task(s) marked stale, ${built.length} created. The stale plan is history on the board — leave it alone and work ${planId}'s steps.` };
				}
				case TASK_TOOL_NAMES.stepAdd: {
					const { taskId: rawTaskId, step } = parseTaskStepAddInput(call.input);
					const taskId = resolveTaskId(this.state.ledger, rawTaskId);
					const check = checkStepAdd(this.state.ledger, taskId, step);
					if (!check.ok) return rejected(check.message);
					await this.emit({ type: "step.added", taskId, step });
					return { ok: true, output: `Added step ${step.id} to ${taskId}.` };
				}
				case TASK_TOOL_NAMES.stepUpdate: {
					const input = parseTaskStepUpdateInput(call.input);
					input.taskId = resolveTaskId(this.state.ledger, input.taskId);
					const stepTask = this.state.ledger.tasks[input.taskId];
					const step0 = stepTask?.steps.find((s) => s.id === input.stepId);
					if (step0 && step0.status === input.status) return { ok: true, output: `Step ${input.stepId} is already ${input.status}.` };
					// A dep-blocked task can't run, so its steps can't move — finish the dependency first.
					const depBlock = stepTask?.status === "pending" ? stepTask.dependsOn.find((d) => this.state.ledger.tasks[d]?.status !== "done") : undefined;
					if (depBlock && input.status !== "pending") return rejected(`task ${input.taskId} is waiting on ${depBlock} — its steps can't move until the dependency is done.${this.depRedirect(depBlock)}`);
					const check = checkStepUpdate(this.state.ledger, input.taskId, input.stepId, input.status, input.callIds, this.state.outcomes, input.reason);
					if (!check.ok) return rejected(check.message);
					if (input.replacement && input.status !== "failed") return rejected("A replacement step only goes with status failed.");
					const replacement = input.replacement ? { ...input.replacement, status: "pending" as const, callIds: [] } : undefined;
					if (replacement) {
						const added = checkStepAdd(this.state.ledger, input.taskId, replacement);
						if (!added.ok) return rejected(added.message);
					}
					// Cited ids must point at real external work — harness-owned calls can't prove a step.
					if (input.callIds.length) {
						const names = new Map(this.state.messages.flatMap((m) => (m.kind === "assistant" ? m.toolCalls.map((c) => [c.callId, c.name] as const) : [])));
						const harnessCite = input.callIds.find((id) => TASK_TOOL_SET.has(names.get(id) ?? "") || names.get(id) === LOG_SLICE);
						if (harnessCite) return rejected(`step ${input.stepId} can't be proven by ${names.get(harnessCite)} — cite the external calls that did the work.`);
					}
					// A step moving on a pending task starts the task — emit the transition so the board and proof window stay honest.
					const task = this.state.ledger.tasks[input.taskId];
					if (input.status !== "pending" && task?.status === "pending" && checkTransition(this.state.ledger, input.taskId, "in_progress").ok)
						await this.emit({ type: "task.updated", id: input.taskId, to: "in_progress" });
					await this.emit({ type: "step.updated", taskId: input.taskId, stepId: input.stepId, to: input.status, callIds: input.callIds, ...(input.reason ? { reason: input.reason } : {}) });
					if (replacement) await this.emit({ type: "step.added", taskId: input.taskId, step: replacement });
					return { ok: true, output: `Step ${input.stepId} is now ${input.status}${replacement ? `; replacement step ${replacement.id} added` : ""}.` };
				}
				case TASK_TOOL_NAMES.remove: {
					const { id } = parseTaskRemoveInput(call.input);
					const resolved = resolveTaskId(this.state.ledger, id);
					const check = checkRemove(this.state.ledger, resolved);
					if (!check.ok) return rejected(check.message);
					await this.emit({ type: "task.removed", id: resolved });
					return { ok: true, output: `Removed task ${resolved}.` };
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
		input.id = resolveTaskId(this.state.ledger, input.id);
		const reasonField = input.reason === undefined ? {} : { reason: input.reason };
		if (this.state.ledger.tasks[input.id]?.status === input.status) return { ok: true, output: `Task ${input.id} is already ${input.status}.` };
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
			const verdict = await this.acceptanceVerdict(task, this.deps.verifier);
			await this.emit({ type: "verifier.result", taskId: input.id, ok: verdict.ok, detail: verdict.detail, command: task.acceptance.command });
			if (!verdict.ok) return rejected(`Acceptance check failed for ${input.id}: ${verdict.detail}`);
		} else {
			return rejected("Reviewer acceptance is not enabled; use a command check");
		}
		const recheck = checkTransition(this.state.ledger, input.id, input.status);
		if (!recheck.ok) return rejected(recheck.message);
		await this.emit({ type: "task.updated", id: input.id, to: input.status, ...reasonField });
		return { ok: true, output: `Task ${input.id} is done; the acceptance check passed.` };
	}

	/** The model ended its turn with a user-directed question — waiting for the
	 *  answer is the correct state, not a premature finish. The run pauses and
	 *  the user's reply continues the session. */
	private endsWithUserQuestion(): boolean {
		const last = [...this.state.messages].reverse().find((m) => m.kind === "assistant");
		if (!last || last.kind !== "assistant" || last.toolCalls.length) return false;
		return last.text.trimEnd().replace(/[*_`#>\s]+$/g, "").endsWith("?");
	}

	private async stopCheck(): Promise<void> {
		// A user-directed question pauses before any board mutation — the model is
		// waiting for an answer, not claiming the work is done.
		const asksUser = this.endsWithUserQuestion();
		if (asksUser) return this.pause("question");
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
		if (open.length && !this.isWritable()) {
			// Read-only runs can't finish implementation-shaped open work — refusing
			// the stop traps the model into implementing inside plan/ask mode, the
			// exact inversion of what the mode is for. End honestly: blocked, named.
			const names = open.map((id) => `${id} "${ledger.tasks[id]?.title ?? ""}"`).join(", ");
			for (const id of open) await this.emit({ type: "task.updated", id, to: "blocked", reason: "read-only run ended — implementation belongs to a code-mode run" });
			await this.emit({ type: "steer.note", rule: "finish.readonly", text: `Run ended in a read-only mode with task(s) not implementable here: ${names}` });
			return this.enter("Verify");
		}
		if (this.window.refusals >= this.limits.maxRefusals) {
			const names = open.map((id) => `${id} "${ledger.tasks[id]?.title ?? ""}"`).join(", ");
			const question = `The agent keeps trying to finish but these tasks are still open: ${names}. Continue working, or end the run here (they will be marked blocked)?`;
			const proceed = this.deps.onSteerAsk ? await this.deps.onSteerAsk(question) : false;
			if (proceed) {
				// Fresh refusal window — the user chose to let it keep working.
				this.window.refusals = 0;
			} else {
				// No frozen run: the open tasks are honestly marked blocked and the
				// run ends. The blocked list is surfaced in the finish note.
				for (const id of open) await this.emit({ type: "task.updated", id, to: "blocked", reason: "ended with the work unfinished" });
				await this.emit({ type: "steer.note", rule: "finish.blocked", text: `Run ended with open work marked blocked: ${names}` });
				return this.enter("Verify");
			}
		}
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
