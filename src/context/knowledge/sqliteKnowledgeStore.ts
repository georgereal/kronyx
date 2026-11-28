/** SQLite implementation of the shared knowledge-store contract (IDE/local). */

import type { Database } from "better-sqlite3";
import { cosine, topK } from "../../agent/vector";
import type { KnowledgeChunk, KnowledgeRecord, KnowledgeStore } from "./record";
import { bufferToFloat32, float32ToBuffer, knowledgeChunkDoc, knowledgeRecordDoc, matchesScope, scopeKey } from "./storeShape";

export function migrateKnowledgeStore(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS knowledge_records(
		scope_key TEXT NOT NULL,
		knowledge_id TEXT NOT NULL,
		type TEXT NOT NULL,
		title TEXT NOT NULL,
		lifecycle_status TEXT NOT NULL,
		source_ref TEXT NOT NULL,
		repo TEXT, branch TEXT, root TEXT, session_id TEXT,
		record_json TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY(scope_key, knowledge_id)
	)`);
	db.exec(`CREATE TABLE IF NOT EXISTS knowledge_chunks(
		scope_key TEXT NOT NULL,
		knowledge_id TEXT NOT NULL,
		chunk_index INTEGER NOT NULL,
		text TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		embedding BLOB,
		embedding_model TEXT,
		embedding_dimensions INTEGER,
		lifecycle_status TEXT NOT NULL,
		source_ref TEXT NOT NULL,
		chunk_json TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY(scope_key, knowledge_id, chunk_index)
	)`);
	db.exec(`CREATE INDEX IF NOT EXISTS knowledge_chunks_scope ON knowledge_chunks(scope_key, lifecycle_status)`);
	db.exec(`CREATE INDEX IF NOT EXISTS knowledge_records_scope ON knowledge_records(scope_key, type, lifecycle_status)`);
}

const asRecord = (row: unknown): KnowledgeRecord | undefined => {
	try {
		return JSON.parse(String((row as Record<string, unknown>).record_json ?? "")) as KnowledgeRecord;
	} catch {
		return undefined;
	}
};

const asChunk = (row: Record<string, unknown>): KnowledgeChunk | undefined => {
	try {
		const chunk = JSON.parse(String(row.chunk_json ?? "")) as KnowledgeChunk;
		if (row.embedding) chunk.embedding = bufferToFloat32(row.embedding as Uint8Array);
		return chunk;
	} catch {
		return undefined;
	}
};

export class SqliteKnowledgeStore implements KnowledgeStore {
	constructor(private readonly db: Database) {
		migrateKnowledgeStore(db);
	}

	async upsertRecord(record: KnowledgeRecord): Promise<void> {
		const doc = knowledgeRecordDoc(record);
		this.db.prepare(`INSERT OR REPLACE INTO knowledge_records(
			scope_key, knowledge_id, type, title, lifecycle_status, source_ref, repo, branch, root, session_id, record_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			doc.scopeKey, record.knowledgeId, record.type, record.title, record.lifecycle.status, record.source.sourceRef,
			record.scope.repo ?? null, record.scope.branch ?? null, record.scope.root ?? null, record.scope.sessionId ?? null,
			JSON.stringify(record), record.createdAt, record.updatedAt,
		);
	}

	async getRecord(knowledgeId: string, scope?: KnowledgeRecord["scope"]): Promise<KnowledgeRecord | undefined> {
		if (!scope) return undefined;
		const row = this.db.prepare("SELECT record_json FROM knowledge_records WHERE scope_key = ? AND knowledge_id = ?").get(scopeKey(scope), knowledgeId);
		return row ? asRecord(row) : undefined;
	}

	async upsertChunks(chunks: KnowledgeChunk[]): Promise<void> {
		const stmt = this.db.prepare(`INSERT OR REPLACE INTO knowledge_chunks(
			scope_key, knowledge_id, chunk_index, text, content_hash, embedding, embedding_model, embedding_dimensions,
			lifecycle_status, source_ref, chunk_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const tx = this.db.transaction((rows: KnowledgeChunk[]) => {
			for (const chunk of rows) {
				const doc = knowledgeChunkDoc(chunk);
				stmt.run(
					doc.scopeKey, chunk.knowledgeId, chunk.chunkIndex, chunk.text, chunk.contentHash,
					chunk.embedding ? float32ToBuffer(chunk.embedding) : null, chunk.embeddingModel ?? null, chunk.embeddingDimensions ?? null,
					chunk.lifecycleStatus, chunk.sourceRef, JSON.stringify({ ...chunk, embedding: undefined }), chunk.createdAt, chunk.updatedAt,
				);
			}
		});
		tx(chunks);
	}

	async query(input: {
		scope: KnowledgeRecord["scope"];
		types?: KnowledgeRecord["type"][];
		text?: string;
		vector?: Float32Array | number[];
		limit?: number;
		includeStatuses?: KnowledgeRecord["lifecycle"]["status"][];
	}): Promise<{ record: KnowledgeRecord; chunk?: KnowledgeChunk; score?: number }[]> {
		const limit = input.limit ?? 8;
		const statuses = input.includeStatuses ?? ["active"];
		const typeSet = input.types?.length ? new Set(input.types) : undefined;
		const rows = this.db.prepare("SELECT * FROM knowledge_chunks").all() as Record<string, unknown>[];
		const chunks = rows.map(asChunk).filter((c): c is KnowledgeChunk => !!c && statuses.includes(c.lifecycleStatus) && matchesScope(c.scope, input.scope));
		let scored: { chunk: KnowledgeChunk; score: number }[] = [];
		if (input.vector) {
			const q = Array.from(input.vector);
			scored = topK(chunks.filter((c) => c.embedding), limit * 3, (c) => cosine(q, c.embedding as ArrayLike<number>)).map(({ item, score }) => ({ chunk: item, score }));
		} else if (input.text) {
			const terms = input.text.toLowerCase().split(/\s+/).filter((t) => t.length > 2).slice(0, 12);
			scored = chunks.map((chunk) => {
				const text = chunk.text.toLowerCase();
				const hits = terms.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0);
				return { chunk, score: hits / Math.max(1, terms.length) };
			}).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit * 3);
		} else {
			scored = chunks.slice(0, limit * 3).map((chunk) => ({ chunk, score: 0 }));
		}
		const out: { record: KnowledgeRecord; chunk?: KnowledgeChunk; score?: number }[] = [];
		const seen = new Set<string>();
		for (const hit of scored) {
			if (seen.has(hit.chunk.knowledgeId)) continue;
			const record = await this.getRecord(hit.chunk.knowledgeId, hit.chunk.scope);
			if (!record || !statuses.includes(record.lifecycle.status) || (typeSet && !typeSet.has(record.type))) continue;
			seen.add(hit.chunk.knowledgeId);
			out.push({ record, chunk: hit.chunk, score: hit.score });
			if (out.length >= limit) break;
		}
		return out;
	}

	async deleteRecord(knowledgeId: string, scope?: KnowledgeRecord["scope"]): Promise<void> {
		if (!scope) return;
		const key = scopeKey(scope);
		this.db.prepare("DELETE FROM knowledge_records WHERE scope_key = ? AND knowledge_id = ?").run(key, knowledgeId);
		this.db.prepare("DELETE FROM knowledge_chunks WHERE scope_key = ? AND knowledge_id = ?").run(key, knowledgeId);
	}

	async reconcile(input: { scope: KnowledgeRecord["scope"]; validKnowledgeIds: string[] }): Promise<void> {
		const key = scopeKey(input.scope);
		const valid = new Set(input.validKnowledgeIds);
		const rows = this.db.prepare("SELECT knowledge_id FROM knowledge_records WHERE scope_key = ?").all(key) as { knowledge_id: string }[];
		for (const row of rows) if (!valid.has(row.knowledge_id)) await this.deleteRecord(row.knowledge_id, input.scope);
	}
}
