/**
 * Repeat guard: identical tool calls (same name + same input) get a nudge at
 * `warnAt`, and the run is stopped at `stopAt` — extracted from the runner's
 * former inline loop detection. Advisory skips let the model change approach;
 * the final verdict stops the run outright.
 */

import type { PreTool } from "../pipeline";

export interface RepeatGuardOptions {
	warnAt?: number;
	stopAt?: number;
	/** Track only these tools; empty = all. */
	include?: readonly string[];
	/** Never track these tools. */
	exclude?: readonly string[];
	/** History window; newest `window` signatures are compared. */
	window?: number;
	/** Emitted when the hard stop fires. */
	onLoopDetected?: (tool: string, count: number) => void;
	/** Called at the hard stop so the caller can abort the run. */
	onStop?: (reason: string) => void;
}

export function createRepeatGuard(opts: RepeatGuardOptions = {}): PreTool {
	const warnAt = opts.warnAt ?? 3;
	const stopAt = opts.stopAt ?? 5;
	const window = opts.window ?? 12;
	const recentCalls: string[] = [];
	return async (call, next) => {
		if (opts.include?.length && !opts.include.includes(call.name)) return next();
		if (opts.exclude?.includes(call.name)) return next();
		const sig = call.name + ":" + JSON.stringify(call.input ?? {}).replace(/\s+/g, "");
		recentCalls.push(sig);
		if (recentCalls.length > window) recentCalls.shift();
		const dupes = recentCalls.filter((s) => s === sig).length;
		if (dupes >= stopAt) {
			opts.onLoopDetected?.(call.name, dupes);
			const reason = `Stopped: this exact action was attempted ${dupes} times without progress.`;
			opts.onStop?.(reason);
			return { kind: "deny", reason };
		}
		if (dupes >= warnAt) {
			return {
				kind: "deny",
				reason: `You already ran this exact action ${dupes} times without fixing the problem. Change approach — different command, different file, or re-read the relevant code.`,
			};
		}
		return next();
	};
}
