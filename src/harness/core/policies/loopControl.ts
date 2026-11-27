/**
 * Loop-control policy (vscode-free). Detects repeats, stalls and alternation in
 * the tool-call history and maps consecutive strikes to a level. The kernel
 * records the verdict event and applies the warn/block/strip/pause ladder.
 */

import type { LoopDetectorConfig, LoopLevel } from "../contracts";

export interface CallRecord {
	callId: string;
	fingerprint: string;
	/** Hash of the result once the call finished; undefined while it is still pending. */
	resultHash?: string;
	/** Normalized error-class hash, present only on failed calls. Two failures
	 *  sharing a failSig are the same error even when their text differs in details. */
	failSig?: string;
}

export type LoopReason = "repeat" | "stuck" | "alternation";

export interface LoopControlPolicy {
	/** Effective detector config, with host overrides applied. */
	config(overrides?: Partial<LoopDetectorConfig>): LoopDetectorConfig;
	/** Classify the next call against recent history. Returns undefined when unflagged. */
	detect(history: readonly CallRecord[], fingerprint: string, cfg: LoopDetectorConfig): LoopReason | undefined;
	/** Level for a flagged call given consecutive prior strikes. */
	levelForStrikes(strikes: number): LoopLevel;
}
