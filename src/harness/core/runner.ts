/**
 * Harness run (vscode-free). Drives one HarnessLoop and maps its durable events
 * to the run-view events the UI already renders. Steps, loop-control verdicts
 * and acceptance results appear as info and check lines, so the user sees the
 * same plan the model is held to.
 */

import type { RunViewEvent } from "../../agent/runner";
import { classifyRunError } from "../../agent/errorKind";
import type { ImageInput, ModelPort, SessionEvent, ToolPort, Usage, VerifierPort } from "./contracts";
import type { HarnessBehavior } from "./behavior";
import type { EventLog } from "./eventLog";
import { DEFAULT_LIMITS, HarnessLoop, type HarnessLimits, type RunOutcome, type SeedTask } from "./loop";

const LEDGER_EVENTS = new Set(["task.created", "task.updated", "task.removed", "task.adopted", "step.added", "step.updated", "verifier.result"]);

export interface HarnessRunDeps {
	/** Receives the live loop, so the UI can compact a running run. */
	onLoop?: (loop: HarnessLoop) => void;
	runId: string;
	log: EventLog;
	model: ModelPort;
	/** Resolved provider/model behavior; defaults inside the loop. */
	behavior?: HarnessBehavior;
	tools: ToolPort;
	verifier?: VerifierPort;
	limits?: Partial<HarnessLimits>;
	/** Ask the host whether to continue when a run hits its turn limit. Absent → pause. */
	onTurnLimit?: (used: number, limit: number) => Promise<boolean>;
	/** Ask the host to rule on a steering "ask" verdict (e.g. plan drift). Absent → pause. */
	onSteerAsk?: (question: string) => Promise<boolean>;
	emit: (event: RunViewEvent) => void;
	signal?: AbortSignal;
	system?: string;
	nudgeWrites?: boolean;
	/** False in read-only modes (ask/plan): the planner must not emit write steps. Defaults to true. */
	writable?: boolean;
	/** kronyx.harness.debug — surface harness decisions (steer rule ids, per-turn tokens, recaps) as chat lines. */
	debug?: boolean;
}

interface Tracker {
	turn: number;
	/** Turn counter at the current run's start — run.iterations is run-scoped,
	 *  while e.turn counts model turns for the whole session. */
	runStart: number;
	lastText: string;
	starts: Map<string, number>;
	usage: Usage;
}

/** Emits a usage row for tokens spent outside a model.response (planner, subagent). */
function usageEvent(u: Usage, st: Tracker): RunViewEvent {
	st.usage = {
		inputTokens: st.usage.inputTokens + u.inputTokens,
		outputTokens: st.usage.outputTokens + u.outputTokens,
		cachedTokens: st.usage.cachedTokens + u.cachedTokens,
	};
	return {
		type: "usage",
		inputTokens: st.usage.inputTokens,
		outputTokens: st.usage.outputTokens,
		cacheReadTokens: st.usage.cachedTokens,
		cacheWriteTokens: 0,
		iteration: st.turn,
		requestTokens: u.inputTokens,
	};
}

class ObservedLog implements EventLog {
	constructor(
		private readonly inner: EventLog,
		private readonly onAppend: (event: SessionEvent) => void,
	) {}

	async append(event: Parameters<EventLog["append"]>[0]): Promise<SessionEvent> {
		const stamped = await this.inner.append(event);
		this.onAppend(stamped);
		return stamped;
	}

