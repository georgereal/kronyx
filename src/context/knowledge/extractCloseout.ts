import type { TaskCloseoutRecord } from "../contracts/compaction";
import type { EmbeddingProvider, KnowledgeChunk, KnowledgeRecord, KnowledgeStore } from "./record";
import { sha256Text } from "../sharedCanonical";

/** Canonical knowledge extraction for an end-of-task closeout. */
export function knowledgeRecordFromCloseout(closeout: TaskCloseoutRecord, scope: KnowledgeRecord["scope"]): KnowledgeRecord {
	const failed = closeout.outcome === "failed" || closeout.validation.status === "failed" || closeout.validation.status === "partial";
	return {
		schemaVersion: 1,
		knowledgeId: closeout.closeoutId,
		type: failed ? "debugging_finding" : "implementation_outcome",
		title: closeout.objective.slice(0, 140) || `Run closeout ${closeout.runId ?? closeout.closeoutId}`,
		content: closeout.summary,
		scope: { ...scope, ...(closeout.sessionId ? { sessionId: closeout.sessionId } : scope.sessionId ? { sessionId: scope.sessionId } : {}) },
		source: {
			sourceType: "execution_state",
			sourceRef: `execution://seq/${closeout.sourceEventRange.fromSeq}-${closeout.sourceEventRange.toSeq}`,
			eventCursor: closeout.sourceEventRange.toSeq,
			sessionId: closeout.sessionId,
			...(closeout.runId ? { runId: closeout.runId } : {}),
			...(closeout.taskId ? { taskId: closeout.taskId } : {}),
		},
		classification: {
			tags: [
				"task-closeout",
				closeout.outcome,
				...(closeout.filesModified.length ? ["files-modified"] : []),
				...(closeout.validation.status !== "not-run" ? [`validation-${closeout.validation.status}`] : []),
			],
		},
		verification: { status: closeout.outcome === "completed" ? "observed" : "unverified", evidenceRefs: closeout.preservedEvidenceRefs.slice(0, 20) },
		lifecycle: { status: "active", contentVersion: closeout.version },
		createdAt: closeout.createdAt,
		updatedAt: closeout.createdAt,
	};
}

export function knowledgeChunksFromCloseout(record: KnowledgeRecord): KnowledgeChunk[] {
	const text = record.content.trim();
	if (!text) return [];
	return [{
		knowledgeId: record.knowledgeId,
		chunkIndex: 0,
		text,
		contentHash: sha256Text(text),
		scope: record.scope,
		lifecycleStatus: record.lifecycle.status,
		sourceRef: record.source.sourceRef,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	}];
}

/** Persist a closeout into the shared knowledge-store shape. Embeddings can be backfilled later; keyword/provenance retrieval works immediately. */
export async function persistCloseoutKnowledge(store: KnowledgeStore, closeout: TaskCloseoutRecord, scope: KnowledgeRecord["scope"], embedder?: EmbeddingProvider): Promise<KnowledgeRecord> {
	const record = knowledgeRecordFromCloseout(closeout, scope);
	await store.upsertRecord(record);
	const chunks = knowledgeChunksFromCloseout(record);
	if (embedder && chunks.length) {
		const vectors = await embedder.embed(chunks.map((c) => c.text), "knowledge_closeout").catch(() => []);
		for (let i = 0; i < chunks.length; i++) {
			const embedding = vectors[i];
			if (!embedding) continue;
			chunks[i]!.embedding = embedding;
			chunks[i]!.embeddingModel = embedder.model;
			chunks[i]!.embeddingDimensions = embedder.dimensions ?? embedding.length;
		}
	}
	await store.upsertChunks(chunks);
	return record;
}


/** Retrieves concise prior closeout knowledge for a new task. Vector retrieval
 * is preferred when an embedder is configured; keyword matching is the shared
 * degradation path across SQLite and Mongo. */
export async function retrieveCloseoutKnowledge(
	store: KnowledgeStore,
	scope: KnowledgeRecord["scope"],
	queryText: string,
	embedder?: EmbeddingProvider,
	limit = 3,
): Promise<string | undefined> {
	if (!queryText.trim() || queryText.trim().length < 12) return undefined;
	const vector = embedder ? (await embedder.embed([queryText], "knowledge_closeout_query").catch(() => []))[0] : undefined;
	const hits = await store.query({
		scope,
		types: ["implementation_outcome", "debugging_finding", "decision_record", "execution_finding"],
		text: queryText,
		...(vector ? { vector } : {}),
		limit,
	}).catch(() => []);
	if (!hits.length) return undefined;
	const lines = hits.slice(0, limit).map((hit, i) => {
		const body = (hit.chunk?.text ?? hit.record.content).replace(/\s+/g, " ").trim();
		return `${i + 1}. ${hit.record.title}: ${body.slice(0, 700)}${body.length > 700 ? "…" : ""} [${hit.record.source.sourceRef}]`;
	});
	return `Relevant closeout knowledge from earlier work (use provenance refs/log_slice for detail; do not re-derive it):\n${lines.join("\n")}`;
}
