# kronyx-backend

Backend for Kronyx: REST API (sessions, runs, usage, settings, GitHub) plus the worker that executes cloud agent runs in sandboxes.

The API serves plain `Request`/`Response` handlers (`src/handlers/*`) over a `node:http` adapter (`src/index.ts`, routing in `src/routes.ts`). The web app proxies `/api/*` here; the extension talks to it directly for cloud sessions and settings sync.

## Two processes, one codebase

- **API** — `src/index.ts` (default port `4000`)
- **Worker** — `src/worker/` — polls `cloud_jobs`, clones repos into sandboxes (E2B default; Docker/Kubernetes/Vercel), runs the shared agent core, streams `run_events`, then commits/pushes/opens a PR. Bundles the extension's vscode-free `src/agent` + `src/tools` via `esbuild.mjs`.

## Dev

```sh
npm install && npm run build
BACKEND_RUN_WORKER=1 npm start     # API :4000 + embedded worker (dev-friendly)
# or production-like split:
npm run dev                      # API only (tsx watch)
npm run worker                   # separate worker process (worker:dev = esbuild watch)
```

## Environment

Copy `web/.env.local` → `.env` (the backend reads the same file), or export:

| Var | Purpose |
| --- | --- |
| `MONGODB_URI` | Primary store (sessions, jobs, run_events, usage_events, users) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Admin SDK service account (JSON string or path) — verifies caller tokens |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | GitHub App — clone/push/PR on installed repos |
| `NEXT_PUBLIC_GITHUB_APP_SLUG` | App slug for install redirects |
| `WEB_APP_URL` | Dashboard origin (redirects, links) |
| `REDIS_URL` | Optional — shared ContextCache (model catalog, installation tokens, embeddings). In-process when unset |
| `E2B_API_KEY` | Optional server-side fallback for sandbox creation |
| `CRON_SECRET` | Optional — gates the janitor/cron route |
| `BACKEND_PORT`, `BACKEND_RUN_WORKER`, `BACKEND_DEBUG` | Runtime knobs |

Idle/timeout tunables: `SESSION_IDLE_KILL_MINUTES`, `PAUSED_KILL_MINUTES`, `SANDBOX_IDLE_PAUSE_MINUTES`, `JANITOR_MAX_SANDBOX_MINUTES`.

## Browser/GUI sandboxes

`browser_use` and post-run verify screenshots need the custom E2B template in [`e2b-template/`](e2b-template/README.md) (Chromium + Playwright + Qt libs). On the stock template the tool reports "not installed" and screenshots skip.

## API surface (high level)

- `POST /api/sessions`, `POST /api/sessions/:id/messages` — enqueue work; `GET .../events?stream=1` for SSE
- `GET /api/github/repos|branches|prs`, `POST /api/github/link` — installation-scoped repo access
- `GET/PUT /api/settings` — synced user settings (provider config, secrets, global permission rules); `settings.data` is wholesale-replaced, `settings.secrets` merged
- `POST /api/ingest`, `GET /api/usage`, `GET /api/sessions/:id/usage` — token/cost accounting
- `POST /api/runs/:id/permissions/:permId` — resolve worker approval requests from the dashboard
