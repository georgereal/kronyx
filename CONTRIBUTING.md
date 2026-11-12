# Contributing to Kronyx

Thanks for your interest! Kronyx is a monorepo with three components:

| Folder | What |
| --- | --- |
| `src/` | VS Code extension — run UI, local agent runs, settings, sync |
| `backend/` | REST API + cloud-run worker (sandboxes, GitHub, PRs) |
| `web/` | Next.js dashboard (UI only — proxies `/api/*` to the backend) |

## Setup

Requires Node 22+.

```sh
npm install
npm run check          # typecheck + lint + unit tests + build (extension)
```

Press F5 in VS Code ("Run Kronyx extension") for an Extension Development Host.

For the cloud stack see `backend/README.md` and `web/README.md` — you'll need MongoDB, a Firebase project, and (for sandboxed runs) an E2B or Docker/k8s/Vercel backend.

## Verifying changes

```sh
npm run check                        # root: everything
cd backend && npx tsc --noEmit       # backend typecheck
cd web && npx tsc --noEmit           # web typecheck
```

Tests live in `test/` (Vitest). Add coverage for changes to `src/agent`, `src/tools`, or permission/compaction logic.

## Architecture rules that matter

- `src/agent`, `src/tools`, `src/sandbox/sandboxCore.ts`, `src/diff` are **vscode-free** — the backend worker bundles them via `backend/esbuild.mjs`. Never `import "vscode"` there; pass extension-specific deps through `RunnerHost`.
- `web/` is UI-only. Backend operations and secrets belong in `backend/`.
- `*.kronyx/permissions.local.json` and `.kronyx/attachments|shots` must never be committed or pushed — they're in `COMMIT_EXCLUDES`.
- More detail: [AGENTS.md](AGENTS.md) and [docs/architecture/overview.md](docs/architecture/overview.md).

## Planning

Non-trivial work gets a plan or ADR first — see [docs/PROCESS.md](docs/PROCESS.md) and the register in [docs/TRACKER.md](docs/TRACKER.md). Don't renumber or delete records.

## Pull requests

- Keep changes scoped; describe *why*, not just *what*.
- Run `npm run check` before opening.
- No secrets, tokens, or generated transcripts in commits.
