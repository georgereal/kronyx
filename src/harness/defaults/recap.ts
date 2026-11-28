/**
 * Recap compaction adapter (vscode-free). The implementation lives in
 * src/context/adapters/harnessRecap.ts as the shared interaction-history
 * compactor; this module exposes it through the harness RecapPolicy seam.
 */

import type { RecapPolicy } from "../core/policies/recap";
import { maybeHarnessRecap, makeRecap, transcriptOf, RECAP_SYSTEM } from "../../context/adapters/harnessRecap";

export { RECAP_SYSTEM, makeRecap, transcriptOf };

/**
 * Today's trigger logic as the default RecapPolicy: the manual Compact control
 * or context pressure (the last request exceeding the projected-context
 * budget). Task completion alone does NOT trigger a recap — for large-window
 * models that compacts far below the window, and the recap drops the verbatim
 * file contents the model then re-reads, feeding repeat-read loops. A failed
 * recap is not fatal — older messages stay stubbed.
 */
export const defaultRecapPolicy: RecapPolicy = {
	maybeRecap: maybeHarnessRecap,
};
