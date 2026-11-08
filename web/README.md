# kronyx-web

Companion web app for the Kronyx VS Code extension: account sign-in, the
Vercel-style AI usage dashboard, and the ingest API the extension syncs to.

## Setup

1. `cp .env.local.example .env.local` and fill in:
   - `NEXT_PUBLIC_FIREBASE_*` — Firebase project web config (enable **GitHub** as a sign-in provider in the Firebase console)
   - `MONGODB_URI` — MongoDB connection string
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — service account JSON for Admin SDK token verification
2. `npm install`
3. `npm run dev` → http://localhost:3000

## API

- `POST /api/ingest` — extension burst upload. `Authorization: Bearer <firebase-id-token>`, body `{ calls: [...] }`. Rows are stored in `usage_events` scoped by `uid` and deduped on `(uid, clientRowId)` so retries are idempotent.
- `GET /api/usage?since=&until=&model=&status=&limit=` — caller's usage rows for the dashboard.

## Extension wiring

In the extension set:

- `kronyx.sync.endpoint` = this app's base URL (e.g. `http://localhost:3000` in dev)
- `kronyx.sync.enabled` = true

Then `Kronyx: Sign in (GitHub)` — it opens `/connect`, which mints a `krx_…`
API key and deep-links back via `vscode://kronyx.kronyx/auth?key=…` (or paste
the key manually). Revoke keys any time on the dashboard.
