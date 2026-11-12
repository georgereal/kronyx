# Kronyx architecture overview

Status: living document — describes the system **as built**. The original C4 diagram ([kronyx-c4.png](kronyx-c4.png), [source](kronyx-c4.puml)) predates the cloud build; treat it as historical context. Interactive plan: [kronyx-plan.html](kronyx-plan.html).

## Shape

Three deployable components sharing one vscode-free agent core:

| Component | Where | Responsibility |
|---|---|---|
| `src/` | VS Code extension | Run-oriented UI (timeline, diff review, comments, permission cards), local agent runs, settings, checks, evals, account/sync |
| `web/` | Next.js dashboard | UI only — sessions, usage charts, settings, approvals. Proxies `/api/*` to the backend; no server-side secrets |
| `backend/` | Node service | REST API (`src/handlers` over a `node:http` adapter) + a worker process that claims `cloud_jobs` and executes runs in sandboxes |

The core — `src/agent` (runner, compaction, recall, permissions, tokenize, systemPrompt), `src/tools`, `src/sandbox/sandboxCore.ts`, `src/diff` — never imports `vscode`. The extension uses it directly; the backend bundles the same files via `backend/esbuild.mjs`, so local and cloud runs execute identical agent logic.

## Agent core

- **Loop**: Cline SDK `Agent` (`@cline/agents`, native function calling) wrapped by `src/agent/runner.ts`, which adds mode gating, permission evaluation, compaction triggers, usage accounting, and host hooks (`RunnerHost`).
- **Tools** (`src/tools`): file ops (`read_file`, `write_file`, `edit_file`, `insert_lines`, `append_file`, `list_files`, `search_files`), `run_command`, `browser_use` (browser-use + Playwright in-sandbox), `memory_write`, `save_plan`, `switch_environment`, `recall_context`. Mode-scoped — ask/plan never receive write tools.
- **Context engine** (`src/agent/compaction.ts`, `recall.ts`, `tokenize.ts`): real BPE token counting (`gpt-tokenizer`), multi-tier compaction — supersession pruning → tool-result stubbing → reasoning pruning → call-input elision → LLM summarization — plus `recall_context` for keyword or embedding-semantic retrieval of elided content.
- **Permissions** (`src/agent/permissions.ts`): `tool` / `tool(glob)` rules across global (`~/.kronyx/permissions.json`), repo (`.kronyx/permissions.json`), and local (`.kronyx/permissions.local.json`) layers. Global deny is a hard floor; most-local rule otherwise wins. Enforced in `runner.beforeTool` before mode checks, in every profile including bypass.

## Cloud data flow

```
POST /api/sessions → POST /api/sessions/:id/messages → cloud_jobs
  → worker claim → sandbox (clone, attachments, checkout startRef)
  → branch kronyx/<slug>-<id> → agent loop (status/usage → run_events)
  → drift rebase → verify → commit/push → openPr
```

- UI consumes `run_events` by polling (3s) or SSE (`?stream=1&token=`).
- Modes: `ask` = no sandbox; `plan` = read-only sandbox + `save_plan`; `agent` = full writes → PR.
- Sandboxes: E2B (default), Docker, Kubernetes, Vercel — selected per session; `switch_environment` swaps images mid-run.
- Permission requests in controlled profile surface as `run_events` resolved via `POST /api/runs/:id/permissions/:permId`.
- Settings (provider config, secrets, global permission rules) sync via `users/{uid}.settings` — doc-level last-writer-wins; cloud reads `settings.data.permissions` for the global layer.

## Caching and accounting

`usage_events` records per-request rows (tokens in/out, cache read/write, reasoning, cost, iteration, context size) powering the dashboard charts and the in-session ContextMeter. Server-side caches (`ContextCache`, Redis when `REDIS_URL` set): model catalog/pricing, GitHub installation tokens, template catalog, memory embeddings. Mongo `run_transcripts` are gzip-compressed.

## Roadmap docs

Feature plans and ADRs: [plans/](../plans/) and [decisions/](../decisions/), tracked in [TRACKER](../TRACKER.md). Several early docs describe aspirational designs (Firecracker, LanceDB, tree-sitter indexes) that were superseded by what shipped — the status column is authoritative.
