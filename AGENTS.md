# Kronyx

VS Code extension (root `src/`) + Next.js web dashboard (`web/`) + standalone backend service (`backend/`).

## Topology

- `web/` — **UI only** (Next.js, Firebase client auth). `next.config.ts` rewrites `/api/*` → `BACKEND_URL` (default `http://localhost:4000`). No `app/api/` routes, no server-side secrets.
- `backend/` — **all backend operations**: REST API (`src/handlers/*`, plain `Request`/`Response` handlers over a `node:http` adapter in `src/index.ts`), shared lib (`src/lib`: mongo, apiKeys, firebaseAdmin, githubApp, models), and the agent worker (`src/worker`, second process polling `cloud_jobs`).
- `src/` — vscode extension. `src/agent`, `src/tools`, `src/sandbox`, `src/diff` are **vscode-free** — the backend worker bundles them via `backend/esbuild.mjs`. Never add `import "vscode"` to those files (`scripts/check-boundaries.mjs` enforces this in `npm run check`); extension glue passes deps through `RunnerHost` seam fields (`tools`, `approvals`, `memory`, `recall`, `transcripts`, `files` — see `src/agent/seams.ts`).

## Agent seams & tool pipeline (Stage A, PLAN-017)

Tool-call policy runs through `src/agent/pipeline.ts`: ordered `pre` waterfalls (allow/ask/deny; returning without `next()` short-circuits), `around` wrappers (execute-decorator), `post` result rewriting. Production order: `repeatGuard → savePlanGuard → permissionGuard → writeModeGuard → approvalGuard` (`src/agent/guards/`). New policy = a new registered guard, not a `beforeTool` edit. Hosts supply capability providers via `RunnerHost` seam fields instead of callback bags.

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
