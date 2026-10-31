# ADR-0004: Vector store: embedded LanceDB or sqlite-vec

- Status: Proposed
- Owner: Jacob
- Created: 2026-10-31
- Decided: -
- Closed: -

## Context

The index must work with zero ops on a developer machine.

## Proposal

Use an embedded store behind an interface; add a shared server store (Qdrant or pgvector) later for teams.

## Alternatives considered

- Qdrant or pgvector from day one: needs a server per user or team.

## Decision and reason

Pending.

## Work log

- 2026-10-31: proposed in the initial architecture review.
