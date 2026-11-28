export interface RepositoryMap {
	version: number;
	root?: string;
	summary: string;
	modules: { name: string; path: string; summary?: string }[];
	importantFiles: string[];
	updatedAt: string;
}

export interface FileSlice {
	path: string;
	startLine?: number;
	endLine?: number;
	content: string;
	contentHash: string;
	truncated: boolean;
	freshness: "current" | "unknown" | "stale";
}

export interface SymbolInfo {
	name: string;
	kind: string;
	path: string;
	line?: number;
	summary?: string;
	dependencies?: string[];
}

export interface TestInfo {
	path: string;
	name?: string;
	status?: "passed" | "failed" | "not-run" | "unknown";
	evidenceRef?: string;
}

export interface RepositoryFreshness {
	version: number;
	stale: boolean;
	reason?: string;
	updatedAt: string;
}
