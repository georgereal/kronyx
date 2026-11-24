/**
 * Steering layer (vscode-free): ordered rules at the lifecycle points. The loop
 * asks the registry; no policy lives in the loop itself.
 *
 * Precedence across rules at one point: deny > ask > allow. Notes from every
 * rule are kept (they become durable steer.note events). A rule that throws
 * fails the step with its id in the reason.
 */

import type { HookPoint, HookRule, ToolCall } from "./contracts";
import { openSteps, openTasks, TASK_TOOL_NAMES, TASK_TOOL_SET, type Ledger } from "./taskLedger";

export interface SteerContext {
	beforeModel: { turn: number; ledger: Ledger; recentTurns: ReadonlyArray<{ calls: readonly string[] }> };
	beforeTool: { call: ToolCall; ledger: Ledger; outcomes: Readonly<Record<string, boolean>> };
	afterTool: { call: ToolCall; ok: boolean; ledger: Ledger };
	onStop: { ledger: Ledger };
	onError: { message: string; ledger: Ledger };
}

export type Verdict = { kind: "allow" } | { kind: "ask"; rule: string; question: string } | { kind: "deny"; rule: string; reason: string };

export interface SteerResult {
	verdict: Verdict;
	notes: Array<{ rule: string; text: string }>;
}

