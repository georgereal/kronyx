# Kronyx

VS Code extension (root `src/`) + Next.js web dashboard (`web/`) + standalone backend service (`backend/`).

## Topology

- `web/` — **UI only** (Next.js, Firebase client auth). `next.config.ts` rewrites `/api/*` → `BACKEND_URL` (default `http://localhost:4000`). No `app/api/` routes, no server-side secrets.
- `backend/` — **all backend operations**: REST API (`src/handlers/*`, plain `Request`/`Response` handlers over a `node:http` adapter in `src/index.ts`), shared lib (`src/lib`: mongo, apiKeys, firebaseAdmin, githubApp, models), and the agent worker (`src/worker`, second process polling `cloud_jobs`).
- `src/` — vscode extension. `src/agent`, `src/tools`, `src/sandbox`, `src/diff` are **vscode-free** — the backend worker bundles them via `backend/esbuild.mjs`. Never add `import "vscode"` to those files (`scripts/check-boundaries.mjs` enforces this in `npm run check`); extension glue passes deps through `RunnerHost` seam fields (`tools`, `approvals`, `memory`, `recall`, `transcripts`, `files` — see `src/agent/seams.ts`).

## Agent seams & tool pipeline (Stage A, PLAN-017)

Tool-call policy runs through `src/agent/pipeline.ts`: ordered `pre` waterfalls (allow/ask/deny; returning without `next()` short-circuits), `around` wrappers (execute-decorator), `post` result rewriting. Production order: `repeatGuard → savePlanGuard → permissionGuard → writeModeGuard → approvalGuard` (`src/agent/guards/`). New policy = a new registered guard, not a `beforeTool` edit. Hosts supply capability providers via `RunnerHost` seam fields instead of callback bags.

Tool classification: MCP tools are writes unless the server sets `readOnlyHint` (`isReadOnlyMcpTool`); ask/plan hide them. `READ_ONLY_DENY` (`guards/modeGuard.ts`) holds side-effecting non-file tools refused in ask/plan. Every model-facing tool result passes `redactForModel` (`src/tools/redact.ts`) in `toolSet.ts`, using `RunnerHost.secretValues` plus credential shapes. Secret-looking and gitignored files (not vendored dirs or `.kronyx/`) return a metadata stub from read/search (`isSensitivePath` in `tools/workspace.ts`). Host-side web access (`fetch_url`, local browser) goes through `src/tools/network.ts`: private/loopback/link-local destinations are refused at connect time unless listed in `kronyx.network.allowHosts`.

## Execution engines (IDE)

The IDE always runs the harness loop (`src/harness/core/loop.ts`, started from `sessionController.runOnHarness`). The harness has three layers:

- **Kernel** (`src/harness/core/`): `contracts/` (single event/task schema + ports + validators), `projections.ts`, `taskLedger.ts`, `eventLog.ts`, `loop.ts` (the state machine — phases, gating order, recovery, ledger invariants; all policy comes through `deps.behavior`), `runner.ts`, `behavior.ts` (`HarnessBehavior` + `defaultBehavior`), `policies/` (the narrow seams: `ContextPolicy`, `RecapPolicy`, `PlanningPolicy`, `LoopControlPolicy`, `SteeringPolicy`, `RecallProvider`, `RequestStrategy`). Only the kernel emits durable events — policies return normalized proposals/verdicts.
- **Defaults** (`src/harness/defaults/`): today's shared behavior, one implementation per policy (context/recap/planning/loopControl/steering/strategy/verifier). A `RequestStrategy` is the request lifecycle: `StatelessStrategy` (full projection) vs a port's own `model.strategy`.
- **Adapters** (`src/harness/adapters/`): self-contained transport slices — `cline/` (Cline SDK) and `openai/{responses,chat,conversations}/` each own their conversion/body/stream code. `adapters/index.ts` `createModelAdapter(transport, config)` picks the family; `openai/index.ts` `openaiAdapter` picks the API shape. Duplication between slices is deliberate — only `src/agent/openaiWire.ts` low-level HTTP/SSE is shared.
- **Behaviors** (`src/harness/behaviors/`): `resolveBehaviorProfile(descriptor)` merges `defaultBehavior()` under a registered profile's `Partial<HarnessBehavior>` overrides, selected on providerId/modelId/contextWindow/capabilities — never transport kind. Add a provider-specific behavior by registering a `BehaviorProfile`, not by editing defaults or the kernel.

The composer's transport chip picks only the wire (`cline` → `ClineModelPort`, `openai` → `openaiAdapter`); `sessionController` then resolves the behavior profile independently. The choice persists per session. The kernel owns policy invariants, the task ledger and the durable log; the adapter owns the HTTP call.

OpenAI transport request shapes (the `RequestStrategy` seam: `defaults/strategy.ts` vs `adapters/openai/conversations/strategy.ts`). `protocolFor(providerId, modelId)` decides the API shape: `openai` and `vercel-ai-gateway` (which proxies the Responses API) → Responses, everything else → chat completions. Explicit `conversations`/`responses` chips fail loudly when the provider+model can't serve them; only the `openai` (auto) chip picks a shape.
- **Conversations** (direct `api.openai.com`, `providerId: openai`, Responses, `kronyx.openai.store` and `kronyx.openai.conversations` on): the run's history lives in a server-side Conversation. The loop logs `conversation.bound`, then per request `conversation.sent` (before the call) and `conversation.synced` (after the response is logged). Each request carries only the delta: events after the last synced one, plus the task board when it changed. Server compaction (`context_management` at 70% of the context window) replaces the local recap and digests. A new conversation binds from the projected context, so long sessions start within the window.
- Conversation resets (`conversation.reset`, reason logged): model changed, a request left in flight (crash or abort), a failed call, or the server returning 404. The next request binds a new conversation and replays from the log. Clear context drops the conversation with the messages.
- **Stateless** (Vercel AI Gateway, other providers, chat completions, or store off): the full projection from `buildContext` on every request. Assistant turns from the same provider+model replay their stored output items verbatim (`toResponsesItems` — reasoning, message, call and provider-specific items keep their ids/order; call items the harness can never answer, like `custom_tool_call`, are dropped). Cross-model/provider turns are rebuilt from the projection, so compaction and digests still apply.

