# PLAN-014: Durable session event log and replay

- Status: Proposed
- Owner: Jacob
- Created: 2026-11-18
- Decided: -
- Closed: -
- Related: PLAN-012 (parent), PLAN-013 (seams), PLAN-006 (memory/RAG), PLAN-009 (learning loop)

## Context

Today the model's context is an in-memory `AgentMessage[]` inside `@cline/agents`'s
`Agent`; `run_events` in Mongo is UI-facing telemetry polled/SSE'd by the web app.
Consequences:

- On E2B VM death the worker reclones and **retries blind** — the new sandbox has no
  record of what the agent already did or saw.
- `recall_context` and transcripts are stored separately from what actually fed the model.
- The UI derives state from bespoke fields on `runs` docs rather than one authoritative stream.

dsh's rule — *model-visible ⟺ logged*: anything reaching a model request must be
reconstructable from the event log — plus the outbox pattern (events committed with the
change, idempotent consumers) give us the design: one append-only record per run, with
model context and all views derived as projections.

## Proposal

### 1. Canonical event schema

Define `KronyxEvent` as the durable union: `run/*` lifecycle, `user/message`,
`assistant/message` (embed the final compact stream), `assistant/attempt` (failed/
retried/cancelled attempts, kept out of model history), `tool/call` + `tool/result`,
`request/context` (what was admitted to the request), `compaction/*`, `inject/*`,
`sandbox/*` (recreate, template switch), `guard/*` (denials, nudges).

Extends today's `RunViewEvent`; adds the model-facing call/result records the log needs
that the UI never sees today.

### 2. Storage

- Extend `run_events` (already the append path in `backend/src/worker/events.ts`) to the
  canonical schema with a `seq` per run; keep it append-only — consumers are idempotent.
- Extension side: same schema to workspace state (or `.kronyx/` file) so local runs have
  the same record.
- Consider versioned generations later (dsh-style `vN` + adjacent migrations) only once
  the schema churns.

### 3. `deriveMessages(log)` projection

Pure function: log → model history. Run resume after VM death becomes: reload log →
`deriveMessages` → continue the turn, instead of the current blind re-run. Also becomes
the source for `saveTranscript`/`priorTranscripts` (recall on real events).

### 4. Projections for consumers

- UI state (status, files changed, usage, screenshot) as folds over the log — replaces
  bespoke `runs` doc fields updated ad hoc.
- `RunDigest` handoff seeded from the log instead of the live agent.
- Memory facts (`onMemoryFact`) and recall indexing become projections too (PLAN-006).

### 5. Keep the live path

Live streaming (`assistant-delta`, `tool-output-delta`, SSE) stays ephemeral; the log
stores settled records only — same split as dsh (`agent/assistant-stream` live vs
durable `assistant/message`).

## Open questions

- Log authority vs. `@cline/agents` internal message list: keep both in sync (log
  written alongside) or intercept so the log is written first?
- Resume semantics: replay from `turn/start`, or checkpoint-per-step and resume mid-turn?
- Does `deriveMessages` need to reproduce compaction, or does the log store the
  compacted request as its own event (dsh logs `request/context`)?
- Mongo doc size limits for long runs — per-event docs (current) vs. segmented
  transcript docs?

## Decision and reason

Pending.

## Work log

- 2026-11-18: proposed as Phase 2 of PLAN-012.
