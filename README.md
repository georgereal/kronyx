# Kronyx

> **From Prompts to Production.** — Kronyx transforms developer intent into production-ready software through intelligent agentic engineering.

VS Code extension for agentic coding, built on the [Cline SDK](https://github.com/cline/cline/tree/main/sdk) with its own run-oriented UI and Kronyx-owned file tools. Design docs and the decision/plan tracker live in [docs/](docs/README.md).

## Why "Kronyx"?

Named after **Cronus (Κρόνος)**, the Greek Titan associated with time and the cosmic order — a fitting patron for a run-oriented agent that plans, acts, verifies and learns over time. *Kronyx* is a modern, technology-oriented adaptation: the brand idea is **power, orchestration, autonomy and control**.

A playful reading some of us like: **K** = *Knowledge*, **RONYX** = a distinctive, futuristic identity. (That's a branding interpretation — the mythology is the original rationale.)

## Status (Phase 0)

- Agent loop: `@cline/agents` `Agent` with the `openai-compatible` provider (default: Vercel AI Gateway).
- File tools (ADR-0008): `read_file`, `write_file`, `edit_file`, `append_file`, `insert_lines`, `list_files`, `search_files`. Workspace-scoped, symlink-safe, whitespace-tolerant edits with "closest match" hints on failure.
- UI: Kronyx activity-bar view with a run timeline (task, agent messages, tool calls with status/duration, changed files, tokens), Stop and New task.
- Writes ask for approval unless `kronyx.approval.autoApproveWrites` is on. Files with unsaved editor changes are never touched.

## Develop

Requires Node 22+.

```sh
npm install
npm run check      # typecheck, lint, unit tests, build
```

Press F5 ("Run Kronyx extension") to open an Extension Development Host.

## Build and install

```sh
npm run build      # dev bundle via esbuild -> dist/extension.js
npm run package    # production bundle
npm run vsix       # production bundle + vsce package -> kronyx-<version>.vsix
```

Install the packaged extension locally:

```sh
code --install-extension kronyx-0.0.1.vsix
```

Bump `version` in `package.json` before packaging a new release. Marketplace publishing is not configured (the extension is `private`).

## Configure

Settings (`kronyx.*`):

| Setting | Default |
| --- | --- |
| `provider.id` | `openai-compatible` |
| `provider.baseUrl` | `https://ai-gateway.vercel.sh/v1` |
| `provider.modelId` | `anthropic/claude-sonnet-4.6` |
| `agent.maxIterations` | `40` |
| `approval.autoApproveWrites` | `false` |

Run **Kronyx: Set API key** to store the key in VS Code SecretStorage (never in settings or the repo).
