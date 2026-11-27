# PLAN-019: Agent harness rewrite — host-owned state, task ledger, steering

- Status: In progress (M0–M9 implemented; selected per run from the composer's Harness engine; M10 scripted suite done, real-model comparison and eval wiring not done). The IDE runs the harness for every run; the OpenAI transport adds server-side Conversations (direct OpenAI) with delta sends and reasoning replay. `OpenAIEngine` and `AgentRunner` are off the IDE run path, kept for evals and the cloud worker until parity is complete.
- Owner: Jacob
- Created: 2026-11-23
- Decided: 2026-11-23
- Closed: -
- Related: [PLAN-017](PLAN-017-harness-modernization-tracker.md) (seams and pipeline the current loop uses), [PLAN-014](PLAN-014-durable-event-log.md) (durable log precedent)

## Context

The current loop leaves completion, loop control and steering to the model. Observed failures: lost track of pending work, looping, and returning to earlier steps. Public harness designs (Anthropic long-running harness and managed agents, Claude Code hooks, OpenAI Agents SDK, Temporal and LangGraph checkpoints) keep authoritative state outside the model and steer with deterministic rules. Those sources are vendor posts and open-source docs, not controlled comparisons, so every milestone is gated by tests and, later, by measured tokens per completed task.

## Proposal

The model proposes; the harness owns five parts:

1. Session log: append-only events. All other state is a pure projection.
2. State machine: `ModelCall → ToolBatch → StopCheck → Verify → Done | Paused | Failed`. Only the harness transitions.
3. Task ledger: a `done` transition needs a passing acceptance check; completed tasks are final and protected; a model-initiated finish with open tasks is refused.
4. Steering layer: ordered hook rules (M4).
5. Loop controller: repeat, no-progress and alternation detection with escalation (M5).

Build sequence M0–M10, each milestone gated by an acceptance test. The harness is tested against a scripted fake model that emits adversarial sequences.

## Decisions

- Engines: the Cline SDK and OpenAI-compatible transports become adapters behind one harness (M9).
- Rollout: behind a setting; the current loop stays default until the harness wins a side-by-side comparison on tokens per completed task.
- Tracking: this record and `TRACKER.md`, per `PROCESS.md`. The approved plan had proposed `docs/rewrite/features.json`; that would duplicate this repo's tracker, so it was not created.

## Work log

### M0 Contracts — done (2026-11-23)
- `src/harness/contracts.ts`: event bodies, task type, ports (model, tool, verifier), hook and loop-detector types, validators (`parseSessionEvent`, `parseTask`, `parseLoopDetectorConfig`). Tests: `test/harness/contracts.test.ts`.

### M1 Log and projections — done (2026-11-23)
- `src/harness/eventLog.ts`: `MemoryEventLog` and `FileEventLog` (JSONL, validated and sequence-checked on open).
- `src/harness/projections.ts`: pure `reduce` and `project`. Tests: `test/harness/projections.test.ts`, `test/harness/eventLog.test.ts`.

### M2 State-machine loop — done (2026-11-23)
- `src/harness/loop.ts`: explicit phases, turn and input-token budgets, pause and resume, refusal limit, failing tools return results (not failed runs), model port errors fail the run. The live projection equals a replay of the log (tested).

### M3 Task ledger — done (2026-11-23)
- `src/harness/taskLedger.ts`: dependency gating, `done` needs a passing verifier result, completed tasks final and protected, dependents block removal. Built-in tools `task_create`, `task_update`, `task_remove`. Tests: `test/harness/taskLedger.test.ts`, `test/harness/loop.test.ts`.

### M3 extension: steps and grounded completion — done (2026-11-23)
- Tasks carry ordered steps. A step can be `done` only with `callIds` of tool calls that finished ok. A task is `done` only when all steps are done and its acceptance check passed. Acceptance is `{kind: "command"}`; `reviewer` is parsed but rejected until enabled.

### M4 Steering hooks — done (2026-11-23)
- `src/harness/steering.ts`: registry with ordered rules at beforeModel, beforeTool, afterTool, onStop, onError. Precedence deny > ask > allow; notes kept as durable `steer.note` events; a throwing rule fails the step with its id.
- Built-in rules: `finish.open-work` (onStop), `step.grounding` (beforeTool). Tests: `test/harness/steering.test.ts`, `test/harness/loop.test.ts`.
- Not done: the budget-reminder rule. The existing one-shot `budget.warning` event already covers "send only when state changes".

### M5 Loop controller — done (2026-11-23)
- `src/harness/loopControl.ts`: repeat, stuck (same result), and A-B-A-B detection over projected history. Escalation by strikes: warn → block → strip tools (next model turn) → pause with reason naming the detector. Progress clears strikes. Canonical fingerprints in `src/harness/canonical.ts`.
- Tests in `test/harness/loop.test.ts`.

### Wiring
- The composer engine chip has three engines: Cline, OpenAI, and Harness. Harness is per run and local only. Existing engines are unchanged. The cloud worker is not touched.
- `scripts/check-boundaries.mjs`: `src/harness` added to the vscode-free directories.

### Verification
- `npm run check`: typecheck, lint (two pre-existing warnings only), 410 tests, boundary check, build.
- `cd backend && npx tsc --noEmit`: green.

### M6 Context projection — partial (2026-11-23)
- `src/harness/context.ts`: stable prefix (system instructions and tool specs, hashed), stubs for older tool results over 2000 chars citing their seq, task-board snapshot appended last. `log_slice` tool recovers any stubbed result from the log. Tests: `test/harness/context.test.ts`.

### M7 Durability — partial (2026-11-23)
- `HarnessLoop.recover()`: rebuilds state from the log; a model-requested call with no recorded result gets an explicit interrupted result; calls with recorded results are never re-run; a run left running is paused as `recovered`. Tests: `test/harness/recovery.test.ts`, including a truncated file log.

### M8 Verifier and subagents — partial (2026-11-23)
- `src/harness/verifier.ts`: command acceptance through an injected exec port; reviewer acceptance rejected. `src/harness/exec.ts` holds the shell implementation. `src/harness/subagent.ts`: sequential, depth 1, tool allowlist, summary capped at 2000 chars, evidence as seqs. Tests: `test/harness/verifier.test.ts`.

### M9 Adapters and wiring — partial, local runs only (2026-11-23)
- `src/harness/adapters/openai.ts` (Responses and chat, reusing `src/agent/openaiWire.ts`) and `src/harness/adapters/cline.ts` (`createHandler` single-turn stream; `azure` maps to `openai-compatible`). `src/harness/toolPort.ts` keeps the permission check and approval path. `src/harness/runner.ts` maps harness events to the existing run view. `sessionController.startRun` runs a task on the harness when the flag is on. Tests: `test/harness/adapters.test.ts`, `test/harness/runner.test.ts`.
- Stop works for harness runs: the composer Stop aborts the loop, cancels the in-flight model request through the adapters, and pauses the run as `stopped`. A new message continues it from the log.
- Not done: the webview does not render steps as a task board yet (steps appear as info lines).

### M10 Scripted scenario suite — partial (2026-11-23); real-model comparison not run
- `test/harness/scenarios.test.ts`: loops, premature finish, ungrounded or failed-evidence steps, malformed input, unknown tools, input budget, replay equals live projection, failing acceptance command.
- Not done: the eval harness has no harness engine yet; the side-by-side token comparison on real providers needs the user's credentials and has not been run.

### Not done
- Webview task board for steps; eval-harness engine and real-model token comparison (M10, needs credentials); subagent spawn tool not exposed to the model; context compaction for old user and assistant turns (M6 only stubs tool results); idempotency keys beyond the callId check (M7).

## Known gaps (not done)

- M6: only tool results are stubbed. User and assistant turns are never compacted, so long sessions still grow. No per-model reset strategy.
- M7: idempotency is the callId check only. Recovery is tested by truncating a file, not by killing a real process.
- M8: the subagent module exists, but no spawn tool is exposed to the model, so it can't be reached from a run.
- M9: not run against a live provider. No Anthropic cache markers. Cache-write tokens aren't recorded. The webview has no task board. Memory context and run digests are not injected on the harness path.
- Stop granularity: `stop()` aborts the model request and gates un-dispatched calls, but in-flight tool calls run to completion — the abort signal never reaches `toolPort.execute`. Thread it through so cancellable tools kill their work: `run_command`/shell exec kills the child process, `browser_use` aborts the driver, MCP calls cancel their request. File writes stay atomic (no meaningful cancellation).
- M10: no harness engine in the eval harness, so no side-by-side comparison has been run. Eval metrics are not populated for harness runs.

## Decision and reason

The Harness engine is opt-in per run from the composer. Keep choosing Cline or OpenAI for a provider until the real-model comparison shows lower tokens per completed task, or equal with fewer looping turns.

### Checkpoint: transport chip and harness-only IDE runs (steps 1–2 of the approved plan)
- Composer control now offers Cline SDK and OpenAI only. Each run picks its transport; the choice persists per session. Anthropic on the OpenAI transport is refused with a message (`src/harness/transport.ts`, tests in `test/harness/transport.test.ts`).
- Every IDE run goes through `runOnHarness`. Continue resumes a paused harness run from its log (`runHarness` with `resume`).
- Not done (steps 3–9): harness system prompt parity, per-run context block, tool parity (plan, memory, skills, recall, explore, MCP, mode and permission guards, parallel batches), event and side-effect parity (file-changed, usage rows, checks, nudge, images, transcripts, digests), recap compaction, compact and clear controls, webview task board, parity suite and manual runs.
- Known gap: `OpenAIEngine` and `AgentRunner` are no longer called from the IDE path but are not yet deleted.

### Checkpoint update: step 3 (system prompt parity) done
- The IDE harness run uses `buildSystemPrompt` (same builder as the Cline loop). The system prompt is identical across runs; per-run memory and dev context go into the start of that run's user message (`HarnessLoop.run(text, context)`). Tests: `test/harness/prompt.test.ts`.
- Remaining: steps 4–9 (tool parity, event and side-effect parity, recap compaction, controls, webview task board, parity suite and manual runs). `AgentRunner` and `OpenAIEngine` are still present and still referenced by the non-IDE code paths and by the engine seam type; deletion waits until parity is complete.

### Checkpoint update: step 4 (tool parity) partly done
- IDE harness runs take their tool list from `assembleToolSet` (same as the Cline loop), so mode hiding, the write-mode guard and the permission pipeline apply to harness runs. The permission check maps the pipeline verdict to allow, ask or deny for the harness tool port.
- Not verified by tests yet: a denied write never runs on the harness path; parallel read batches on the harness path; ask-mode write refusal through the real pipeline.
- Remaining in step 4: explore as a subagent tool on the harness path, recall_context backed by prior transcripts, and the per-call `use_tool` path check.
- Steps 5–9 not started.

### Checkpoint: steps 1–4 (partly) of the approved plan
- Done: transport chip per run (Cline SDK or OpenAI), every IDE run on the harness, Continue resumes from the log, system prompt parity, per-run context in the first user message, tool list and permission pipeline from `assembleToolSet`, parallel read batches with writes as ordered boundaries, and a refused result for a tool the port does not offer. Tests: `test/harness/transport.test.ts`, `prompt.test.ts`, `batch.test.ts`.
- Step 4 still open: explore as a subagent tool on the harness path, recall_context backed by prior transcripts, and the use_tool dispatcher path.
- Not started: step 5 (file-changed and diff review, usage rows tagged by transport, checks on finish, zero-tool nudge, images, transcripts, digests), step 6 (recap compaction), step 7 (compact and clear controls), step 8 (webview task board), step 9 (parity suite and manual runs on both transports).
- Still present, not deleted: `AgentRunner` and `OpenAIEngine` remain in the code for the cloud worker and for the engine seam type.

### Checkpoint: steps 4–8 of the approved plan
- Step 4: `explore_codebase` as a read-only harness subagent (`src/harness/explore.ts`); `recall_context` over the session log (`src/harness/recall.ts`); `use_tool` reaches the harness through the shared tool set (not separately tested).
- Step 5: image attachments on `user.input` for both transports; zero-tool nudge in write modes (`nudgeWrites`); usage rows tagged `harness:<transport>`; run digests carried into the next run's per-run context; `file-changed`, checks on finish and commit-on-finish use the existing controller paths via `run-finished` (not separately tested end to end).
- Step 6: recap per compaction chunk, stored as `context.recap` with usage counted; a failed recap leaves stubs (`src/harness/recap.ts`, `test/harness/recap.test.ts`).
- Step 7: compact now (`HarnessLoop.requestCompact`) and clear context (`context.cleared` event, applied on replay). Stop and Continue from earlier steps.
- Step 8: task board from `task-board` events, rendered in `media/webview.js` (`boardOf`).
- Step 9: not done. Needs the parity suite against a fake transport and manual runs on both transports in the Extension Development Host.
- `AgentRunner` and `OpenAIEngine` still exist for the cloud worker and the engine type.
- Step 9 (partly): parity suite through the IDE path with a fake transport (`test/harness/parity.test.ts`): view events for a read task, task-board snapshots through a step, and a refused write that does not stop the run. Manual runs in the Extension Development Host on both transports are still needed, and so is the real-model comparison.


### Checkpoint: harness-owned board and context budget (the observed-inefficiency pass)
- Motivation: serial one-at-a-time file reads, context filling fast, and too many model calls on real runs — the model was driving the checklist.
- Context projection: `buildContext` no longer stubs tool results all-or-nothing. Every result outside the recent window becomes a head digest (~600 chars) plus a `[seq N]` pointer retrievable via `log_slice`; a hard ~120k-char budget is enforced by degrading oldest results further (`src/harness/context.ts`). Auto-recap on a timer is gone — recap now runs only on explicit `requestCompact` (manual Compact) (`src/harness/loop.ts`, `test/harness/recap.test.ts`).
- Harness-owned checklist: a planner pass at run start (one model call, no tools) emits `task.created` / `step.added` events; ids are remapped into the session id space and planner token usage rides on the first `task.created` (`src/harness/planner.ts`, `src/harness/loop.ts`). Task tools are no longer offered to the model. During the run the harness completes steps when a matching tool call finishes — `Step.signal` glob-matches tool name and path, and `read_files` batches satisfy `read_file` signals — citing the real callId as evidence (`src/harness/taskLedger.ts`, `src/harness/contracts.ts`). At finish the harness closes the board itself: open unsignaled steps are covered by acceptance, `acceptance: none` auto-verifies, and reviewer acceptance is rejected by the planner (`src/harness/planner.ts`). `task_create` still exists for the ledger API and can carry step signals.
- `read_files` batch tool: `withBatchReads` decorates the tool port, max 8 files, ~4 concurrent, offered only when `read_file` is (`src/harness/batchReads.ts`, wired in `src/ui/sessionController.ts`).
- Steering: a `reads.batch` rule nudges the model toward `read_files` after repeated single-read turns (`src/harness/steering.ts`).
- Usage accounting: `tool.finished` can carry nested `usage` (subagent/planner spend); counters fold it in (`src/harness/projections.ts`, `src/harness/subagent.ts`, `src/harness/explore.ts`, `src/harness/runner.ts`).
- System prompt: a constant `HARNESS_ADDENDUM` is appended in `runOnHarness` describing the batch read and log-recall affordances (`src/ui/sessionController.ts`).
- Tests: `test/harness/board.test.ts` (planner parse/fallback, board lifecycle, id remapping, signal matching, batch-read signal satisfaction, reads.batch nudge, usage accounting), `test/harness/batchReads.test.ts`; legacy harness tests rewritten to harness-owned semantics. `npm run check` green (541 tests).
- Not done: webview task board still renders steps as info lines (unchanged); no eval-harness engine; real-model comparison still pending.

### Checkpoint: harness activity report UI (IDE panel + dashboard)
- `src/harness/report.ts`: `buildHarnessReport(events, {runId?})` — pure reducer over the session log producing a bounded report: plan & board (ledger snapshot at the selected run's end — the board is cumulative across a session's runs), harness interventions (steer notes, loop verdicts, refusals, verifier results, recaps/clears, budget warnings; routine task status flips filtered out; capped at 200 with an omitted count), context & budget (counters plus input-token attribution by source: model / planner / tools-subagents / recap), execution stats (per-tool calls/failures, signal-proven vs acceptance-covered steps, read_file/read_files/explore counts). Tests: `test/harness/report.test.ts`.
- IDE: `kronyx.harnessReport` command opens a dedicated webview panel (`src/ui/harnessPage.ts` + `media/harness.js`/`harness.css`, usagePage pattern). Lists `.kronyx/harness/*.jsonl` session logs, run picker scopes the report server-side (board snapshot per run), refresh, and an Upload button that pushes a run's report to the dashboard — the way historical runs reach the web.
- Upload: same pattern as all other telemetry — the report is queued into a local `harness_reports` SQLite table (`upsertHarnessReport`, one row per root+runId) and the `UsageSync` worker flushes it to `/api/ingest` in batches (`harnessReports` array → upsert into mongo `harness_reports` by {uid, runId}). Offline-safe, retried like everything else; no size cap since it bypasses `capEventForWire`. `GET /api/runs/:id` returns `harnessReport`. The extension queues the report after every `runOnHarness` (`sessionController.queueHarnessReport`) and on demand from the IDE panel's Queue button.
- Web: `web/app/(app)/runs/[id]/HarnessReport.tsx` renders the four sections on the run detail page when a report exists; non-harness runs hide it.
- `npm run check` green (545 tests); backend and web `tsc --noEmit` clean. Not done: manual IDE/dashboard verification; the chat webview still shows only the flat task-board lines.

### Checkpoint: always-plan + wandering detector (post-report fixes)
- Motivation: a real session ran 68 turns / 1.28M input tokens of serial file reads with no board — plan/ask mode and conversational gating meant no planner ran, `reads.batch` was advisory-only, and nothing measured progress.
- Always plan: `runOnHarness` now passes `plan: !isConversationalTask(task)` in every mode — in plan/ask mode the board IS the deliverable; step signals for tools the mode hides are stripped in `planBoard` so they can't deadlock close-out (`src/ui/sessionController.ts`, `src/harness/loop.ts`).
- `reads.wander` steering rule (`src/harness/steering.ts`): counts consecutive turns whose tool calls are all read-only (`READ_ONLY_TOOL_NAMES` — reads, searches, explore_codebase, log_slice). Strong note at 10 turns, deny (pauses the run) at 16, with hysteresis — after a deny the streak must grow 4 more before denying again so a resumed run gets turns to change course. `recentTurns` window widened 6 → 24 to feed it.
- Report: `ReportRun.tasksCreated` (0 = ran without a board), `execution.exploreTurns` and `execution.maxReadOnlyStreak` so wandering is visible at a glance; surfaced in the IDE panel run picker/stat row and `HarnessReport.tsx`.
- Tests: `reads.wander` escalation/hysteresis/streak-breaking in `test/harness/steering.test.ts`; streak tracking in `test/harness/report.test.ts`. `npm run check` green (550 tests); web `tsc` clean.

### Checkpoint: harness report panel → live tracking
- `FileEventLog.sync()` (`src/harness/eventLog.ts`): incremental tail-read — tracks a byte offset, parses only appended complete lines, validates seq continuity, waits out torn tails, reloads on shrink. `append()` now advances the offset so self-written lines aren't re-read.
- `src/ui/harnessPage.ts`: caches one `FileEventLog` per session file (`logFor`), `sync()`s before each `buildHarnessReport` — polls are cheap (only new lines parsed).
- `media/harness.js`/`.css`: webview polls every 2.5s while a session is selected, auto-selects the newest session on open, shows a pulsing `● live` badge while any run's status is `running`, highlights the latest intervention, and all tiles/board/steps tick live. Queue ↗ unchanged (manual backfill; post-run auto-queue still handles finals).
- Dashboard stays post-run batch sync; chat webview unchanged (no debug flag — live tracking lives in the report panel).
- Tests: `test/harness/eventLog.test.ts` sync cases (incremental pickup, idempotent, torn tail, out-of-order rejection). `npm run check` green (553 tests).

### Checkpoint: harness debug flag in chat
- `kronyx.harness.debug` setting (package.json, default false) → `runOnHarness` passes `debug` into `runHarness` deps → `toViewEvents(e, st, limit, debug)`.
- Debug-on extras in `src/harness/runner.ts`: steer notes prefixed with the rule id (`[reads.wander] …`), a per-turn line (`turn N — X in / Y out · K calls`), and previously-invisible `context.recap`/`context.cleared` events. All carry `meta.kind: "harness"` (steer notes carry it always, with `rule`).
- `media/webview.js`/`.css`: harness-meta info lines get a `.harness` class (blue left border) so decision lines are visually distinct; normal runs unchanged.
- Tests: debug gating in `test/harness/runner.test.ts`. `npm run check` green (556 tests).