export class SteeringError extends Error {
	constructor(
		public readonly rule: string,
		cause: unknown,
	) {
		super(`steering rule ${rule} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "SteeringError";
	}
}

export interface RegisteredRule {
	point: HookPoint;
	rule: HookRule<unknown>;
}

export class SteeringRegistry {
	private rules: RegisteredRule[] = [];

	add(point: HookPoint, rule: HookRule<unknown>): () => void {
		if (this.rules.some((r) => r.rule.id === rule.id)) throw new Error(`steering rule ${rule.id} already registered`);
		const entry = { point, rule };
		this.rules.push(entry);
		this.rules.sort((a, b) => a.rule.order - b.rule.order || a.rule.id.localeCompare(b.rule.id));
		return () => {
			this.rules = this.rules.filter((r) => r !== entry);
		};
	}

	ids(point: HookPoint): string[] {
		return this.rules.filter((r) => r.point === point).map((r) => r.rule.id);
	}

	async run<P extends HookPoint>(point: P, ctx: SteerContext[P]): Promise<SteerResult> {
		let verdict: Verdict = { kind: "allow" };
		const notes: Array<{ rule: string; text: string }> = [];
		for (const { point: p, rule } of this.rules) {
			if (p !== point) continue;
			let decision;
			try {
				decision = await rule.decide(ctx);
			} catch (err) {
				throw new SteeringError(rule.id, err);
			}
			if (decision.kind === "note") notes.push({ rule: rule.id, text: decision.text });
			else if (decision.kind === "deny" && verdict.kind !== "deny") verdict = { kind: "deny", rule: rule.id, reason: decision.reason };
			else if (decision.kind === "ask" && verdict.kind === "allow") verdict = { kind: "ask", rule: rule.id, question: decision.question };
		}
		return { verdict, notes };
	}
}

/** Read-only tools whose calls can be batched into one turn (mirrors the parallel-read set; kept local so this module stays dependency-free). */
const READ_TOOL_NAMES = new Set([
	"read_file",
	"read_files",
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

/** Tools that gather context without changing anything — a turn made only of
 *  these is "exploration" for the wandering detector. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([...READ_TOOL_NAMES, "explore_codebase", "log_slice"]);

/** Streak of lone-read turns that arms the batch-force deny. */
const BATCH_FORCE_AT = 10;

/**
 * Reads batching, note → enforce. When the model drains the context one read
 * per turn, the harness says so — once for batching, once for delegating to a
 * subagent — and past BATCH_FORCE_AT it stops asking: lone read_file calls are
 * refused until the model batches or delegates. Returns the beforeModel
 * detector and the beforeTool enforcer sharing one `forced` flag.
 */
const readsBatchRules = (): { detector: HookRule<SteerContext["beforeModel"]>; enforcer: HookRule<SteerContext["beforeTool"]> } => {
	let batchNoted = false;
	let exploreNoted = false;
	let forced = false;
	const detector: HookRule<SteerContext["beforeModel"]> = {
		id: "reads.batch",
		point: "beforeModel",
		order: 20,
		decide: ({ recentTurns }) => {
			let streak = 0;
			for (let i = recentTurns.length - 1; i >= 0; i--) {
				const calls = recentTurns[i]!.calls;
				if (calls.length === 1 && READ_TOOL_NAMES.has(calls[0]!)) streak++;
				else break;
			}
			forced = streak >= BATCH_FORCE_AT;
			if (streak >= 8 && !exploreNoted) {
				exploreNoted = true;
				return {
					kind: "note",
					text: "Many single-file reads in a row. For broad investigation delegate to explore_codebase — it searches in its own context and returns a concise answer. For a few known files, batch them into one read_files call.",
				};
			}
			if (streak >= 3 && !batchNoted) {
				batchNoted = true;
				return {
					kind: "note",
					text: "Independent reads can share one turn: call read_files with several paths, or emit multiple read calls in a single response, instead of one read per turn.",
				};
			}
			return { kind: "allow" };
		},
	};
	const enforcer: HookRule<SteerContext["beforeTool"]> = {
		id: "reads.batch-force",
		point: "beforeTool",
		order: 15,
		decide: ({ call }) =>
			forced && call.name === "read_file"
				? { kind: "deny", reason: "You've been reading one file per turn — batch the remaining paths into one read_files call (up to 8), or delegate the investigation to explore_codebase. Do not emit another lone read_file." }
				: { kind: "allow" },
	};
	return { detector, enforcer };
};

/**
 * list_files is positional: a call with the same path and recursive flag always
 * returns the same listing, and max_entries can't change a flat result — yet
 * models retry it with bigger limits after reading the root. The read cache
 * already dedupes reads silently; this rule additionally denies the repeat so
 * the model gets an explicit corrective instead of another identical listing.
 * A mutating call clears the memory since the filesystem may have changed.
 */
const listRepeat = (): HookRule<SteerContext["beforeTool"]> => {
	const seen = new Set<string>();
	return {
		id: "list.repeat",
		point: "beforeTool",
		order: 12,
		decide: ({ call }) => {
			// A mutating call may have changed the listings — re-listing is legitimate.
			if (!READ_ONLY_TOOL_NAMES.has(call.name) && !TASK_TOOL_SET.has(call.name)) {
				seen.clear();
				return { kind: "allow" };
			}
			if (call.name !== "list_files") return { kind: "allow" };
			const i = (call.input ?? {}) as { path?: unknown; recursive?: unknown };
			const key = `${typeof i.path === "string" && i.path ? i.path : "."}|${i.recursive === true}`;
			if (!seen.has(key)) {
				seen.add(key);
				return { kind: "allow" };
			}
			return {
				kind: "deny",
				reason: "You already listed this folder with these options — the result is unchanged. For more: pass recursive: true for the full tree, or a different path to drill into a folder. Otherwise move on to reading files.",
			};
		},
	};
};

const WANDER_NOTE_AT = 10;
const WANDER_DENY_AT = 16;
/** Read-only runs can't write by definition — reads are the work, so the leash is longer. */
const WANDER_NOTE_AT_RO = 24;
const WANDER_DENY_AT_RO = 40;
/** After a deny the streak must grow this much further before denying again, so a resumed run gets a few turns to change course. */
const WANDER_DENY_HYSTERESIS = 4;

/**
 * Wandering detector. A run that spends turn after turn only reading — never
 * writing, never finishing — is exploration without a destination. Escalates:
 * one strong note, then a deny that pauses the run until the streak grows
 * further (the model gets WANDER_DENY_HYSTERESIS turns per resume to act).
 * Board progress (a step closing) resets the counters — that's exploration
 * paying off, not wandering. In read-only runs (plan/ask) every turn is
 * read-only by definition, so the thresholds are higher and the wording
 * doesn't mention writes.
 */
const readsWander = (writable: boolean, runId?: string): HookRule<SteerContext["beforeModel"]> => {
	const noteAt = writable ? WANDER_NOTE_AT : WANDER_NOTE_AT_RO;
	const denyAt = writable ? WANDER_DENY_AT : WANDER_DENY_AT_RO;
	let strongNoted = false;
	let lastDeniedStreak = 0;
	let lastOpen: number | undefined;
	return {
		id: "reads.wander",
		point: "beforeModel",
		order: 30,
		decide: ({ ledger, recentTurns }) => {
			const open = openTasks(ledger, runId).length + openSteps(ledger, runId).length;
			const progressing = lastOpen !== undefined && open < lastOpen;
			lastOpen = open;
			if (progressing) strongNoted = false;
			// Once the deliverable exists (save_plan landed), read-only runs lose
			// their relaxed leash — further reads are wandering, whatever the mode.
			const delivered = recentTurns.some((t) => t.calls.includes("save_plan"));
			const noteThreshold = delivered ? WANDER_NOTE_AT : noteAt;
			const denyThreshold = delivered ? WANDER_DENY_AT : denyAt;
			const wording = writable || delivered;
			let streak = 0;
			for (let i = recentTurns.length - 1; i >= 0; i--) {
				const calls = recentTurns[i]!.calls;
				if (calls.length > 0 && calls.every((c) => READ_ONLY_TOOL_NAMES.has(c))) streak++;
				else break;
			}
			if (!progressing && streak >= denyThreshold && streak > lastDeniedStreak + WANDER_DENY_HYSTERESIS) {
				lastDeniedStreak = streak;
				return {
					kind: "deny",
					reason: wording
						? `Wandering: ${streak} consecutive read-only turns with no writes or progress. Stop exploring — act on what you have, or report what is blocking you.`
						: `Wandering: ${streak} consecutive read-only turns with no board progress. Stop exploring — finish and report what you have, or say what is blocking you.`,
				};
			}
			if (!progressing && streak >= noteThreshold && !strongNoted) {
				strongNoted = true;
				return {
					kind: "note",
					text: wording
						? `Still exploring after ${streak} read-only turns. If you have enough context, stop reading and make the change — every extra read costs tokens.`
						: `Still exploring after ${streak} read-only turns. If you have enough context, stop reading and finish — every extra read costs tokens.`,
				};
			}
			return { kind: "allow" };
		},
	};
};

/** Built-in rules, registered by the loop unless the caller supplies its own registry. `writable=false` (ask/plan) relaxes read-streak rules — reads are the whole job there. `runId` scopes board checks to this run's plan. */
export function builtinRules(opts: { writable?: boolean; runId?: string } = {}): RegisteredRule[] {
	const writable = opts.writable !== false;
	const finishOpenWork: HookRule<SteerContext["onStop"]> = {
		id: "finish.open-work",
		point: "onStop",
		order: 10,
		decide: ({ ledger }) => {
			const open = openTasks(ledger, opts.runId);
			return open.length ? { kind: "deny", reason: `Open work remains: ${open.join(", ")}. Finish it — if a task cannot be done in this run (e.g. it needs a write this mode forbids), say so plainly so the harness can mark it blocked.` } : { kind: "allow" };
		},
	};
	const stepGrounding: HookRule<SteerContext["beforeTool"]> = {
		id: "step.grounding",
		point: "beforeTool",
		order: 10,
		decide: ({ call }) => {
			if (call.name !== TASK_TOOL_NAMES.stepUpdate) return { kind: "allow" };
			const input = (call.input ?? {}) as { status?: unknown; callIds?: unknown };
			if (input.status !== "done") return { kind: "allow" };
			const ids = Array.isArray(input.callIds) ? input.callIds : [];
			return ids.length ? { kind: "allow" } : { kind: "deny", reason: "Mark a step done only with callIds: the successful tool-call ids that prove it." };
		},
	};
	const treeRecount = (): HookRule<SteerContext["beforeModel"]> => {
		let noted = false;
		return {
			id: "tree.recount",
			point: "beforeModel",
			order: 31,
			decide: ({ recentTurns }) => {
				if (noted) return { kind: "allow" };
				const derived = recentTurns.reduce((n, t) => n + t.calls.filter((c) => c === "list_files" || c === "get_file_structure").length, 0);
				if (derived <= 6) return { kind: "allow" };
				noted = true;
				return { kind: "note", text: "You already have the repository layout from earlier listings — reuse it instead of re-deriving the tree." };
			},
		};
	};
	const reads = readsBatchRules();
	return [
		{ point: "onStop", rule: finishOpenWork as HookRule<unknown> },
		{ point: "beforeTool", rule: stepGrounding as HookRule<unknown> },
		{ point: "beforeTool", rule: listRepeat() as HookRule<unknown> },
		{ point: "beforeTool", rule: reads.enforcer as HookRule<unknown> },
		{ point: "beforeModel", rule: reads.detector as HookRule<unknown> },
		{ point: "beforeModel", rule: readsWander(writable, opts.runId) as HookRule<unknown> },
		{ point: "beforeModel", rule: treeRecount() as HookRule<unknown> },
	];
}
