# Kronyx

> **One agent system, two ways to run it** — inside your editor, or in the cloud.

Kronyx is an open-source agentic coding platform: a **VS Code extension** for interactive, run-oriented agent sessions, and a **cloud agent** that picks up tasks, works in isolated sandboxes, and comes back with a pull request. Both run the same agent core — the difference is where the machine is.

Bring your own keys (any OpenAI-compatible provider — OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, Ollama) and self-host the backend if you want cloud runs on your own infrastructure.

## Features

### Both modes

- **Agent loop** on the [Cline SDK](https://github.com/cline/cline) (`@cline/agents`) with native function calling — `read_file`, `write_file`, `edit_file`, `search_files`, `run_command`, `browser_use`, `memory_write`, `save_plan`, `switch_environment`, `recall_context`.
- **Context engine** — real BPE token counting, multi-tier compaction (tool-result stubbing, reasoning pruning, argument elision, LLM summarization), and embedding-based semantic `recall_context` over the elided transcript. The agent manages its own context window instead of blowing through it.
- **Layered permission rules** — Claude Code-style `allow`/`ask`/`deny` globs (`run_command(npm run test:*)`, `write_file(src/**)`) across global → repo → local layers. Global `deny` is never overridable.
- **Five modes** — `ask` (chat only), `plan` (read-only → saved plan), `code` (writes with approval), `smart`/`agent` (writes auto-approved), `bypass`.
- **Memory** — durable facts via `memory_write`, recalled into later runs (embedding search when configured).
- **Provider profiles** — multiple LLM providers/models with per-mode defaults; keys in OS secure storage, never in settings or the repo.

### VS Code extension

- Run-oriented UI: timeline of task → messages → tool calls (status, duration, tokens), diff review with hunk accept/reject, inline comments.
- Permission cards on gated calls — allow once, for the run, or save a narrow rule.
- Post-run checks (lint/typecheck/test commands you configure), eval harness, usage page.
- Settings page (in-editor or separate window) covering providers, permissions, sandbox and sync.

### Cloud agent

- **Session → sandbox → PR.** Kick a session from the dashboard or the extension; a worker claims it, clones your repo into an isolated sandbox, runs the agent, then commits, pushes and opens/updates a PR on a `kronyx/` branch.
- **Start from anywhere** — default branch, a feature branch, or an open PR (same-repo or fork).
- **Sandbox providers** — E2B (default), Docker, Kubernetes, Vercel Sandbox. `switch_environment` lets the agent swap VM images mid-run when the stack demands it.
- **`browser_use` + screenshots** — a real Chromium (browser-use + Playwright) inside the sandbox for UI work and visual verification.
- **Web dashboard** — session timelines, pending-permission approvals, live context-window meter with pruning history, per-request token/cost charts (input, output, cache read/write, reasoning), GitHub + provider + permission settings.
- **GitHub App integration** — scoped, revocable repo access; no PATs in the codebase.
- **Cross-device settings sync** — provider config, secrets and global permission rules follow your account.

## Architecture

```
┌──────────────────┐        ┌─────────────────────────────┐
│  VS Code ext     │        │  Cloud                      │
│  src/            │        │  web/  (Next.js dashboard)  │
│  run UI, diffs,  │        │   └─ /api/* → backend       │
│  permissions,    │        │  backend/                   │
│  local runs      │        │   ├─ REST API (sessions,    │
│                  │        │   │   runs, usage, github)  │
│  shared core ────┼────────┤   └─ worker: claims jobs,   │
│  src/agent,      │        │      E2B/Docker/k8s sandbox,│
│  src/tools,      │        │      clone → run → commit → │
│  src/sandbox     │        │      push → PR              │
└──────────────────┘        └─────────────────────────────┘
```

The agent core (`src/agent`, `src/tools`, `src/sandbox/sandboxCore.ts`) is deliberately **vscode-free** — the extension imports it, and the backend worker bundles the same files via esbuild. One implementation of compaction, recall, permissions and the tool surface drives both run modes.

Design docs, ADRs and the plan tracker live in [docs/](docs/README.md); contributor-facing architecture rules in [AGENTS.md](AGENTS.md).

## Quickstart

### Local (VS Code extension)

Requires Node 22+ and VS Code 1.85+.

```sh
npm install
npm run build        # dev bundle -> dist/extension.js
npm run vsix         # production bundle + packaged .vsix
code --install-extension kronyx-<version>.vsix
```

Then **Kronyx: Set API key** (stored in SecretStorage — never in settings or the repo) and **Kronyx: New task**. Or press F5 for an Extension Development Host.

### Cloud (self-hosted)

```sh
# backend — copy env vars (see backend/README.md)
cd backend && npm install && npm run build
BACKEND_RUN_WORKER=1 npm start          # API :4000 + embedded worker

# dashboard
cd web && npm install && npm run dev    # UI :3000, proxies /api to :4000
```

Needs MongoDB, a Firebase project (GitHub sign-in), a GitHub App for repo access, and an E2B key (or Docker/k8s/Vercel as the sandbox provider). Details in [backend/README.md](backend/README.md) and [web/README.md](web/README.md).

## Permission rules

Persistent `allow`/`ask`/`deny` rules, layered like Claude Code:

| File | Scope |
| --- | --- |
| `~/.kronyx/permissions.json` | Global — every repo, local and cloud (synced via settings) |
| `<repo>/.kronyx/permissions.json` | Committed — shared with teammates; also applies inside cloud sandboxes |
| `<repo>/.kronyx/permissions.local.json` | Personal — that repo only, gitignored |

```json
{ "permissions": {
    "allow": ["read_file", "run_command(npm run test:*)", "write_file(src/**)"],
    "ask":   ["browser_use"],
    "deny":  ["run_command(rm -rf *)", "run_command(git push *)", "write_file(**/.env*)"]
}}
```

`tool` matches a whole tool; `tool(glob)` matches the target (file path, shell command, URL). Precedence: global `deny` is a hard floor; otherwise the most-local matching rule wins. Unmatched calls fall back to mode defaults. Edit rules in **Settings → Permissions** (extension or dashboard), or via "Always allow this (saved)" on a permission card.

## Configuration

Settings live under `kronyx.*` (VS Code) or the settings page. The ones that matter most:

| Setting | Default |
| --- | --- |
| `provider.id` / `provider.baseUrl` / `provider.modelId` | `openai-compatible` / Vercel AI Gateway / claude-sonnet |
| `agent.defaultMode` | `code` |
| `agent.maxIterations` | `40` |
| `approval.autoApproveWrites` | `false` |
| `sandbox.enabled` / `sandbox.backend` | `false` / `local` |
| `cloud.autoPr` / `cloud.defaultBase` | `true` / `main` |
| `memory.enabled` | `true` |
| `sync.enabled` / `sync.endpoint` | `false` / dashboard URL |

Full list: `package.json` → `contributes.configuration`, or the in-extension settings page.

## Why "Kronyx"?

Named after **Cronus (Κρόνος)**, the Greek Titan associated with time and the cosmic order — a fitting patron for a run-oriented agent that plans, acts, verifies and learns over time. The brand idea is **power, orchestration, autonomy and control**.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and conventions, [docs/TRACKER.md](docs/TRACKER.md) for open plans and decisions, and [SECURITY.md](SECURITY.md) to report vulnerabilities.

## License

[Apache-2.0](LICENSE). Built on the Apache-2.0 [Cline SDK](https://github.com/cline/cline) — see [NOTICE](NOTICE).
