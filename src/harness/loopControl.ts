/**
 * Loop controller (vscode-free). Pure over the tool-call history held in the
 * projection, so the same log always produces the same verdicts.
 *
 * Detectors, all over the last `window` calls:
 * - repeat: the same call (tool + canonical args) `repeatThreshold` times.
 * - stuck: the same call returning the same result `resultThreshold` times (no progress).
 * - alternation: A-B-A-B for `alternationThreshold` cycles.
 *
 * Escalation is driven by strikes (consecutive flagged calls since the last
 * unflagged one): warn → block → strip tools → pause. See `levelForStrikes`.
 */

import type { LoopDetectorConfig, LoopLevel } from "./contracts";

export interface CallRecord {
	callId: string;
	fingerprint: string;
	/** Hash of the result once the call finished; undefined while it is still pending. */
	resultHash?: string;
}

export type LoopReason = "repeat" | "stuck" | "alternation";

export function detect(history: readonly CallRecord[], next: string, cfg: LoopDetectorConfig): LoopReason | undefined {
	const recent = history.slice(-(cfg.window - 1));
	const sameCalls = recent.filter((r) => r.fingerprint === next);
	if (sameCalls.length + 1 >= cfg.repeatThreshold) return "repeat";

	const withResults = sameCalls.filter((r) => r.resultHash !== undefined);
	const last = withResults.at(-1)?.resultHash;
	if (last !== undefined && withResults.length + 1 >= cfg.resultThreshold && withResults.slice(-(cfg.resultThreshold - 1)).every((r) => r.resultHash === last)) {
		return "stuck";
	}

	const need = cfg.alternationThreshold * 2;
	const tail = [...history.slice(-(need - 1)).map((r) => r.fingerprint), next];
	if (tail.length === need && tail[0] !== tail[1] && tail.every((fp, i) => i < 2 || fp === tail[i - 2])) return "alternation";
	return undefined;
}

const LADDER: readonly LoopLevel[] = ["warn", "block", "strip", "pause"];

/** Level for the next flagged call, given how many flagged calls came before it in a row. */
export function levelForStrikes(strikes: number): LoopLevel {
	return LADDER[Math.min(strikes, LADDER.length - 1)]!;
}
