# ADR-0004: Vector store: embedded LanceDB or sqlite-vec

- Status: Accepted
- Owner: Jacob
- Created: 2026-10-31
- Decided: 2026-11-13
- Closed: -

## Context

The index must work with zero ops on a developer machine.

## Proposal

Use an embedded store behind an interface; add a shared server store (Qdrant or pgvector) later for teams.

## Alternatives considered

- Qdrant or pgvector from day one: needs a server per user or team.

## Decision and reason

Accepted: the local index lives in the embedded SQLite store (`src/store.ts`, `chunks` and `embedding_cache` tables). Embeddings are stored as Float32 blobs and ranked in JS with a bounded top-k scan (`src/agent/vector.ts`). This is simple, needs no server, and is fast enough for the current bounded index (at most 800 files and 20,000 chunks per query).

Known limits, accepted for now:
- Search is a full scan of the bounded row set. There is no ANN index. Revisit with sqlite-vec or LanceDB if the per-query scan becomes measurable.
- The shared server store (Qdrant or pgvector) remains a later option for teams and is not built.

## Work log

- 2026-10-31: proposed in the initial architecture review.
- 2026-11-13: accepted after the memory and recall review. Added prune-on-delete, a content-hash embedding cache, and bounded top-k search.
