/** Stable reference to evidence retained in the ledger or artifact store. */
export type EvidenceRef = string;

export type VerificationStatus = "verified" | "observed" | "inferred" | "unverified" | "stale";

export interface Provenance {
	type: "user" | "model" | "tool_execution" | "repository" | "harness" | "decision" | "migration";
	ref?: EvidenceRef;
	verification: VerificationStatus;
}

export interface ProvenancedFact {
	id: string;
	text: string;
	provenance: Provenance;
	active?: boolean;
}

export interface ProvenancedDecision {
	id: string;
	decision: string;
	reason?: string;
	status: "accepted" | "proposed" | "superseded" | "rejected";
	sourceRef?: EvidenceRef;
	supersededBy?: string;
}

export interface ProvenancedIssue {
	id: string;
	description: string;
	status: "open" | "resolved" | "abandoned";
	severity?: "low" | "medium" | "high";
	evidenceRefs: EvidenceRef[];
}

export interface ExecutionTaskState {
	id: string;
	title: string;
	status: string;
	steps: { id: string; text: string; status: string; evidenceRefs?: EvidenceRef[] }[];
	startedSeq?: number;
	closedSeq?: number;
	origin?: string;
}

export interface FileChangeState {
	path: string;
	operation?: "created" | "modified" | "deleted" | "renamed" | "unknown";
	changeSummary?: string;
	evidenceRef?: EvidenceRef;
	firstSeenSeq?: number;
	lastSeenSeq?: number;
	stale?: boolean;
}

export interface ValidationState {
	status: "passed" | "failed" | "not-run" | "partial";
	command?: string;
	summary?: string;
	passed?: number;
	failed?: number;
	skipped?: number;
	evidenceRef?: EvidenceRef;
	updatedSeq?: number;
}

export interface ActiveToolCall {
	callId: string;
	name: string;
	requestedSeq: number;
}

export interface CapabilityManifest {
	workspaceType?: "ide" | "cloud-sandbox" | "unknown";
	buildCommands: string[];
	testCommands: string[];
	languageServers: string[];
	tools: string[];
	unavailable?: string[];
}

export interface ComponentVersions {
	taskSummaryVersion: number;
	planVersion: number;
	decisionSetVersion: number;
	repositoryContextVersion: number;
	fileChangeVersion: number;
	toolResultVersion: number;
	validationVersion: number;
	compactionVersion: number;
	capabilityVersion: number;
}

export const zeroComponentVersions = (): ComponentVersions => ({
	taskSummaryVersion: 0,
	planVersion: 0,
	decisionSetVersion: 0,
	repositoryContextVersion: 0,
	fileChangeVersion: 0,
	toolResultVersion: 0,
	validationVersion: 0,
	compactionVersion: 0,
	capabilityVersion: 0,
});

export interface ExecutionState {
	schemaVersion: 1;
	sessionId: string;
	runId?: string;
	eventCursor: number;
	stateVersion: number;
	objective: string;
	constraints: ProvenancedFact[];
	status: "running" | "paused" | "completed" | "failed" | "stopped";
	plan: {
		version: number;
		tasks: ExecutionTaskState[];
		completed: string[];
		inProgress: string[];
		pending: string[];
		blocked: string[];
	};
	decisions: ProvenancedDecision[];
	changes: {
		filesModified: FileChangeState[];
		version: number;
	};
	validation: {
		version: number;
		build?: ValidationState;
		tests?: ValidationState;
		checks: ValidationState[];
	};
	openIssues: ProvenancedIssue[];
	activeToolCalls: ActiveToolCall[];
	capabilities: CapabilityManifest;
	compaction: {
		compactionVersion: number;
		lastCompactionCursor?: number;
		activeSummaries: { ref: EvidenceRef; coversToSeq: number; version: number }[];
	};
	componentVersions: ComponentVersions;
	updatedAt: string;
}

export interface ToolResultEnvelope {
	schemaVersion: 1;
	toolExecutionId: string;
	toolName: string;
	status: "completed" | "failed" | "interrupted";
	summary: string;
	structuredResult?: Record<string, unknown>;
	evidenceRef: EvidenceRef;
	truncated: boolean;
	rawChars: number;
	rawSha256?: string;
	retentionClass: "critical" | "active" | "compactable" | "ephemeral";
	provenance: {
		source: "tool_execution";
		verification: VerificationStatus;
	};
}
