/**
 * Recall provider (vscode-free). Optional model-aware ranking/search for the
 * recall_context tool. The tool wrapper and the session-log source stay common;
 * a profile supplies only the scorer.
 */

import type { RecallScorer, RunSearch } from "../../tools/recall";

export interface RecallProvider {
	scorer?: RecallScorer;
	searchRuns?: RunSearch;
}
