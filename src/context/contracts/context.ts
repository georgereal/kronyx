import type { ComponentVersions } from "./execution";

export type CallPurpose =
	| "planning"
	| "exploration"
	| "implementation"
	| "debugging"
	| "test-analysis"
	| "review"
	| "verification"
	| "final-response"
	| "general";

export type PayloadMode = "full" | "conversation-bind" | "conversation-delta" | "legacy-projection";

export type ContextComponentType =
	| "system_instructions"
	| "capability_instructions"
	| "user_objective"
	| "execution_state"
	| "active_plan"
	| "active_tools"
	| "decisions"
	| "change_map"
	| "validation"
	| "repository_context"
	| "retrieved_knowledge"
	| "interaction_tail"
	| "prior_task_closeout"
	| "tool_summary"
	| "omission_notice";

export interface ContextComponent {
	type: ContextComponentType;
	version?: number;
	tokenCount: number;
	priority: number;
	provenanceRefs: string[];
	content: string;
	omitReason?: string;
}

export interface TokenBreakdown {
	totalInput: number;
	effectiveInput: number;
	wireInput: number;
	outputReserve: number;
	byComponent: Partial<Record<ContextComponentType, number>>;
	estimationMethod: "tokenizer" | "provider" | "chars-estimate";
}

export interface ContextManifest {
	schemaVersion: 1;
	invocationId: string;
	sessionId: string;
	runId?: string;
	turn?: number;
	purpose: CallPurpose;
	providerId: string;
	modelId: string;
	payloadMode: PayloadMode;
	contextVersion: number;
	componentVersions: ComponentVersions;
	includedEvents: string[];
	includedToolResults: string[];
	retrievedRepositoryItems: string[];
	compactionApplied: boolean;
	compactionAuthority: "local" | "provider" | "none";
	compactionRecords: string[];
	inputTokenCount: number;
	effectiveInputTokenCount: number;
	wireInputTokenCount: number;
	tokenBreakdown: TokenBreakdown;
	outputTokenReservation: number;
	estimationMethod: "tokenizer" | "provider" | "chars-estimate";
	omittedContent: { reference: string; reason: string }[];
	truncationApplied: boolean;
	createdAt: string;
}

export interface ContextSideEffect {
	kind: "manifest" | "compaction" | "state-snapshot" | "artifact";
	payload: unknown;
}

export interface PreparedContext {
	invocationId: string;
	purpose: CallPurpose;
	payloadMode: PayloadMode;
	system: string;
	messages: unknown[];
	components: ContextComponent[];
	tokenBreakdown: TokenBreakdown;
	manifest: ContextManifest;
	sideEffects: ContextSideEffect[];
}
