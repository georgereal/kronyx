import { describe, expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import { SqliteKnowledgeStore } from "../src/context/knowledge/sqliteKnowledgeStore";
import type { KnowledgeChunk, KnowledgeRecord } from "../src/context/knowledge/record";
import { retrieveCloseoutKnowledge } from "../src/context/knowledge/extractCloseout";

const scope = { root: "/repo", sessionId: "s1" };

function record(id = "k1"): KnowledgeRecord {
	return {
		schemaVersion: 1,
		knowledgeId: id,
		type: "execution_finding",
		title: "Test finding",
		content: "vitest failures usually come from missing mocks",
		scope,
		source: { sourceType: "execution_event", sourceRef: "execution://seq/4", eventCursor: 4, sessionId: "s1", runId: "r1" },
		classification: { tags: ["test", "debugging"] },
		verification: { status: "observed", evidenceRefs: ["execution://seq/4"] },
		lifecycle: { status: "active", contentVersion: 1 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function chunk(recordId = "k1", embedding: number[] = [1, 0, 0]): KnowledgeChunk {
	return {
		knowledgeId: recordId,
		chunkIndex: 0,
		text: "vitest failures missing mocks",
		contentHash: "hash",
		embedding,
		embeddingModel: "test-embed",
		embeddingDimensions: 3,
		scope,
		lifecycleStatus: "active",
		sourceRef: "execution://seq/4",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("shared SQLite knowledge store", () => {
	it("round-trips canonical records and chunks in one scoped shape", async () => {
		const db = new Sqlite(":memory:");
		const store = new SqliteKnowledgeStore(db);
		await store.upsertRecord(record());
		await store.upsertChunks([chunk()]);
		expect(await store.getRecord("k1", scope)).toMatchObject({ knowledgeId: "k1", type: "execution_finding", scope });
		const hits = await store.query({ scope, vector: [1, 0, 0], limit: 4 });
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ record: { knowledgeId: "k1" }, chunk: { knowledgeId: "k1" } });
		expect(hits[0]?.score).toBeGreaterThan(0.99);
		expect(hits[0]?.chunk?.embedding).toBeInstanceOf(Float32Array);
	});

	it("keeps scopes and lifecycles partitioned and reconcile deletes stale records", async () => {
		const db = new Sqlite(":memory:");
		const store = new SqliteKnowledgeStore(db);
		await store.upsertRecord(record("active"));
		await store.upsertChunks([chunk("active")]);
		await store.upsertRecord({ ...record("other-scope"), scope: { root: "/repo", sessionId: "s2" } });
		await store.upsertChunks([{ ...chunk("other-scope"), scope: { root: "/repo", sessionId: "s2" } }]);
		expect(await store.query({ scope, vector: [1, 0, 0] })).toHaveLength(1);
		await store.reconcile({ scope, validKnowledgeIds: [] });
		expect(await store.getRecord("active", scope)).toBeUndefined();
		expect(await store.getRecord("other-scope", { root: "/repo", sessionId: "s2" })).toBeDefined();
	});

	it("retrieves closeout knowledge through the shared query contract", async () => {
		const db = new Sqlite(":memory:");
		const store = new SqliteKnowledgeStore(db);
		await store.upsertRecord(record());
		await store.upsertChunks([chunk()]);
		const text = await retrieveCloseoutKnowledge(store, scope, "why did vitest fail with mocks?", {
			model: "test-embed",
			embed: async (texts) => texts.map(() => [1, 0, 0]),
		});
		expect(text).toContain("Relevant closeout knowledge");
		expect(text).toContain("execution://seq/4");
	});
});
