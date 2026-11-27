/**
 * Stateless request strategy (vscode-free): the default request lifecycle.
 * Every turn replays the full projection — recap first, then the context
 * policy's projection — so any provider works without server-side state.
 */

import type { RequestStrategy, StrategyCtx, RequestTurn } from "../core/policies/requestStrategy";

export class StatelessStrategy implements RequestStrategy {
	async call(ctx: StrategyCtx): Promise<RequestTurn> {
		await ctx.behavior.recap.maybeRecap({
			model: ctx.model,
			emit: ctx.emit,
			state: ctx.state,
			signal: ctx.signal,
			lastInputTokens: ctx.recap.lastInputTokens,
			taskDone: ctx.recap.taskDone,
			forced: ctx.recap.forced,
			context: ctx.behavior.context,
		});
		const context = ctx.behavior.context.build(ctx.state, ctx.offered, ctx.system, ctx.runId);
		const response = await ctx.complete({
			turn: ctx.turn,
			system: context.system,
			messages: context.messages,
			ledger: ctx.state.ledger,
			tools: ctx.tools,
			signal: ctx.signal,
			onReasoningDelta: ctx.onReasoningDelta,
			onTextDelta: ctx.onTextDelta,
		});
		return { response };
	}
}

/** Shared instance — the strategy is stateless itself. */
export const statelessStrategy = new StatelessStrategy();
