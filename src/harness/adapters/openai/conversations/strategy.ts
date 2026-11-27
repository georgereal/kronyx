/**
 * Conversation request strategy (vscode-free): the lifecycle for a server-side
 * conversation. The server already holds everything up to the last synced
 * event, so only the delta is sent. Each step is logged before it happens
 * (bound, sent), so a crash or failure leaves a marker the next run reads as
 * "rebind and replay from the log". The durable events are provider-agnostic;
 * the sync rules — delta shaping, board-hash diffing, stale detection, 404
 * retry — are this capability's own.
 */

import { hashText } from "../../../core/canonical";
import type { ConversationPort } from "../../../core/contracts";
import type { RequestStrategy, RequestTurn, StrategyCtx } from "../../../core/policies/requestStrategy";
import type { Message } from "../../../core/projections";

/** A conversation request must never carry a call without its result. Resume's recover() closes any left open. */
const assertPaired = (messages: readonly Message[]): void => {
	const answered = new Set(messages.flatMap((m) => (m.kind === "tool" ? [m.callId] : [])));
	for (const m of messages) {
		if (m.kind !== "assistant") continue;
		const open = m.toolCalls.find((c) => !answered.has(c.callId));
		if (open) throw new Error(`tool call ${open.callId} has no result; cannot send to the conversation`);
	}
};

export class ConversationStrategy implements RequestStrategy {
	constructor(private readonly port: ConversationPort) {}

	async call(ctx: StrategyCtx, retried = false): Promise<RequestTurn> {
		const { emit } = ctx;
		const current = ctx.state.conversation;
		const stale = current && (current.provider !== this.port.provider || current.model !== this.port.model ? "model changed" : current.inFlight ? "unfinished request" : undefined);
		if (stale) await emit({ type: "conversation.reset", reason: stale });
		if (!ctx.state.conversation) await emit({ type: "conversation.bound", conversationId: await this.port.create(), provider: this.port.provider, model: this.port.model });
		const conv = ctx.state.conversation!;
		const board = ctx.behavior.context.taskBoard(ctx.state, ctx.runId);
		const boardHash = board === undefined ? undefined : hashText(board);
		let sent: Message[];
		if (conv.syncedSeq === undefined) {
			// A new conversation starts from the projected context (recap, digests, board), so a long session binds within the window.
			sent = ctx.behavior.context.build(ctx.state, ctx.offered, ctx.system, ctx.runId).messages;
		} else {
			// Only what the server lacks: events after the last synced one. Long results keep a head and a log_slice pointer.
			sent = ctx.state.messages.filter((m) => (m.seq ?? 0) > conv.syncedSeq!).map((m) => (m.kind === "tool" ? ctx.behavior.context.capResult(m) : m));
			// The task board is a snapshot: it goes in only when it changed since the server last saw it.
			// Earlier snapshots stay in the conversation, so each resend marks them stale.
			if (board !== undefined && boardHash !== conv.boardHash)
				sent.push({ kind: "system", text: `${board}\n(This is the latest task board — it supersedes every earlier task board in this conversation.)` });
		}
		assertPaired(ctx.state.messages);
		await emit({ type: "conversation.sent", throughSeq: ctx.state.lastSeq });
		try {
			const response = await ctx.complete({
				turn: ctx.turn,
				system: ctx.system,
				messages: sent,
				ledger: ctx.state.ledger,
				tools: ctx.tools,
				signal: ctx.signal,
				onReasoningDelta: ctx.onReasoningDelta,
				onTextDelta: ctx.onTextDelta,
				conversation: { id: conv.id },
			});
			return { response, boardHash };
		} catch (err) {
			const missing = (err as { status?: number }).status === 404;
			await emit({ type: "conversation.reset", reason: missing ? "missing" : "call failed" });
			if (missing && !retried) return this.call(ctx, true);
			throw err;
		}
	}

	/** The response is logged; the conversation now holds everything up to it. */
	async committed(ctx: StrategyCtx, turn: RequestTurn): Promise<void> {
		await ctx.emit({ type: "conversation.synced", throughSeq: ctx.state.lastSeq, responseId: turn.response.responseId, boardHash: turn.boardHash });
	}
}
