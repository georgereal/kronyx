export type KnowledgeType =
	| "repository_file_summary"
	| "code_symbol_summary"
	| "architecture_section"
	| "execution_finding"
	| "implementation_outcome"
	| "debugging_finding"
	| "decision_record"
	| "test_scenario"
	| "environment_finding"
	| "tool_finding"
	| "memory_fact";

export interface KnowledgeRecord {
	schemaVersion: 1;
	knowledgeId: string;
	type: KnowledgeType;
	title: string;
	content: string;
	scope: {
		tenantId?: string;
		uid?: string;
		repositoryId?: string;
		repo?: string;
		branch?: string;
		workspaceId?: string;
		root?: string;
		sessionId?: string;
		module?: string;
	};
	source: {
		sourceType: "execution_event" | "execution_state" | "repository" | "decision" | "test" | "memory" | "manual";
		sourceRef: string;
		eventCursor?: number;
		taskId?: string;
		sessionId?: string;
		runId?: string;
	};
	codeLocation?: {
		filePath?: string;
		symbol?: string;
		startLine?: number;
		endLine?: number;
	};
	classification: {
		language?: string;
		tags: string[];
	};
	verification: {
		status: "verified" | "observed" | "inferred" | "unverified" | "stale";
		evidenceRefs: string[];
	};
	lifecycle: {
		status: "active" | "candidate" | "superseded" | "deleted" | "quarantined";
		contentVersion: number;
		supersedes?: string;
	};
	embedding?: {
		provider: string;
		model: string;
		dimensions: number;
		contentHash: string;
		indexVersion?: string;
	};
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeChunk {
	knowledgeId: string;
	chunkIndex: number;
	text: string;
	contentHash: string;
	embedding?: Float32Array | number[];
	embeddingModel?: string;
	embeddingDimensions?: number;
	scope: KnowledgeRecord["scope"];
	lifecycleStatus: KnowledgeRecord["lifecycle"]["status"];
	sourceRef: string;
	createdAt: string;
	updatedAt: string;
}

export interface EmbeddingProvider {
	model: string;
	dimensions?: number;
	embed(texts: string[], op: string): Promise<(Float32Array | number[] | undefined)[]>;
}

export interface KnowledgeStore {
	upsertRecord(record: KnowledgeRecord): Promise<void>;
	getRecord(knowledgeId: string, scope?: KnowledgeRecord["scope"]): Promise<KnowledgeRecord | undefined>;
	upsertChunks(chunks: KnowledgeChunk[]): Promise<void>;
	query(input: {
		scope: KnowledgeRecord["scope"];
		types?: KnowledgeType[];
		text?: string;
		vector?: Float32Array | number[];
		limit?: number;
		includeStatuses?: KnowledgeRecord["lifecycle"]["status"][];
	}): Promise<{ record: KnowledgeRecord; chunk?: KnowledgeChunk; score?: number }[]>;
	deleteRecord(knowledgeId: string, scope?: KnowledgeRecord["scope"]): Promise<void>;
	reconcile?(input: { scope: KnowledgeRecord["scope"]; validKnowledgeIds: string[] }): Promise<void>;
}
