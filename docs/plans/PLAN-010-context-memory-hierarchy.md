# PLAN-010: Context and memory hierarchy (compaction, handoff, recall)

- Status: Proposed
- Owner: Jacob
- Created: 2026-11-04
- Decided: -
- Closed: -
- Related: PLAN-006 (memory/RAG), ADR-0004

## Context

Agentic runs resend the full transcript each iteration. Observation from a live run (2026-11-04, nvidia/nemotron via Vercel AI Gateway): input grew 2.5k → 86k tokens over 17 iterations, ~73% served from prefix cache (`cacheReadTokens` — surfaced in usage events 2026-11-04). Caching makes growth cheap-ish, not free: the uncached tail grows linearly with tool chatter, prefill latency grows, and stale/failed-step context can anchor the model to old file state.

Three distinct memory tiers emerge:

- **Working memory** = the prompt actually sent to the model.
- **Warm recall** = the canonical transcript (the runtime's `prepareTurn` reshapes only the request projection — pruned content still exists in `context.snapshot.messages`).
- **Cold recall** = persisted prior-run transcripts in the store, reachable across task handoffs and extension reloads.

## Findings (SDK capabilities, verified in @cline 0.2.0 dist)

- `AgentRuntimeConfig.prepareTurn` — host hook before every model call; receives `previousRequestInputTokens` (real provider count), `model.info.contextWindow`, `overflowRecovery` flag. Runtime auto-recovers context-window overflow and max-tokens truncation by forcing a compaction + one retry through this hook.
- `@cline/llms` already emits `cache_control` breakpoints and parses `cacheReadTokens`/`cacheWriteTokens`; supports `stickySession` provider metadata for cache affinity.
- `AgentToolContext.snapshot.messages` — full canonical transcript available inside any tool's `execute`.
- `AgentRuntimeConfig.initialMessages` — seed messages for a fresh agent (cross-run handoff mechanism).
- `AgentRuntimeEvent` `status-notice` — runtime/user notices forwarded to the UI as `info` events (done).

## Already shipped (2026-11-04)

- Cached-token reporting end-to-end (`runner.ts` → `sessionController.ts` → `store.ts` `cache_read`/`cache_write` columns → webview token chip).
- `eval_results` table + persistence in `writeReport`.
- System prompt reordered: static instructions first, volatile `memoryContext` last (prefix-cache stability).
- `src/agent/compaction.ts` v1: `prepareTurn` clamps oversized tool outputs (>12k chars, head+tail); stubs tool results at ~70% of window or on `overflowRecovery`, ordered errors → exact-duplicate calls → oldest; keep-recent last 6 results; projection-only (idempotent, transcript untouched).

## Proposal

### 1. Compaction v2 — relevance-aware, two tiers

- **Mid-tier (~40% of window):** stub only `isError` results and superseded results beyond keep-recent. Removes near-pure noise early without touching anything the model may still need for self-correction (failures are useful short-term — e.g. `pip` → `python3 -m pip` retries).
- **Supersession by target:** group results by `toolName` + path-ish input key (`path`/`file`/`filePath`/`rel`); all but the newest occurrence rank just below `isError`. A `read_file` superseded by a newer read/edit of the same path is dead weight; a failed `str_replace` is dead once a `write_file` on that path succeeded.
- Full ordering (errors → superseded → oldest) still applies at the 70% hard trigger and on forced overflow recovery.

### 2. Cross-run handoff — digest instead of full transcript (hybrid at ~40%)

Problem: `AgentRunner` reuses the same `Agent` across tasks, so task N resends all of tasks 1..N-1 including dead ends.

- `sessionController` builds a per-run digest on `run-finished`/`run-failed`: `{ task, status, summary (result.outputText), filesChanged[], at }`. Files-changed is the highest-value carry-forward ("the code is the truth").
- On the next `run(task)`: estimate transcript size from `agent.snapshot().messages`; under ~40% of window → reuse agent (full continuity for short follow-ups); over → fresh `Agent` with `initialMessages` = digest user message (last 3 digests). Fresh agent also re-retrieves `memoryContext` for the new task (currently frozen from task 1).
- Persist digests to `kv` as `session:<name>:digest`; emit an `info` event on handoff compaction.

### 3. Transcript recall — pull pruned context back on demand

New `recall_context` tool (registered with the file tools):

- `{ toolCallId }` → verbatim original output of a stubbed/elided result from `context.snapshot.messages`.
- `{ query }` → keyword search across serialized message contents, top matches as truncated snippets.
- `{ runIndex }` → search persisted prior-run transcripts (new `transcripts` table written on `run-finished`).
- Output capped ~8k chars so recall re-enters context cheaply.

Stub text points at the tool: `[output elided — call recall_context with toolCallId "c1" to retrieve]`. Better than "re-run the tool" for non-reproducible outputs (`run_command` results). System prompt gains one line telling the model elided outputs and earlier tasks are retrievable via `recall_context`.

## What this is not

- No client-side KV cache — impossible/inappropriate; provider-side caching is already exploited (cache_control, prefix-stable system prompt, sticky sessions).
- No ClickHouse/columnar store — data volumes are SQLite-scale; the real future store concern is sql.js full-DB rewrites, addressed separately if needed.
- No semantic transcript search in this phase — keyword + exact-id recall first; embeddings plumbing in `memory.ts` can add it later.
- No LLM-summarization compaction yet — deterministic stubbing + recall first; `prepareTurn` is the same hook if added later.

## Files

- `src/agent/compaction.ts` — mid-tier, supersession, stub text (exists, extend)
- `src/agent/recall.ts` — new tool
- `src/agent/runner.ts` — handoff decision, `addRunDigest`, `initialMessages`, register recall
- `src/agent/systemPrompt.ts` — recall_context line
- `src/ui/sessionController.ts` — digest build, transcript persist
- `src/extension.ts` — `saveDigest`/`loadDigest`/`saveTranscript` deps
- `src/store.ts` — `transcripts` table
- `test/compaction.test.ts`, `test/recall.test.ts` (new)

## Open questions

- Persist full transcripts per run (storage cost) or only digests + keep recall within the live session?
- Should handoff keep the last assistant message verbatim in addition to summaries?
- Digest retention: last 3 vs configurable?

## Decision and reason

Pending.

## Work log

- 2026-11-04: analysis of live run; KV-cache/columnar questions resolved (client-side N/A, SQLite sufficient); cached-token reporting, eval persistence, prompt-prefix reorder, and compaction v1 shipped; this plan drafted.
- 2026-11-04: implemented all three parts — compaction v2 (40% soft tier + same-target supersession + recall-pointing stubs), `recall_context` tool (toolCallId fetch, keyword search, prior-run runIndex), cross-run handoff (digests in kv, fresh agent with initialMessages at ~40%, transcripts table); contextWindow resolved from model catalog. 48 tests pass.