	read(): Promise<SessionEvent[]> {
		return this.inner.read();
	}
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/** Maps one durable event to zero or more run-view events. Pure apart from the tracker. `debug` adds harness-decision lines (steer rule ids, per-turn tokens, recaps). */
export function toViewEvents(e: SessionEvent, st: Tracker, _limit: number, debug = false): RunViewEvent[] {
	switch (e.type) {
		case "model.response": {
			st.turn = e.turn;
			st.lastText = e.text;
			const out: RunViewEvent[] = [];
			if (e.reasoning?.trim()) out.push({ type: "reasoning", iteration: e.turn, text: e.reasoning });
			if (e.text.trim()) out.push({ type: "assistant-text", iteration: e.turn, text: e.text });
			if (e.usage) {
				st.usage = {
					inputTokens: st.usage.inputTokens + e.usage.inputTokens,
					outputTokens: st.usage.outputTokens + e.usage.outputTokens,
					cachedTokens: st.usage.cachedTokens + e.usage.cachedTokens,
				};
				out.push({
					type: "usage",
					inputTokens: st.usage.inputTokens,
					outputTokens: st.usage.outputTokens,
					cacheReadTokens: st.usage.cachedTokens,
					cacheWriteTokens: 0,
					iteration: e.turn,
					requestTokens: e.usage.inputTokens,
				});
			}
			if (debug) {
				out.push({
					type: "info",
					text: `turn ${e.turn}${e.usage ? ` — ${fmtK(e.usage.inputTokens)} in / ${fmtK(e.usage.outputTokens)} out${e.toolCalls.length ? ` · ${e.toolCalls.length} call${e.toolCalls.length === 1 ? "" : "s"}` : ""}` : ""}`,
					meta: { kind: "harness" },
				});
			}
			return out;
		}
		case "tool.requested":
			st.starts.set(e.callId, Date.now());
			// Harness-internal plumbing always emits — the webview hides these
			// lines behind its harness toggle (hide-harness class), so they stay
			// available live and on replay when the toggle is flipped on.
			return [{ type: "tool-started", id: e.callId, name: e.name, input: e.input, iteration: st.turn }];
		case "tool.finished": {
			const started = st.starts.get(e.callId) ?? Date.now();
			st.starts.delete(e.callId);
			const out: RunViewEvent[] = [{ type: "tool-finished", id: e.callId, name: e.name, ok: e.ok, output: e.output, durationMs: Date.now() - started, iteration: st.turn }];
			if (e.usage) out.push(usageEvent(e.usage, st));
			// save_plan reports "Plan saved to <rel>" — surface a doc link like AgentRunner does.
			const saved = e.name === "save_plan" && e.ok ? /^Plan saved to (.+)$/m.exec(e.output)?.[1] : undefined;
			if (saved) out.push({ type: "plan-ready", path: saved });
			return out;
		}
		case "task.created": {
			// task-named feeds the view's ref table so "t1" in narration and info
			// lines resolves to the task title — independent of the debug board.
			const named: RunViewEvent = { type: "task-named", id: e.task.id, title: e.task.title, steps: e.task.steps.map((s) => ({ id: s.id, text: s.text })) };
			return e.usage ? [named, usageEvent(e.usage, st)] : [named];
		}
		case "step.added":
			return [{ type: "task-named", id: e.taskId, steps: [{ id: e.step.id, text: e.step.text }] }];
		case "task.adopted":
			return [{ type: "info", text: `Continuing task ${e.id} from an earlier run.` }];
		case "task.updated":
			// Blocked carries a reason the user should see; other transitions are board noise.
			return e.to === "blocked" ? [{ type: "info", text: `Task ${e.id} is blocked${e.reason ? ` — ${e.reason}` : ""}` }] : [];
		case "step.updated":
			return [];
		case "verifier.result":
			// Success is a single user-facing line (the id resolves to the task
			// title in the view); failures keep the expandable check card.
			return e.ok
				? [{ type: "info", text: `Task ${e.taskId} is done${e.detail === "no acceptance check" ? "." : "; the acceptance check passed."}` }]
				: [{ type: "check", command: `acceptance ${e.taskId}`, ok: false, durationMs: 0, output: e.detail }];
		case "steer.note":
			// plan.start is user-facing — it marks the unstreamed planner call
			// that would otherwise read as dead air before the first task.
			if (e.rule === "plan.start") return [{ type: "info", text: e.text }];
			return [{ type: "info", text: debug ? `[${e.rule}] ${e.text}` : e.text, meta: { kind: "harness", rule: e.rule } }];
		case "context.recap":
			return [{ type: "info", text: `Context compacted — recap covers the first ${e.covers} messages.`, meta: { kind: "context_compaction" } }];
		case "context.cleared":
			return [{ type: "info", text: "context cleared" }];
		case "budget.warning":
			return [{ type: "info", text: `Input tokens at ${e.used} of ${e.limit}.` }];
		case "stop.refused":
			return [{ type: "info", text: `Finish refused: open work remains (${e.openTaskIds.join(", ")}).` }];
		case "loop.verdict":
			return e.level === "none" ? [] : [{ type: "info", text: `Loop control: ${e.level}${e.reason ? ` (${e.reason})` : ""}` }];
		case "run.status":
			if (e.status === "running") {
				st.runStart = st.turn;
				return [];
			}
			if (e.status === "completed") return [{ type: "run-finished", status: "completed", text: st.lastText, iterations: st.turn - st.runStart }];
			// A paused run has no resume button on this path; the next message resumes it from the log.
			if (e.status === "paused") return [{ type: "run-finished", status: "stopped", text: `Paused (${e.reason ?? "limit"}). Send a message to continue.`, iterations: st.turn - st.runStart }];
			if (e.status === "failed") {
				const { errorKind, retryable } = classifyRunError(e.reason ?? "");
				return [{ type: "run-failed", error: e.reason ?? "The run failed.", errorKind, retryable }];
			}
			return [];
		default:
			return [];
	}
}

export async function runHarness(deps: HarnessRunDeps, task: string, displayTask?: string, opts: { resume?: boolean; context?: string; images?: ImageInput[]; plan?: boolean; seed?: SeedTask[] } = {}): Promise<RunOutcome> {
	const st: Tracker = { turn: 0, runStart: 0, lastText: "", starts: new Map(), usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
	const limit = deps.limits?.maxTurns ?? DEFAULT_LIMITS.maxTurns;
	const log = new ObservedLog(deps.log, (e) => {
		for (const view of toViewEvents(e, st, limit, deps.debug === true)) deps.emit(view);
	});
	const loop = new HarnessLoop({
		runId: deps.runId,
		log,
		model: deps.model,
		behavior: deps.behavior,
		tools: deps.tools,
		verifier: deps.verifier,
		limits: deps.limits,
		onTurnLimit: deps.onTurnLimit,
		onSteerAsk: deps.onSteerAsk,
		signal: deps.signal,
		system: deps.system,
		nudgeWrites: deps.nudgeWrites,
		writable: deps.writable,
		onReasoningDelta: (text) => deps.emit({ type: "reasoning-delta", text }),
		onTextDelta: (text) => deps.emit({ type: "assistant-delta", text }),
		onState: (state, event) => {
			// The board is harness-internal state — only kronyx.harness.debug surfaces it to the chat.
			if (deps.debug === true && LEDGER_EVENTS.has(event.type)) deps.emit({ type: "task-board", tasks: boardOf(state, deps.runId) });
		},
	});
	deps.onLoop?.(loop);
	await loop.recover();
	deps.emit({ type: "run-started", task: displayTask ?? task });
	return opts.resume ? loop.resume() : loop.run(task, opts.context, opts.images, { plan: opts.plan, seed: opts.seed });
}

/** Task board snapshot for the UI: this run's tasks in creation order with their steps. */
export function boardOf(state: { ledger: { order: string[]; tasks: Record<string, { id: string; title: string; status: string; runId?: string; adoptedFrom?: string; steps: Array<{ id: string; text: string; status: string; callIds?: string[] }> }> } }, runId?: string) {
	return state.ledger.order.filter((id) => runId === undefined || state.ledger.tasks[id]?.runId === runId).map((id) => {
		const t = state.ledger.tasks[id]!;
		return { id: t.id, title: t.title, status: t.status, ...(t.adoptedFrom ? { from: t.adoptedFrom } : {}), steps: t.steps.map((s) => ({ id: s.id, text: s.text, status: s.status, callIds: s.callIds ?? [] })) };
	});
}
