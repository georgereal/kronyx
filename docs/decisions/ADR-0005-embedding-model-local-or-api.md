# ADR-0005: Embedding model: local or API

- Status: Accepted (API default; local model deferred)
- Owner: Jacob
- Created: 2026-10-31
- Decided: 2026-11-13
- Closed: -

## Context

Embedding code with an API sends code off the machine.

## Proposal

Open. Make it configurable; default depends on the data policy.

## Alternatives considered

- Local open-weights code embedder via Ollama.
- Hosted embedding API.

## Decision and reason

Accepted: embeddings use the configured hosted API by default, through the same provider settings as chat (`embedTexts` in `src/agent/memory.ts`). The embedding model is configurable. Memory is gated on the embedding model being set, so nothing is embedded unless the user configures one.

Local embeddings (Ollama, ADR-0005 option 1) are deferred, not rejected. They are the path if the data policy forbids sending code off the machine. Until then, the user controls the decision by leaving the embedding model unset.

Cost control in place:
- Unchanged text is never re-embedded: a content-hash cache (`embedding_cache`, keyed by hash and model) sits in front of every embedding call.
- Indexing skips files whose mtime is unchanged.
- Recall embeds at most 40 uncached transcript chunks per query.

## Work log

- 2026-10-31: proposed in the initial architecture review.
- 2026-11-13: accepted as API-default with a content-hash cache and per-query embed cap; local model deferred.
