# PLAN-018: Run integrity (dangling tool calls) + session UX

- Status: Partially shipped (2026-11-23). Phase 1 guards and tests landed;
  root cause of the dangling pair still open. Phase 2 failure card + Retry
  landed (untested end to end). Phase 3 rollup/jump/queued/reconnect landed;
  failed-step anchor and "···" indicator still open. See "Open items".
- Owner: Jacob
- Created: 2026-11-23
- Decided: -
- Closed: -
- Related: PLAN-014 (durable event log), PLAN-017 (seams/pipeline)

## Context

Investigated failed run `65ab26a6-0f21-479f-b5f9-01ccfd3a270e` (a plan-mode
research task). Findings:

- The run died with `AI_MissingToolResultsError` ("Tool result is missing
  for tool call call_f2d7303968054d6a804bbd5f"), thrown by the AI SDK's
  `convertToModelMessages` when a `tool-call` part has no matching
  `tool-result`. The call in question **did** finish (tool-finished at seq
  3248) — the result existed in `run_events`; the dangling reference is in
  the *message history projected to the model*.
- **62 compaction passes in ~51 iterations** — the transcript sat
  permanently over budget (`~146k → ~70k` every turn), so each new tool
  result re-triggered compaction, and each pass elided the results the
  model had just gathered. The model re-searched/re-read the same files in
  a compact→lose→refetch loop. Many `search_files` calls returned
  "No matches" partly because "session window" was ambiguous between the
  VS Code webview (`src/ui/`, `media/webview.js`) and the web dashboard
  (`web/components/Timeline.tsx`) — the model explored both.

### Investigation findings (2026-11-23, run 65ab26a6)

- Durable `agent-message` log: 127 calls, 126 results. The one dangling
  call is the final `read_file`, in flight when the run stopped — a real
  interruption, covered by the sanitize pass.
- The call named in the user-facing error (`call_f2d7…`) has its result
  recorded (seq 3249). No `run_events` row contains the error text, and the
  run has no `run-failed` event, so the failing attempt is not in durable
  storage. Its origin is not yet reproduced.
- The compaction "summarize" theory from the first draft is unsupported:
  0 of 62 passes summarized.
- All 62 passes were soft tier with a logged budget of 200,000 and nothing
  summarized. This does not match the budget-cycle model in
  `compaction.ts`; instrument the budget before tuning it.

### Where a tool-call/result pair can be split

1. **Partial summary splice** (`src/agent/compaction.ts` ~L574–608): the
   prefix is chunked in 20-message blocks; a chunk whose `summarize` call
   fails is *left in place* (`catch → undefined`). If the chunk holding a
   `tool-result` is summarized away while the adjacent chunk holding its
   `tool-call` survives verbatim → dangling call. Boundary pairs also
   produce orphan results (call summarized, result kept) — the inverse
   violation.
2. **Resume replay** (`backend/src/worker/executor.ts` `resumeLog`, seeded
   in `src/agent/runner.ts` ~L309): durable `agent-message` records end at
   whatever was persisted before the death — an assistant message with a
   `tool-call` whose result never landed → dangling call on the next
   request. Matches "again no results and failed run" on retry: the same
   poisoned transcript replays.
3. **Mid-run death** (sandbox lost between tool-call record and result
   record) — same shape as (2).

## Phase 1 — Run integrity (correctness)

### 1a. `sanitizeMessages` invariant pass — `src/agent/compaction.ts` (or new `src/agent/transcriptSanitize.ts`)

One function, applied at every boundary where history reaches the model:

- Scan parts; build `callIds` and `resultIds` sets.
- For every `tool-call` with no `tool-result`: inject a synthetic error
  result part into the following message (or append): `isError: true`,
  output `"[interrupted — run restarted or context compacted before this tool returned]"`.
  Do **not** drop the call — Anthropic/OpenAI both accept an error result;
  dropping the call loses the "what was attempted" signal.
- For every `tool-result` with no `tool-call` (orphan, possible after a
  summary splice): drop the part — providers reject or waste tokens on it.
- Pure, exported, unit-tested: `sanitizeMessages(messages) → { messages, repaired }`.

Apply at:

- **End of `createPrepareTurn`'s returned function** — final validation on
  `mutable` before `{ messages }` is returned. Covers the partial-splice
  bug regardless of which chunk failed.
- **Resume seeding** — runner.ts where `resumeLog`/`initial` messages are
  replayed (~L309–328), so poisoned durable transcripts self-heal.
- Executor `resumeLog` query can stay dumb; sanitize in the runner keeps
  the fix on the vscode-free side.

### 1b. Pair-aware summary splicing — `compaction.ts`

- When chunking the prefix for summarization, extend a chunk boundary so a
  `tool-call` and its `tool-result` never straddle two chunks (walk
  forward past the result message). Belt: 1a's final sanitize catches
  whatever still slips through (failed chunk next to a successful one).
- If a `summarize` call fails for a chunk, log it in `CompactStats`
  (`summaryFailedChunks`) so we can see it instead of silently leaving the
  chunk.

### 1c. Catch-and-repair in the runner — `runner.ts`

- Wrap the agent invocation: on `MissingToolResultsError.isInstance(err)`
  (import from `ai` — already a transitive dep; confirm it's exported
  through our SDK layer), sanitize the in-memory transcript and retry
  **once** before emitting `run-failed`. Emit an `info` event
  (`kind: "transcript_repaired"`, count of repaired calls) so the UI can
  show it.

### 1d. Compaction thrash — `compaction.ts`

62 passes in 51 turns means the trigger has no hysteresis:

- The budget cycle starts at `cap/4` (floor 64k → effective trigger ~45k
  tokens at soft tier) while the transcript wants ~150k — every turn is
  "over budget" until the ratchet catches up. The ratchet (`est/0.55`)
  already runs; investigate why it re-triggers instead of settling
  (likely: `est` re-grows past the new trigger immediately, or soft tier
  fires every pass since `estNow ≥ window*0.4` even after ratchet).
- Add a **minimum turn interval between non-forced passes** (e.g. hard
  passes at most every 3 turns; soft every 2) and/or require `est` to have
  *grown* since the last pass before re-triggering. Forced (overflow /
  manual) always runs.
- Cheap UI mitigation regardless: the web timeline should collapse
  consecutive identical `context compacted` info lines into one
  "compacted ×N" row (they're currently one row each, already deduped by
  key but not by repetition).

### 1e. Regression tests

- `test/compaction.test.ts` additions:
  - summary chunk boundary never splits a call/result pair;
  - failed `summarize` on an adjacent chunk → final output still passes
    the pair invariant;
  - `sanitizeMessages` repairs a dangling call and drops an orphan result.
- Runner-level: stub a `resumeLog` ending in a dangling call → first model
  request contains the synthetic error result (assert via captured
  messages, no LLM needed — mock the model or intercept at
  `prepareTurn`).

## Phase 2 — Failure UX (web)

Currently `run-failed` renders as a bare red line with the raw error
string (`web/components/Timeline.tsx` ~L706).

- **Structured error payload**: runner emits
  `{ type: "run-failed", error, errorKind, retryable }` where
  `errorKind ∈ missing_tool_results | sandbox_death | rate_limit |
  context_overflow | auth | no_such_tool | stopped | unknown`
  (classification helper next to the runner's catch; string-match on
  `err.name`/message as fallback).
- **Failure card** in `Timeline.tsx`: friendly title per kind ("The run
  was interrupted mid-tool-call"), plain-language subtitle, collapsible
  raw error, and actions:
  - **Retry / Continue** — POST a continue job (`resumeRunId` already
    exists in `executor.ts` JobSpec) for `retryable` kinds; prefill the
    composer otherwise.
  - Keep the run's partial timeline expanded above the card, anchored
    "failed at step N" (turn numbers already exist via `group()`).
- `web/lib/types.ts`: extend `RunEvent` for the new fields (optional —
  old events still render).

## Phase 3 — Response rendering polish (web)

Ordered by value/effort:

1. **Markdown for assistant stream text** in `Timeline.tsx` (today plain
   text) — small renderer already used elsewhere? check
   `web/components`/`sessionView` for an existing one before adding a dep.
2. **Streaming affordance**: blinking cursor on open stream items; "···"
   indicator while a turn has an open stream and no action yet.
3. **Compaction line rollup**: consecutive `context_compacted` info rows →
   "Context compacted ×N (~146k → ~70k last)" single row.
4. **Jump-to-latest pill** when `pinnedRef` is false and new events
   arrive (bottom-pin already exists — just needs the affordance).
5. **Queued placeholder**: runs with `run-started` but no other events →
   "Waiting for a worker / sandbox…" row instead of blank space.
6. **SSE reconnect indicator**: `EventSource.onerror` → "Reconnecting…"
   chip in `RunStatusLine`; today a dropped stream looks identical to a
   dead run.
7. **Per-turn elapsed** in `TurnCard` header (`at`/`endAt` already on
   `TurnItem`).

## Test plan

- `npm run check` (typecheck + lint + vitest + boundaries) and
  `cd backend && npx tsc --noEmit` green.
- New vitest cases per 1e; web: `timelineModel` tests unaffected +
  failure-card rendering exercised via a fixture event list (pattern used
  by existing model tests).
- Manual: re-run the research prompt in plan mode, watch compaction cadence
  drop; kill the worker mid-tool-call, continue → repaired transcript, no
  `MissingToolResultsError`, failure card with Retry renders on a genuine
  failure.

## Sequencing

1a + 1e first (smallest, kills the reported crash), 1d next (biggest
cost/UX win — the every-turn compaction is burning tokens *and* causing
the re-read loops), 1b/1c hardening, then Phase 2, then Phase 3 à la
carte.
