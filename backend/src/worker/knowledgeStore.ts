/** Mongo implementation of the shared knowledge-store contract (cloud). */

import type { Db } from "mongodb";
import type { KnowledgeChunk, KnowledgeRecord, KnowledgeStore } from "../../../src/context/knowledge/record";
import { knowledgeChunkDoc, knowledgeRecordDoc, scopeFilter, scopeKey } from "../../../src/context/knowledge/storeShape";

const RECORDS = "knowledge_records";
const CHUNKS = "knowledge_chunks";
const VECTOR_INDEX = "knowledge_chunks_vector";

type Scope = KnowledgeRecord["scope"];
type Status = KnowledgeRecord["lifecycle"]["status"];

const scopedFilter = (scope: Scope, knowledgeId?: string) => ({ scopeKey: scopeKey(scope), ...(knowledgeId ? { knowledgeId } : {}) });

function textScore(text: string, query: string): number {
	const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2).slice(0, 12);
	if (!terms.length) return 0;
	const hay = text.toLowerCase();
	return terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0) / terms.length;
}

export class MongoKnowledgeStore implements KnowledgeStore {
	constructor(
		private readonly db: Db,
		private readonly collections: { records?: string; chunks?: string; vectorIndex?: string } = {},
	) {}

	private records() {
		return this.db.collection(this.collections.records ?? RECORDS);
	}

	private chunks() {
		return this.db.collection(this.collections.chunks ?? CHUNKS);
	}

	async upsertRecord(record: KnowledgeRecord): Promise<void> {
		const doc = knowledgeRecordDoc(record);
		await this.records().replaceOne(scopedFilter(record.scope, record.knowledgeId), doc, { upsert: true });
	}

	async getRecord(knowledgeId: string, scope?: Scope): Promise<KnowledgeRecord | undefined> {
		if (!scope) return undefined;
		const doc = await this.records().findOne(scopedFilter(scope, knowledgeId));
		return (doc as unknown as KnowledgeRecord | null) ?? undefined;
	}

	async upsertChunks(chunks: KnowledgeChunk[]): Promise<void> {
		if (!chunks.length) return;
		await this.chunks().bulkWrite(chunks.map((chunk) => ({
			replaceOne: {
				filter: { scopeKey: scopeKey(chunk.scope), knowledgeId: chunk.knowledgeId, chunkIndex: chunk.chunkIndex },
				replacement: knowledgeChunkDoc(chunk),
				upsert: true,
			},
		})));
	}

	async query(input: {
		scope: Scope;
		types?: KnowledgeRecord["type"][];
		text?: string;
		vector?: Float32Array | number[];
		limit?: number;
		includeStatuses?: Status[];
	}): Promise<{ record: KnowledgeRecord; chunk?: KnowledgeChunk; score?: number }[]> {
		const limit = input.limit ?? 8;
		const statuses = input.includeStatuses ?? ["active"];
		const filterScope = scopeFilter(input.scope);
		let hits: { chunk: KnowledgeChunk; score: number }[] = [];
		if (input.vector) {
			const rows = await this.chunks().aggregate([
				{
					$vectorSearch: {
						index: this.collections.vectorIndex ?? VECTOR_INDEX,
						path: "embedding",
						queryVector: Array.from(input.vector),
						numCandidates: Math.max(50, limit * 10),
						limit: limit * 3,
						filter: { ...filterScope, lifecycleStatus: { $in: statuses } },
					},
				},
				{ $addFields: { score: { $meta: "vectorSearchScore" } } },
			]).toArray();
			hits = rows.map((row) => ({ chunk: row as unknown as KnowledgeChunk, score: Number((row as Record<string, unknown>).score ?? 0) }));
		} else {
			const rows = await this.chunks().find({ ...filterScope, lifecycleStatus: { $in: statuses } }).sort({ updatedAt: -1 }).limit(500).toArray();
			hits = rows.map((row) => {
				const chunk = row as unknown as KnowledgeChunk;
				return { chunk, score: input.text ? textScore(`${chunk.text}\n${chunk.sourceRef}`, input.text) : 0 };
			}).filter((hit) => !input.text || hit.score > 0).sort((a, b) => b.score - a.score).slice(0, limit * 3);
		}
		const typeSet = input.types?.length ? new Set(input.types) : undefined;
		const out: { record: KnowledgeRecord; chunk?: KnowledgeChunk; score?: number }[] = [];
		const seen = new Set<string>();
		for (const hit of hits) {
			if (seen.has(hit.chunk.knowledgeId)) continue;
			const record = await this.getRecord(hit.chunk.knowledgeId, hit.chunk.scope);
			if (!record || !statuses.includes(record.lifecycle.status) || (typeSet && !typeSet.has(record.type))) continue;
			seen.add(hit.chunk.knowledgeId);
			out.push({ record, chunk: hit.chunk, score: hit.score });
			if (out.length >= limit) break;
		}
		return out;
	}

	async deleteRecord(knowledgeId: string, scope?: Scope): Promise<void> {
		if (!scope) return;
		await this.records().deleteOne(scopedFilter(scope, knowledgeId));
		await this.chunks().deleteMany(scopedFilter(scope, knowledgeId));
	}

	async reconcile(input: { scope: Scope; validKnowledgeIds: string[] }): Promise<void> {
		const filter = { scopeKey: scopeKey(input.scope), knowledgeId: { $nin: input.validKnowledgeIds } };
		await this.records().deleteMany(filter);
		await this.chunks().deleteMany(filter);
	}
}
