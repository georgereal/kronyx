# ADR-0003: Defer own open-weights models; start with RAG and memory

- Status: Proposed
- Owner: Jacob
- Created: 2026-10-31
- Decided: -
- Closed: -

## Context

Feedback cannot change hosted models. Fine-tuning needs a dataset and an eval harness first.

## Proposal

Ship rules, project facts, code index and episode retrieval first. Fine-tune small open-weights models later for narrow roles (apply model, reranker, router), gated by the eval harness.

## Alternatives considered

- Fine-tune the main reasoning model now: expensive, no data yet, hard to evaluate.

## Decision and reason

Pending.

## Work log

- 2026-10-31: proposed in the initial architecture review.
