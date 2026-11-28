import type { ExecutionState, ToolResultEnvelope } from "./execution";
import type { FileSlice, RepositoryFreshness, RepositoryMap, SymbolInfo, TestInfo } from "./repository";

export interface TokenCounter {
	count(text: string): number;
	countJson?(value: unknown): number;
	method: "tokenizer" | "provider" | "chars-estimate";
}

export interface ExecutionStateStore {
	load(sessionId: string, runId?: string): Promise<ExecutionState | undefined>;
	save(state: ExecutionState): Promise<void>;
}

export interface EvidenceStore {
	put(input: { content: string; kind: string; refHint?: string }): Promise<string>;
	get(ref: string): Promise<string | undefined>;
}

export interface RepositoryKnowledgeProvider {
	getMap(input: { root?: string; refresh?: boolean }): Promise<RepositoryMap | undefined>;
	findRelevant(input: { query: string; purpose?: string; limit?: number }): Promise<{ ref: string; summary: string; score?: number }[]>;
	readFileSlice(input: { path: string; startLine?: number; endLine?: number }): Promise<FileSlice | undefined>;
	getSymbols(input: { query?: string; paths?: string[]; limit?: number }): Promise<SymbolInfo[]>;
	getTests(input: { paths?: string[]; limit?: number }): Promise<TestInfo[]>;
	invalidate(paths: string[]): Promise<void>;
	freshness(): Promise<RepositoryFreshness>;
}

export interface Summarizer {
	summarize(input: { purpose: string; content: string; requiredSections: string[]; maxWords?: number }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens: number } }>;
}

export interface NormalizeToolResultInput {
	toolExecutionId: string;
	toolName: string;
	input?: unknown;
	output: string;
	ok: boolean;
	interrupted?: boolean;
}

export type { ToolResultEnvelope };