Call ids: every `tool.finished` answers its `model.response` call. `assertPaired` refuses to send a request with an unanswered call; resume's `recover()` closes any left open with an interrupted result. CallIds are harness-internal — they never appear in model-facing tool schemas. Step evidence is owned by `EvidencePolicy` (`core/policies/evidence.ts`, default in `defaults/evidence.ts`): on `status: done` the loop attaches the successful external calls since the task's `startedSeq` (opened on `task.updated → in_progress` or the first `step.updated`, whichever lands). The `step.grounding` rule denies a `done` step only when the window is empty.

Shared wire conversion, SSE and the Responses/chat request bodies live in `src/agent/openaiWire.ts` (also used by `OpenAIEngine`). `OpenAIEngine` (`src/agent/openaiEngine.ts`) and `AgentRunner` (`src/agent/runner.ts`) remain for `src/evals.ts` and the cloud worker; they are not on the IDE run path. Shared tool assembly (pipeline, mode-filtered tools, parallel policy, concurrency gate, system prompt) lives in `src/agent/toolSet.ts` — change tool policy there.

## Dev commands

```bash
# dev: API + worker in one process (or two processes for prod-like isolation)
cd backend && npm run build && BACKEND_RUN_WORKER=1 npm start   # API :4000 + embedded worker
# split mode: npm run dev (API only) + npm run worker (separate worker; worker:dev = esbuild watch)
cd web && npm run dev                              # UI on :3000, /api proxied to backend

cd backend && npm run worker:dev                   # rebuild + in another shell: node dist/worker.js
# NOTE: rebuilding dist/worker.js does NOT restart a running worker — restart the process for bundle changes to take effect
npm run build && npx tsc --noEmit                  # extension bundle + typecheck (root)
cd web && npx tsc --noEmit && npm run build        # web typecheck + build
cd backend && npx tsc --noEmit                     # backend typecheck
```

Env: backend reads `backend/.env` (copy of `web/.env.local` — MONGODB_URI, FIREBASE_SERVICE_ACCOUNT_JSON, GITHUB_APP_*).

## Cloud agent data flow

`POST /api/sessions` → `POST /api/sessions/:id/messages` enqueues `cloud_jobs` → worker claims → E2B sandbox (clone, attachments, branch `kronyx/<slug>-<id>` at first agent run, drift rebase, checkpoint push, `openPr`, then optional verify) → `run_events` → UI polls (3s) or SSE `?stream=1&token=<idToken>`. Sandboxes are ephemeral — VM death mid-run latches `live.dead` through `delegatingHandle` (`src/sandbox/errors.ts` `isSandboxDeath`), stops the run, recreates + reclones + resumes once; the tail does the same for post-run deaths. "completed" is the `run-completed` event at job end (run-finished is only the agent's summary).

Integrations (PLAN-017 Stage C): MCP servers from `settings.mcpServers` / `~/.kronyx/config.json` connect on the host via `src/tools/mcpTools.ts` → tools register as `mcp_<server>_<tool>` (permission rules: `mcp_<server>` is the tool name, subtool is the glob target — `mcp_*`, `mcp_github(create_*)`). Repo skills: `.kronyx/skills/<name>/SKILL.md` → prompt index + `load_skill` via `use_tool`. Webhooks: `POST /api/webhooks/:ruleId` (HMAC rules bound to sessions) and `POST /api/webhooks/github` (`X-Hub-Signature-256` vs `GITHUB_APP_WEBHOOK_SECRET`; `kronyx` label / `@kronyx` mention → agent run on the repo's newest session; dedupes on delivery id).

Modes: `ask` = no sandbox (chat only); `plan` = read-only sandbox + `save_plan` → `plans` collection (UI card: Implement / Push to branch); `agent` = full writes → PR. Attachments: ≤20KB text inlined, all files land in `.kronyx/attachments/` (excluded from commits, along with `.kronyx/shots/` browser screenshots).

Browser/GUI: agent mode adds a `browser_use` tool (`src/tools/browserTools.ts` — browser-use + Playwright inside the sandbox, LLM creds via a 0600 env file). Post-run verify screenshots the booted app into `runs.screenshot` + a `ui-screenshot` event. Both need the custom E2B template in `backend/e2b-template/` (Chromium, browser-use, Qt libs like libgl1/xvfb for PyQt5); set it via the Composer template field. Stock template: tool reports "not installed", screenshot step skips. Qt tests: `QT_QPA_PLATFORM=offscreen`.

Templates: the worker lists the account's usable E2B templates (`listTemplates` → public fleet + `e2b template build` customs) and the model picks one at cold start (`backend/src/worker/pickTemplate.ts`); priority = Composer field > LLM pick > `e2bTemplate` settings default > `base`. `switch_environment` (agent tool, `src/tools/envTools.ts`) swaps VM images mid-run — interim commit+push → recreate → reclone branch → continue (≤2/run); disabled via Settings → `sandboxAutoSwitch`.

## Git workflow

- Leave code changes uncommitted in the working tree — do NOT commit, create branches, or open PRs unless explicitly asked.
