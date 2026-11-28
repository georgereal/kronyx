import { canonicalJson } from "../../harness/core/canonical";
import type { KnowledgeChunk, KnowledgeRecord } from "./record";

/** Canonical scope identity shared by SQLite rows and Mongo documents. */
export function normalizeScope(scope: KnowledgeRecord["scope"]): KnowledgeRecord["scope"] {
	const out: Record<string, string> = {};
	for (const key of ["tenantId", "uid", "repositoryId", "repo", "branch", "workspaceId", "root", "sessionId", "module"] as const) {
		const value = scope[key];
		if (value !== undefined && value !== "") out[key] = value;
	}
	return out;
}

export function scopeKey(scope: KnowledgeRecord["scope"]): string {
	return canonicalJson(normalizeScope(scope));
}

/** Query semantics: fields present on the query scope are required; absent
 * fields are wildcards. Writes keep exact scope identity, while retrieval can
 * widen from one session to the enclosing repo/workspace. */
export function matchesScope(stored: KnowledgeRecord["scope"], query: KnowledgeRecord["scope"]): boolean {
	for (const key of ["tenantId", "uid", "repositoryId", "repo", "branch", "workspaceId", "root", "sessionId", "module"] as const) {
		const want = query[key];
		if (want !== undefined && want !== "" && stored[key] !== want) return false;
	}
	return true;
}

export function scopeFilter(query: KnowledgeRecord["scope"]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["tenantId", "uid", "repositoryId", "repo", "branch", "workspaceId", "root", "sessionId", "module"] as const) {
		const value = query[key];
		if (value !== undefined && value !== "") out[`scope.${key}`] = value;
	}
	return out;
}

export function knowledgeKey(record: Pick<KnowledgeRecord, "knowledgeId" | "scope">): string {
	return `${scopeKey(record.scope)}::${record.knowledgeId}`;
}

/** Stored shape shared by SQLite JSON payloads and Mongo documents. */
export function knowledgeRecordDoc(record: KnowledgeRecord): Record<string, unknown> {
	return {
		...record,
		scope: normalizeScope(record.scope),
		scopeKey: scopeKey(record.scope),
		knowledgeKey: knowledgeKey(record),
	};
}

export function knowledgeChunkDoc(chunk: KnowledgeChunk): Record<string, unknown> {
	return {
		...chunk,
		scope: normalizeScope(chunk.scope),
		scopeKey: scopeKey(chunk.scope),
		chunkKey: `${scopeKey(chunk.scope)}::${chunk.knowledgeId}::${chunk.chunkIndex}`,
		...(chunk.embedding ? { embedding: Array.from(chunk.embedding) } : {}),
	};
}

export function float32ToBuffer(embedding: Float32Array | number[]): Buffer {
	const vector = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToFloat32(buffer: Uint8Array): Float32Array {
	const copy = new Uint8Array(buffer.byteLength);
	copy.set(buffer);
	return new Float32Array(copy.buffer);
}
