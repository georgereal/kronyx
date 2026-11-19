# PLAN-012: Plugin architecture and harness seams

- Status: Proposed
- Owner: Jacob
- Created: 2026-11-18
- Decided: -
- Closed: -
- Related: PLAN-007 (sandboxes/agent-mode), PLAN-011 (multi-agent mode), PLAN-006 (memory/RAG)

## Context

Comparative study of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`), an open-source agent harness built on Cordis where **everything is a plugin**.
Both projects solve the same problem — a host-free agent core composed differently by a
local editor surface and a cloud sandbox worker — so its architecture is a direct
reference for Kronyx's integration and extensibility story.

## What dsh does that we don't

| dsh concept | Kronyx today | Value if adopted |
|---|---|---|
| Capability seams (Service Definition / Provider / Consumer) | `RunnerHost` callback bag | One provider swap (fs/exec/sandbox) moves the whole environment |
| Tool pipeline waterfalls (`pre-execute → guards → approval → execute → post-execute`) | single `beforeTool` hook carrying loop-guard + permissions + mode-gating | Third-party policy/hooks without touching the runner |
| Durable session event log ("model-visible ⟺ logged"; context is a projection) | in-memory `AgentMessage[]` + UI-only `run_events` | Replay/resume after sandbox death, recall on real events, audit |
| MCP manager + webhook runtime | none | Whole integration ecosystem instead of bespoke handlers/routes |
| Subagent providers (in-process / fork / ACP / external CLIs) | hand-rolled fanout slices | Delegate slices to external agents or other models |
| Guards/skills/spill/jobs as independent plugins | inline or absent | Configurable, composable behavior packs |
| Profiles/bundles (`cordis.yml` layered composition) | modes + hardcoded tool sets | Repo-level `kronyx.yml` composition — defer until seams exist |

## Proposal (direction, open for revision)

Adopt dsh's **design patterns incrementally**, not Cordis itself:

1. **Seam layer** in the vscode-free core: typed events + register/dispose registry;
   extract loop-guard, permissions, mode-gating into ordered disposable guards;
   promote `RunnerHost` callbacks into named seams (fs/exec, sandbox, approvals, memory, events).
   → [PLAN-013](PLAN-013-harness-seams.md)
2. **Durable session event log**: extend `run_events` into the canonical record;
   `deriveMessages(log)` projects model context — enables resume-after-VM-death.
   → [PLAN-014](PLAN-014-durable-event-log.md)
3. **Integrations as plugins**: MCP server fleet seam, webhook/scheduled triggers
   enqueueing `cloud_jobs`, skill directories, external subagent providers.
   → [PLAN-015](PLAN-015-integrations-as-plugins.md)
4. **Composition config** (only if needed): `kronyx.yml` profile layers.
   → [PLAN-016](PLAN-016-composition-config.md)

## Corroborating pattern: platform-SDK thinking (GrowMagik post)

[Inside GrowMagik: the blocks every app is built from](https://blogs.thequickbee.com/inside-growmagik-building-blocks)
isn't an agent-framework post, but its platform ideas independently confirm the seam direction:

- **Vendor adapters, framework-free interface + sandbox impl** — same as dsh's seams:
  LLM providers, sandbox backends, code hosts, MCP servers each become a plain interface
  plus a fake for tests.
- **Uniform internals** — "anyone who has read one, a person or an AI, can find their way
  around." One tool/plugin shape (schema → policy → events → executor → result) makes the
  system extensible for contributors *and* for our own agent.
- **Same interface in-process or remote** — already half-true (`fileTools` vs
  `remoteFileTools`); formalize as one seam with local/remote providers.
- **Outbox pattern** — events committed with the change, relayed, idempotent consumers:
  the model for making `run_events` canonical (Phase 2).
- **"Edges are where the checks sit"** — pipeline guards enforce at seam boundaries;
  also worth a CI/architecture check that fails if `src/agent|tools|sandbox` imports
  `vscode` (today it's convention only).
- **"AI assembles known blocks; unreliable inventing them"** — their spec-first flow is
  our ask/plan/agent modes; more named blocks (templates, recipes, skills, tool packs)
  = better agent performance. `imageRecipes`/template catalog already follow this.
- **Modular monolith → split later** — validates `BACKEND_RUN_WORKER=1` embedded vs
  split worker; keep both shapes.
- **Generated wiring + drift check** — one manifest generating tool/permission/event
  registries, with a test asserting code matches (cheap version of dsh's generated catalogs).

### Alternatives considered

- **Homegrown plugin container**: right-sized but ~weeks of framework work before features land.
- **Adopt Cordis**: correct semantics for free, but vendored Cordis is DeepSeek-internal,
  adds a runtime DI graph to debug, and `@cline/agents` still needs wrapping.
- Decision deferred — revisit after Phase 1 lands and integration count is known.

## Open questions

- Do we wrap `@cline/agents` `Agent` behind our own loop eventually, or keep it as the executor under our seams?
- Durable log format: extend `run_events` docs vs. separate append-only collection with versioned generations (dsh-style)?
- Which integrations land first via MCP vs. native handlers (GitLab? Linear/Jira? Slack)?
- Does the extension need its own composition surface (per-workspace `kronyx.yml`) at the same time, or is cloud-first fine?

## Decision and reason

Pending — Jacob to weigh approach depth after reviewing this comparison.

## Work log

- 2026-11-18: comparative study vs deepseek-harness; phased adoption direction proposed.
- 2026-11-18: added corroborating patterns from the GrowMagik platform-SDK writeup.
- 2026-11-18: split phases into child plans PLAN-013 through PLAN-016.
