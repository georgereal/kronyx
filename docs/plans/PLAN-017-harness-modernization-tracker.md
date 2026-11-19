# PLAN-017: Harness modernization — spec and execution tracker

- Status: In progress (A, B incl. B2, C shipped; Stage D gated)
- Owner: Jacob
- Created: 2026-11-18
- Decided: 2026-11-18
- Closed: -
- Related: [PLAN-012](PLAN-012-plugin-architecture.md) (rationale),
  PLAN-013 / PLAN-014 / PLAN-015 / PLAN-016 (background design docs)

## Context

Adopting the seam/pipeline/event-log patterns studied against
deepseek-harness (Cordis, everything-is-a-plugin) and the GrowMagik
platform-SDK writeup (vendor adapters, "edges are where checks sit",
AI assembles known blocks). **Approach: thin seam layer around
`@cline/agents` `Agent` — no Cordis.** Locked decisions: extend `run_events`
for the durable log (not a new collection); vitest added to `backend/` for
handler tests. Hook surface verified: `beforeTool`/`afterTool`/`beforeModel`/
`afterModel` exist — pipeline maps 1:1; `around` = execute-decorator at tool
registration.

**Gate for every stage:** `npm run check` (typecheck + lint + vitest +
boundary check + build) and `cd backend && npx tsc --noEmit` green.

## Stage A — Seams + tool-pipeline guards — ✅ DONE (2026-11-18)

Shipped:

- `src/agent/pipeline.ts` — `PreVerdict` waterfall middleware
  (`preTool`/`aroundTool`/`postTool`; returning without `next()` short-circuits;
  empty pre-chain defaults to `ask`). `test/pipeline.test.ts`.
- `src/agent/registry.ts` — register/resolve/required + disposers.
  `test/registry.test.ts`.
- `src/agent/seams.ts` — typed seam keys + provider interfaces:
  `ToolsProvider`, `ApprovalsProvider` (`check` + `confirm`), `MemoryProvider`
  (`context` + `onFact`), `RecallProvider` (`transcripts`/`scorer`/`enabled`),
  `TranscriptsProvider` (`save`), `FilesProvider` (`onBeforeWrite`/`execCommand`),
  `EventsProvider` (`record`), `ResumeProvider` (`resumeLog`).
- `src/agent/guards/` — `repeatGuard` (warn@3/stop@5, configurable
  include/exclude), `savePlanGuard` (plan-only, before rules),
  `permissionGuard` (allow/ask/deny rules), `writeModeGuard` (file_editor
  bypass + write gating, after rules), `approvalGuard` (confirm last).
  Pipeline order preserved from the old inline `beforeTool`:
  repeat → save_plan → permissions → write-mode → approval.
  `test/guards.test.ts`.
- `src/agent/runner.ts` — `RunnerHost` narrowed to identity/mode/emit/log +
  seam provider fields; `beforeTool` → `runPre`, `afterTool` → `runPost`,
  `around` wraps tool `execute` at registration.
- Call sites migrated: `src/ui/sessionController.ts`, `src/ui/cloudController.ts`,
  `backend/src/worker/executor.ts` (`ensureRunner` + slice runner), `src/evals.ts`.
- `scripts/check-boundaries.mjs` — fails if `src/{agent,tools,sandbox,diff}`
  imports `vscode`; wired into `npm run check`. **Caught 2 pre-existing
  violations:** `src/agent/memory.ts` → `src/ui/memory.ts`,
  `src/sandbox/e2b.ts` → `src/ui/e2b.ts` (vscode-facing code mislocated in
  vscode-free dirs; `backend/tsconfig.json` already excluded memory.ts).

Notes: permission `ask` rules resolve via the approval stage (previously fell
to mode defaults — same outcome for code-mode writes). Gate: 193+ tests,
both typechecks, boundary check clean.

## Stage B — Durable event log — ✅ core DONE, 1 deferral (2026-11-18)

Shipped:

- `src/agent/events.ts` — `KronyxEvent` union (superset of `RunViewEvent`):
  `agent-message` (canonical transcript message — "model-visible ⟺ logged"),
  `compaction`, `sandbox-recreated`, `resumed-from-log`. Plus
  `deriveMessages(events)` — pure fold deduping by message id.
  `test/deriveMessages.test.ts`.
- Runner records every `message-added`/`assistant-message` + compaction +
  seed/resume messages through the `events` seam.
- `events` providers: worker → `RunSink.emit` (same `run_events` collection,
  seq-numbered + secret-scrubbed; slice runs tagged `agentIndex`);
  extension → `persistEvent`.
- `resume` seam: `ensureRunner` cold-start loads this runId's `agent-message`
  records → `deriveMessages` → `initialMessages`. Covers worker restart /
  job re-claim mid-run.

**B2 — in-process mid-run VM death** — ✅ DONE (2026-11-19)

