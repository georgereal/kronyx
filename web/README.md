# kronyx-web

Web dashboard for Kronyx — sessions, cloud-run timelines, usage/cost charts, GitHub access, and synced settings (providers, secrets, global permission rules).

**UI only.** There are no `app/api/` routes and no server-side secrets here: `next.config.ts` rewrites `/api/*` to the backend (`BACKEND_URL`, default `http://localhost:4000`). All API endpoints — sessions, runs, usage, ingest, settings, github — live in [`backend/`](../backend/README.md).

## Setup

1. `cp .env.local.example .env.local` and fill in:
   - `NEXT_PUBLIC_FIREBASE_*` — Firebase project web config (enable **GitHub** as a sign-in provider in the Firebase console)
   - `NEXT_PUBLIC_GITHUB_APP_SLUG` — the GitHub App's slug (for the install link on the settings page)
   - `BACKEND_URL` — backend base URL (default `http://localhost:4000`)
2. `npm install`
3. `npm run dev` → http://localhost:3000

MongoDB, `FIREBASE_SERVICE_ACCOUNT_JSON`, and `GITHUB_APP_*` are **backend** env vars — see `backend/README.md`.

## Extension wiring

In the extension set:

- `kronyx.sync.endpoint` = this app's base URL (e.g. `http://localhost:3000` in dev)
- `kronyx.sync.enabled` = true

Then `Kronyx: Sign in (GitHub)` — it opens `/connect`, which mints a `krx_…`
API key and deep-links back via `vscode://kronyx.kronyx/auth?key=…` (or paste
the key manually). Revoke keys any time on the dashboard.
