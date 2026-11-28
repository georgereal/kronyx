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

import { DEFAULT_LOOP_DETECTOR, type LoopDetectorConfig, type LoopLevel } from "../core/contracts";

import type { CallRecord, LoopReason, LoopControlPolicy } from "../core/policies/loopControl";

export type { CallRecord, LoopReason };

/** Write-ish tools: a state change. The fingerprint prefix is "tool:". */
const WRITE_PREFIXES = ["write_file", "edit_file", "file_editor", "append_file", "insert_lines", "apply_patch", "rename_symbol"];

export function detect(history: readonly CallRecord[], next: string, cfg: LoopDetectorConfig): LoopReason | undefined {
	const recent = history.slice(-(cfg.window - 1));
	// Repetitions only count since the last write: re-running the same test or
	// build after editing files is iteration — a new experiment on changed
	// state — not a loop. Reads and board edits don't reset it.
	// Scoped to run_command: a write must not reset detection of write-loop
	// fingerprints themselves, and read repeats have their own dynamics.
	const isCommand = next.startsWith("run_command:");
	const lastWrite = isCommand ? recent.map((r, i) => (WRITE_PREFIXES.some((w) => r.fingerprint.startsWith(`${w}:`)) ? i : -1)).reduce((a, b) => Math.max(a, b), -1) : -1;
	const sinceWrite = recent.slice(lastWrite + 1);
	const sameCalls = sinceWrite.filter((r) => r.fingerprint === next);
	if (sameCalls.length + 1 >= cfg.repeatThreshold) return "repeat";

	const withResults = sameCalls.filter((r) => r.resultHash !== undefined);
	const last = withResults.at(-1)?.resultHash;
	if (last !== undefined && withResults.length + 1 >= cfg.resultThreshold && withResults.slice(-(cfg.resultThreshold - 1)).every((r) => r.resultHash === last)) {
		return "stuck";
	}

	// Failure streak: this tool failing over and over with no success in
	// between — regardless of interspersed reads or drifting arguments. The
	// exact-fingerprint detectors miss this because the model varies inputs and
	// flushes the window with exploratory calls; a streak survives both, since
	// only a success (not unrelated activity) breaks it.
	const tool = next.slice(0, next.indexOf(":"));
	// Only failures in the same error class count: iteration produces a
	// different error each step (compile error → next compile error → test
	// failure), a loop produces the same one. The streak therefore keys on the
	// most recent failure's signature and breaks on success or a different error.
	let streak = 0;
	let sig: string | undefined;
	for (let i = history.length - 1; i >= 0; i--) {
		const r = history[i]!;
		if (r.fingerprint.slice(0, r.fingerprint.indexOf(":")) !== tool) continue;
		if (r.resultHash === undefined) continue; // still in flight — no verdict yet
		if (r.failSig === undefined) break; // a real success breaks the streak
		if (sig === undefined) sig = r.failSig;
		if (r.failSig !== sig) break; // a different error is progress, not looping
		streak++;
	}
	if (streak + 1 >= cfg.resultThreshold) return "stuck";

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

/** Today's detectors and strike ladder as the default LoopControlPolicy. */
export const defaultLoopControlPolicy: LoopControlPolicy = {
	config: (overrides) => ({ ...DEFAULT_LOOP_DETECTOR, ...overrides }),
	detect,
	levelForStrikes,
};