- `src/sandbox/errors.ts` — `SandboxDeadError` + shared `isSandboxDeath`
  (executor's regex moved here).
- `delegatingHandle` catches death signatures on every call: latches
  `live.dead`, sets `live.stopped` (in-flight calls fail fast), calls
  `live.onDead` → `runner.stop()`. Thrown errors still reach the agent as
  tool text — the latch is the side-channel, as designed.
- `agentTail` recovery loop: recreate → reclone → rebind `live.handle` →
  warm `runner.run(resume prompt)` once (in-memory transcript survives —
  `resumeLog`/`deriveMessages` still covers process-level restarts).
  `isAborted` also trips on `live.dead` so polling run_command exits.
  Slice runners fail fast through the same latch rather than poisoning
  fan-in.
- `test/sandboxDeath.test.ts` (5 tests).
- Note: tests live in root `test/` (root vitest) — there is no vitest
  inside `backend/`; handler tests go in root `test/` too.

## Stage C — Integrations (PLAN-015) — ✅ DONE (2026-11-19)

- **C1 MCP client support** — `src/tools/mcpTools.ts` on
  `@modelcontextprotocol/sdk@1.32.2`. Host stdio + remote URL servers; no
  in-E2B spawning (worker-side tools see the worker host, not the cloned
  repo — documented limitation). Config: `mcpServers` in
  `~/.kronyx/config.json` (extension) / `settings.data.mcpServers` (worker).
  Tools register as `mcp_<server>_<tool>`; `permissions.ts` canonicalizes
  MCP names (server = tool, subtool = glob target) and the rule tool part
  now accepts `*`/`?` globs (`mcp_*`, `mcp_github(create_*)`). `${ENV_VAR}`
  substitution → `RunSink.mask`. Failed servers contribute zero tools.
  Static toolset cache keyed by config. `test/mcpTools.test.ts` (real
  stdio fixture), `test/permissions.test.ts` MCP cases.
- **C2 Skills** — `src/agent/skills.ts`: `.kronyx/skills/<name>/SKILL.md`
  via `FilesProvider.listSkillFiles` (extension = workspace fs; worker =
  `live.handle` so it survives VM recreation) → frontmatter index into
  `buildSystemPrompt` (new `skillsIndex` param); `load_skill` deferred tool
  returns the body. `test/skills.test.ts`.
- **C3 Webhooks** — `backend/src/handlers/webhooks.ts` + pure helpers in
  `backend/src/lib/webhookLib.ts`. `webhook_rules` bind to a sessionId;
  `POST /api/webhooks/:ruleId` → `x-kronyx-signature` HMAC → filter →
  `{{dot.path}}` template → `enqueueSessionRun` (runs + cloud_jobs +
  run_events). Auth CRUD at `/api/webhook-rules` (secret shown once).
  GitHub: `POST /api/webhooks/github` verifies `X-Hub-Signature-256` vs
  `GITHUB_APP_WEBHOOK_SECRET`, dedupes `X-GitHub-Delivery`, `kronyx` label /
  `@kronyx` mention → agent run on the repo's newest session.
  `test/webhooks.test.ts`.
- **C4 Subagent seam** — `src/agent/subagents.ts`: `SubagentProvider`
  (`start/progress/result/cancel`) + `InProcessSubagent` + `SEAM_SUBAGENTS`;
  `explore_codebase` refactored behind it (same behavior). Executor fanout
  adoption remains under PLAN-011.

## Stage D — `kronyx.yml` composition (PLAN-016) — GATED

Loader in the vscode-free core; layers: built-in → `~/.kronyx` → repo →
repo-local → session overrides. Toggles seams/guards by id, guard thresholds,
tool visibility, MCP servers, webhook rules, named profiles. **Explicit
non-goals: no runtime plugin manager, no HMR.** Start only after Stage C
lands + YAML-vs-JSON decision recorded.

## Cross-cutting requirements

- `src/{agent,tools,sandbox,diff}` stay vscode-free — enforced by
  `scripts/check-boundaries.mjs` in `npm run check`.
- All persisted events pass through `RunSink.scrub` — no secrets in `run_events`.
- Plugin-declared permissions never widen repo/user rules.
- Update `AGENTS.md` per landed stage (done for Stage A).

## Decision and reason

Approved 2026-11-18: incremental seams around `@cline/agents`; extend
`run_events`; add backend vitest. Cordis adoption / homegrown DI container
deferred — see PLAN-012.

## Work log

- 2026-11-18: tracker created; **Stage A complete** (seams + guards + boundary
  check; 2 violations relocated); **Stage B core complete** (KronyxEvent →
  run_events, deriveMessages, resume seam; mid-run VM-death deferred).
- 2026-11-19: re-verified against the codebase — fixed stale paths
  (`settings.ts` lives under `backend/src/worker/`; no backend vitest —
  tests are root `test/`); promoted the VM-death deferral to **B2**
  (SandboxDeadError + death latch + runTail-style recreate/resume);
  expanded Stage C: C1 narrowed to MCP client support (host stdio + URL,
  no in-E2B spawn), C3 widened to include GitHub App events
  (`X-Hub-Signature-256`, label/@mention → cloud_jobs, delivery dedupe).
- 2026-11-19 (later): **B2 + all of Stage C landed.** Gate: `npm run check`
  green (218 tests) + backend typecheck. B2 implemented via `live.dead`
  latch in `delegatingHandle` (side-channel) + `agentTail` recreate/resume
  loop — warm re-run rather than cold `resumeLog` replay since the
  in-memory transcript survives in-process death. MCP v1 = client support
  only (host stdio + URL). GitHub webhook secret env: `GITHUB_APP_WEBHOOK_SECRET`.
