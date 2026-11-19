# PLAN-015: Integrations as plugins (MCP, webhooks, skills, subagents)

- Status: Proposed
- Owner: Jacob
- Created: 2026-11-18
- Decided: -
- Closed: -
- Related: PLAN-012 (parent), PLAN-013 (seams — prerequisite), PLAN-011 (multi-agent)

## Context

The original motivation: dsh's plugin architecture gives it an integrations surface —
MCP servers bridged into the tool registry, webhook rules enqueueing work, skill
providers, and subagent backends that can be external agents (ACP, Claude Code, Codex).
Kronyx integrations today are compile-time code in `backend/src/lib` (githubApp,
firebaseAdmin, e2b) with bespoke REST handlers; there is no MCP support and no way for a
repo or third party to add capability without a PR.

Prerequisite: PLAN-013 seams — every integration registers tools/providers through the
same registry rather than new one-off plumbing.

## Proposal

### 1. MCP seam (highest value)

- `src/tools/mcpTools.ts`: MCP client (via `@modelcontextprotocol/sdk`) that registers
  each server's tools into the registry under a namespace (`mcp_<server>_<tool>`).
- Settings-driven fleet: backend `settings`/`kronyx.yml` declares which MCP servers a
  session/repo gets; worker spawns/connects them inside the sandbox or on the host.
- Tool schemas join prompt assembly like native tools; results pass through the same
  pipeline guards (permissions apply to `mcp_*` too — e.g. `ask` rules per server).
- Delivers the entire MCP ecosystem (GitLab, Linear, Jira, Slack, Postgres, …) without
  bespoke handlers.

### 2. Webhook/schedule triggers

- `backend/src/handlers/` generic webhook endpoint: trusted rules (repo-scoped secret,
  event filter) enqueue `cloud_jobs` — the same entry `POST /api/sessions/:id/messages`
  uses today.
- Scheduled follow-ups: cron-ish triggers that inject a message into an existing or new
  session (e.g. nightly dep-update agent).
- First adapters: GitHub (we already have the App), then GitLab/generic.

### 3. Skills seam

- `.kronyx/skills/` directories + plugin-provided skill folders surfaced to the agent
  through progressive disclosure — index in system prompt, `use_tool`-style load on
  demand (we already have the deferred-tool pattern in `dispatchTools.ts`).
- Lower cost than growing the flat tool list; also the natural home for per-repo agent
  customizations.

### 4. External subagent providers

- Keep in-process fanout slices (executor `SLICE_DIR` mechanism) as the default provider.
- Define `SubagentProvider` seam: start a child task, stream progress, return result —
  implementable later by a second session, another model, or an external runtime.
- Lets PLAN-011 multi-agent pick providers per slice (cheap model for exploration,
  strong model for implementation).

### 5. Trust and policy

- Plugin-declared permissions: an MCP server/webhook can't widen its own authority;
  repo/user permission rules (PLAN-013 `permissionGuard`) apply uniformly.
- Cloud jobs run integrations inside the sandbox by default; host-side integrations
  need explicit settings opt-in.

## Open questions

- MCP servers inside E2B (sandboxed, dies with VM) vs. worker-side (survives, needs
  creds on host) — probably per-server config.
- Which integrations stay native (GitHub PR flow is deep — keep `githubApp.ts`) vs.
  move behind the generic webhook/MCP surface?
- Skill format: adopt the AGENTS/skills `SKILL.md` convention or our own?
- Do MCP tool results route through `postTool` rewriting (spill to file when large)?

## Decision and reason

Pending.

## Work log

- 2026-11-18: proposed as Phase 3 of PLAN-012.
