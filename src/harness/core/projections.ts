/**
 * Projections (vscode-free): pure reducers over the session log. Replaying the
 * same events always yields the same state; nothing else is authoritative.
 */

import type { ImageInput, ProviderItems, RunStatus, SessionEvent, ToolCall } from "./contracts";
import { hashText, callFingerprint } from "./canonical";
import type { CallRecord } from "../defaults/loopControl";
import { applyLedgerEvent, emptyLedger, openTasks, type Ledger } from "./taskLedger";

export type Message =
	| { kind: "user"; text: string; seq: number; images?: ImageInput[] }
	| { kind: "assistant"; text: string; toolCalls: ToolCall[]; seq: number; providerItems?: ProviderItems }
	| { kind: "tool"; callId: string; name: string; ok: boolean; output: string; seq: number }
	/** `seq` is set for messages that come from log events; projected context lines (board, recap) have none. */
	| { kind: "system"; text: string; seq?: number };

/** The server-side conversation this session is bound to. `syncedSeq` is the last event it holds; `inFlight` means a request left the log without a result. */
export interface ConversationState {
	id: string;
	provider: string;
	model: string;
	syncedSeq?: number;
	boardHash?: string;
	inFlight?: boolean;
}

export interface Counters {
	turns: number;
	toolCalls: number;
	toolFailures: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	refusals: number;
}

/** Normalized error identity: strips digits/whitespace so "exit 1, 3 failures"
 *  and "exit 1, 2 failures" collapse — loop control needs the error class, not
 *  the exact text. */
export function failureSignature(output: string): string {
	const firstLines = output.split("\n").slice(0, 3).join(" ");
	return hashText(firstLines.toLowerCase().replace(/[0-9a-f]{6,}|\d+/g, "#").replace(/\s+/g, " ").slice(0, 160));
}

/** Calls kept for loop detection and step grounding. Older records are dropped; outcomes are kept. */
const HISTORY_CAP = 50;

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
	/** The harness's own acceptance-check results, in log order. */
	verdicts: Array<{ command: string; seq: number; ok: boolean }>;
	conversation?: ConversationState;
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
	verdicts: [],
	lastSeq: 0,
});

/** Records the seq at which a task went in_progress — its steps' proof window opens there. */
const markTaskStart = (ledger: Ledger, taskId: string, seq: number): Ledger => {
	const task = ledger.tasks[taskId];
	if (!task) return ledger;
	return { ...ledger, tasks: { ...ledger.tasks, [taskId]: { ...task, startedSeq: seq } } };
};

/** Applies one event. Throws ProjectionError on a sequence gap, LedgerError on a rule violation. */
export function reduce(state: HarnessState, event: SessionEvent): HarnessState {
	if (event.seq !== state.lastSeq + 1) throw new ProjectionError(`event seq ${event.seq} does not follow ${state.lastSeq}`);
	const counters = { ...state.counters };
	let messages = state.messages;
	let ledger = state.ledger;
	let run = state.run;
	let outcomes = state.outcomes;
	let history = state.history;
	let verdicts = state.verdicts;
	let strikes = state.strikes;
	let recap = state.recap;
	let conversation = state.conversation;
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
			push({ kind: "assistant", text: event.text, toolCalls: event.toolCalls, seq: event.seq, ...(event.providerItems ? { providerItems: event.providerItems } : {}) });
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
			history = history.map((r) =>
				r.callId === event.callId ? { ...r, resultHash: hashText(event.output), ...(event.ok ? {} : { failSig: failureSignature(event.output) }) } : r,
			);
			push({ kind: "tool", callId: event.callId, name: event.name, ok: event.ok, output: event.output, seq: event.seq });
			break;
		case "task.created":
			counters.inputTokens += event.usage?.inputTokens ?? 0;
			counters.outputTokens += event.usage?.outputTokens ?? 0;
			counters.cachedTokens += event.usage?.cachedTokens ?? 0;
		case "task.adopted":
		case "task.removed":
		case "step.added":
			ledger = applyLedgerEvent(ledger, event, outcomes);
			break;
		case "step.updated":
			ledger = applyLedgerEvent(ledger, event, outcomes);
			// A task whose steps move without an explicit task.updated is de
			// facto started — open its proof window here so evidence attaches.
			if (event.to !== "pending" && ledger.tasks[event.taskId]?.startedSeq === undefined)
				ledger = markTaskStart(ledger, event.taskId, event.seq);
			break;
		case "task.updated":
			ledger = applyLedgerEvent(ledger, event, outcomes);
			if (event.to === "in_progress") ledger = markTaskStart(ledger, event.id, event.seq);
			// Reason-bearing transitions are harness verdicts the board can't explain — tell the model.
			if (event.reason) push({ kind: "system", text: `Task ${event.id} ${event.to}: ${event.reason}`, seq: event.seq });
			break;
		case "verifier.result":
			ledger = applyLedgerEvent(ledger, event, outcomes);
			push({ kind: "system", text: `Acceptance check for ${event.taskId} ${event.ok ? "passed" : "failed"}${event.detail ? `: ${event.detail}` : ""}`, seq: event.seq });
			if (event.command !== undefined) verdicts = [...verdicts, { command: event.command, seq: event.seq, ok: event.ok }];
			break;
		case "stop.refused":
			counters.refusals++;
			push({ kind: "system", text: `Open work remains: ${event.openTaskIds.join(", ")}. Finish it or state what blocks it.`, seq: event.seq });
			break;
		case "budget.warning":
			push({ kind: "system", text: `Input token budget at ${event.used} of ${event.limit}.`, seq: event.seq });
			break;
		case "steer.note":
			push({ kind: "system", text: event.text, seq: event.seq });
			break;
		case "loop.verdict":
			// Decay, not reset: one clean call shouldn't absolve a pattern of
			// looping — the edit→read→edit rhythm otherwise escapes escalation.
			strikes = event.level === "none" ? Math.max(0, strikes - 1) : strikes + 1;
			break;
		case "context.recap":
			recap = { covers: event.covers, text: event.text };
			// A recap call is a real model call: its tokens count against the session budget.
			counters.inputTokens += event.usage?.inputTokens ?? 0;
			counters.outputTokens += event.usage?.outputTokens ?? 0;
			counters.cachedTokens += event.usage?.cachedTokens ?? 0;
			break;
		case "context.cleared":
			// Clear context drops what the model sees; the ledger, counters and the log stay. The server copy goes with it.
			messages = [];
			recap = undefined;
			conversation = undefined;
			break;
		case "run.status":
			run = { status: event.status, ...(event.reason === undefined ? {} : { reason: event.reason }) };
			break;
		case "conversation.bound":
			conversation = { id: event.conversationId, provider: event.provider, model: event.model };
			break;
		case "conversation.sent":
			if (conversation) conversation = { ...conversation, inFlight: true };
			break;
		case "conversation.synced":
			if (conversation) conversation = { ...conversation, syncedSeq: event.throughSeq, boardHash: event.boardHash, inFlight: false };
			break;
		case "conversation.reset":
			conversation = undefined;
			break;
	}
	return { messages, ledger, counters, run, outcomes, history, strikes, recap, verdicts, conversation, lastSeq: event.seq };
}

/** Replays a whole log from scratch. */
export function project(events: readonly SessionEvent[]): HarnessState {
	return events.reduce(reduce, initialState());
}

export { openTasks };
