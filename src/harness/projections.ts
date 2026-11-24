/**
 * Projections (vscode-free): pure reducers over the session log. Replaying the
 * same events always yields the same state; nothing else is authoritative.
 */

import type { ImageInput, RunStatus, SessionEvent, ToolCall } from "./contracts";
import { hashText, callFingerprint } from "./canonical";
import type { CallRecord } from "./loopControl";
import { applyLedgerEvent, emptyLedger, openTasks, type Ledger } from "./taskLedger";

export type Message =
	| { kind: "user"; text: string; seq: number; images?: ImageInput[] }
	| { kind: "assistant"; text: string; toolCalls: ToolCall[]; seq: number }
	| { kind: "tool"; callId: string; name: string; ok: boolean; output: string; seq: number }
	| { kind: "system"; text: string };

export interface Counters {
	turns: number;
	toolCalls: number;
	toolFailures: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	refusals: number;
}

/** Calls kept for loop detection and step grounding. Older records are dropped; outcomes are kept. */
export const HISTORY_CAP = 50;

export interface HarnessState {
	messages: Message[];
	ledger: Ledger;
	counters: Counters;
	run: { status: RunStatus | "idle"; reason?: string };
	/** Whether each finished tool call succeeded, by callId. Used to ground step completion. */
	outcomes: Record<string, boolean>;
	history: CallRecord[];
	/** Consecutive flagged tool calls since the last unflagged one. Drives the loop ladder. */
	strikes: number;
	/** Model-written recap of the first `covers` messages; the messages themselves stay in the log. */
	recap?: { covers: number; text: string };
	lastSeq: number;
}

export class ProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectionError";
	}
}

export const initialState = (): HarnessState => ({
	messages: [],
	ledger: emptyLedger(),
	counters: { turns: 0, toolCalls: 0, toolFailures: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, refusals: 0 },
	run: { status: "idle" },
	outcomes: {},
	history: [],
	strikes: 0,
	lastSeq: 0,
});

/** Applies one event. Throws ProjectionError on a sequence gap, LedgerError on a rule violation. */
export function reduce(state: HarnessState, event: SessionEvent): HarnessState {
	if (event.seq !== state.lastSeq + 1) throw new ProjectionError(`event seq ${event.seq} does not follow ${state.lastSeq}`);
	const counters = { ...state.counters };
	let messages = state.messages;
	let ledger = state.ledger;
	let run = state.run;
	let outcomes = state.outcomes;
	let history = state.history;
	let strikes = state.strikes;
	let recap = state.recap;
	const push = (message: Message) => {
		messages = [...messages, message];
	};
	switch (event.type) {
		case "user.input":
			push({ kind: "user", text: event.text, seq: event.seq, ...(event.images ? { images: event.images } : {}) });
			break;
		case "model.response":
			counters.turns++;
			counters.inputTokens += event.usage?.inputTokens ?? 0;
			counters.outputTokens += event.usage?.outputTokens ?? 0;
			counters.cachedTokens += event.usage?.cachedTokens ?? 0;
			push({ kind: "assistant", text: event.text, toolCalls: event.toolCalls, seq: event.seq });
			break;
		case "tool.requested":
			history = [...history, { callId: event.callId, fingerprint: callFingerprint(event.name, event.input) }].slice(-HISTORY_CAP);
			break;
		case "tool.finished":
			counters.toolCalls++;
			if (!event.ok) counters.toolFailures++;
			counters.inputTokens += event.usage?.inputTokens ?? 0;
			counters.outputTokens += event.usage?.outputTokens ?? 0;
			counters.cachedTokens += event.usage?.cachedTokens ?? 0;
			outcomes = { ...outcomes, [event.callId]: event.ok };
			history = history.map((r) => (r.callId === event.callId ? { ...r, resultHash: hashText(event.output) } : r));
			push({ kind: "tool", callId: event.callId, name: event.name, ok: event.ok, output: event.output, seq: event.seq });
			break;
		case "task.created":
			counters.inputTokens += event.usage?.inputTokens ?? 0;
			counters.outputTokens += event.usage?.outputTokens ?? 0;
			counters.cachedTokens += event.usage?.cachedTokens ?? 0;
		case "task.updated":
		case "task.adopted":
		case "task.removed":
		case "step.added":
		case "step.updated":
		case "verifier.result":
			ledger = applyLedgerEvent(ledger, event, outcomes);
			break;
		case "stop.refused":
			counters.refusals++;
			push({ kind: "system", text: `Open work remains: ${event.openTaskIds.join(", ")}. Finish it or state what blocks it.` });
			break;
		case "budget.warning":
			push({ kind: "system", text: `Input token budget at ${event.used} of ${event.limit}.` });
			break;
		case "steer.note":
			push({ kind: "system", text: event.text });
			break;
		case "loop.verdict":
			strikes = event.level === "none" ? 0 : strikes + 1;
			break;
		case "context.recap":
			recap = { covers: event.covers, text: event.text };
			// A recap call is a real model call: its tokens count against the session budget.
			counters.inputTokens += event.usage?.inputTokens ?? 0;
			counters.outputTokens += event.usage?.outputTokens ?? 0;
			counters.cachedTokens += event.usage?.cachedTokens ?? 0;
			break;
		case "context.cleared":
			// Clear context drops what the model sees; the ledger, counters and the log stay.
			messages = [];
			recap = undefined;
			break;
		case "run.status":
			run = { status: event.status, ...(event.reason === undefined ? {} : { reason: event.reason }) };
			break;
	}
	return { messages, ledger, counters, run, outcomes, history, strikes, recap, lastSeq: event.seq };
}

/** Replays a whole log from scratch. */
export function project(events: readonly SessionEvent[]): HarnessState {
	return events.reduce(reduce, initialState());
}

export { openTasks };
