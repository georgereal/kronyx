import type { ComponentVersions, EvidenceRef } from "./execution";

export type CompactionScope =
	| "tool_output"
	| "interaction_history"
	| "task_milestone"
	| "task_closeout"
	| "repository_context";

export interface CompactionRecord {
	schemaVersion: 1;
	compactionId: string;
	scope: CompactionScope;
	sourceEventRange: { from: number; to: number };
	summaryRef?: EvidenceRef;
	preservedReferences: EvidenceRef[];
	createdAt: string;
	version: number;
	componentVersions: ComponentVersions;
	modelGenerated: boolean;
}

export interface CompactionProposal {
	record: CompactionRecord;
	summary: string;
	usage?: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

export interface TaskCloseoutRecord {
	schemaVersion: 1;
	closeoutId: string;
	sessionId: string;
	runId?: string;
	taskId?: string;
	sourceEventRange: { fromSeq: number; toSeq: number };
	objective: string;
	outcome: "completed" | "failed" | "stopped" | "paused";
	summary: string;
	decisions: { decision: string; reason?: string; evidenceRefs: EvidenceRef[] }[];
	filesModified: { path: string; changeSummary?: string; evidenceRef?: EvidenceRef }[];
	validation: {
		status: "passed" | "failed" | "not-run" | "partial";
		commands?: string[];
		failureSummary?: string;
		evidenceRefs: EvidenceRef[];
	};
	unresolvedIssues: { description: string; severity?: string; evidenceRefs: EvidenceRef[] }[];
	reusableKnowledgeRefs: string[];
	preservedEvidenceRefs: EvidenceRef[];
	componentVersions: ComponentVersions;
	version: number;
	createdAt: string;
}
