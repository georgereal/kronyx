# Data map — where to look when debugging

Two stores: a local **SQLite** file (IDE runs) and **MongoDB** (cloud runs/dashboard).

## Local SQLite — `kronyx.db`

Better-sqlite3, WAL mode. All extension hosts share the file.

**Paths**

| Environment | Location |
|---|---|
| Dev host (`npm run dev`) | `.devhost/user-data/User/globalStorage/kronyx.kronyx/kronyx.db` |
| Real install (macOS) | `~/Library/Application Support/Code/User/globalStorage/kronyx.kronyx/kronyx.db` (adjust for Insiders/profile) |

**Tables**

| Table | What's in it | Debug use |
|---|---|---|
| `session_events` | One row per posted view event — `event` is the JSON (`type`, `name`, `input`, `output`, `ts`); `run_id` groups a run; `session` names the tab | **The full run timeline** — tool calls, steer notes, asks, board changes |
| `api_calls` | Per model request: tokens in/out/cache, `duration_ms`, `kind`, `iteration`, `context_msgs` | Latency/prefill diagnosis ("1m wait" = a slow call, not a hang) |
| `runs` | Per run: `status`, `duration_ms`, token totals | Run outcomes over time |
| `usage_history` | Token rollup per run: `tokens_in/out`, `cache_read/write`, `at`, keyed by `session` + `task` | Spend debugging — see queries below |
| `transcripts` | Model-facing message arrays (`messages` JSON) per session — what the model actually saw, incl. post-compaction views | "Why did the model say that" — inspect its real context |
| `kv` | **Session metadata lives here** — `digest:<session>` = JSON array of run digests (`task`, `status`, `summary`) that populate the history sidebar and prior-run context; `runidx:<session>/<runId>` = run status index; `mtime:<root>:<path>` = file watch stamps; `migrated:<path>` = one-time DB migration marks | Session list, chat history, prior-run summaries |
| `harness_reports` | Harness activity reports | Drift/steer history |
| `episodes` | Episodic memory records — `kind`, `path`, `task`, `data` JSON | Memory/recall debugging |
| `memory_events` | Memory write/delete event log | What memory learned when |
| `prs`, `sandboxes` | PR and sandbox records (local copies) | Cross-check cloud state |
| `eval_results`, `chunks`, `embedding_cache` | Evals + RAG embeddings | Eval/memory-RAG work |

**Useful queries**

```bash
DB=.devhost/user-data/User/globalStorage/kronyx.kronyx/kronyx.db

# Latest runs (find the run_id you care about)
sqlite3 $DB "select run_id, session, count(*) from session_events group by run_id order by max(id) desc limit 6"

# Full timeline of a run — type, tool name, ok, output head
sqlite3 $DB "select id, json_extract(event,'$.type'), json_extract(event,'$.name'), \
  json_extract(event,'$.ok'), substr(json_extract(event,'$.output'),1,120) \
  from session_events where run_id='<run_id>' order by id"

# Failed tool calls in a run
sqlite3 $DB "select id, json_extract(event,'$.name'), substr(json_extract(event,'$.output'),1,160) \
  from session_events where run_id='<run_id>' and json_extract(event,'$.ok')=0"

# Slow model calls (the "why did it wait" question)
sqlite3 $DB "select at, duration_ms/1000.0 s, tokens_in, tokens_out, kind from api_calls order by at desc limit 10"

# Chat sessions + run digests (the history sidebar's data source)
sqlite3 $DB "select key, substr(value,1,120) from kv where key like 'digest:%' order by key"
sqlite3 $DB "select key, value from kv where key like 'runidx:%' and key like '%/<run_id>'"

# Usage history per session — total spend per chat
sqlite3 $DB "select session, sum(tokens_in) in_tok, sum(tokens_out) out_tok, sum(cache_read) cache_r \
  from usage_history group by session order by max(at) desc limit 10"

# Model-facing transcript for a session (what the model actually saw)
sqlite3 $DB "select at, substr(messages,1,200) from transcripts where session='<name>' order by at desc limit 5"
```

Notes: `assistant-delta`/`reasoning-delta`/`usage` events are **not persisted** (transient frames) — every other posted event is, so replay = the posted stream minus those.

## MongoDB — cloud runs

Connection: `backend/.env` → `MONGODB_URI`. Worker + API share the database.

| Collection | What's in it |
|---|---|
| `cloud_jobs` | Queued work for the agent worker (claim → run) |
| `run_events` | Cloud run event stream (UI polls / SSE `?stream=1`) — the cloud counterpart of `session_events` |
| `sessions`, `runs` | Session docs and run outcomes |
| `sandboxes`, `sandbox_events` | E2B sandbox lifecycle + events (deaths latch `live.dead`) |
| `plans` | Saved plan documents (Implement / Push to branch cards) |
| `run_transcripts`, `run_reports`, `harness_reports` | Transcripts, run summaries, harness activity reports |
| `memories`, `memory_events` | Memory store + event log |
| `usage_events` | Token/cost events |
| `attachments` | Uploaded files (`≤20KB` inlined to prompt; rest → `.kronyx/attachments/`) |
| `prs` | Opened pull requests |
| `api_keys`, `users`, `feature_flags` | Auth/account |
| `webhook_rules`, `webhook_deliveries` | Webhook config + dedupe log |
| `mcp_connectors`, `repo_templates`, `image_bakes` | MCP servers, template picks, E2B image builds |

```bash
# Tail a cloud run's events
mongosh "$MONGODB_URI" --eval 'db.run_events.find({runId: "..."}).sort({_id: 1})'
```

## Other places that hold state

| What | Where |
|---|---|
| MCP/server config | `settings.mcpServers`, `~/.kronyx/config.json` |
| Workspace artifacts | `<repo>/.kronyx/` — `attachments/`, `plans/`, `shots/` (browser screenshots) |
| Extension output log | VS Code → Output → **Kronyx** channel — one line per event (`[session] [type] …`), includes non-persisted deltas |
| Webview prefs | `vscode.setState` inside the panel (mode, drafts, harness toggle) — not on disk |
| Dev-host app state | `.devhost/user-data/` — disposable; deleting resets the dev profile |
