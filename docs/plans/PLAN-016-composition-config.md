# PLAN-016: Composition config (kronyx.yml profiles)

- Status: Proposed (deferred)
- Owner: Jacob
- Created: 2026-11-18
- Decided: -
- Closed: -
- Related: PLAN-012 (parent), PLAN-013 (seams), PLAN-015 (integrations)

## Context

dsh composes a running harness from layered YAML: bundles → profiles → home patch →
`--patch` overlays, where any plugin row can be replaced or disabled by id. Kronyx today
has fixed modes (`ask`/`plan`/`agent`) + `ProviderSettings` + a growing `RunnerHost`
options surface — composition is hardcoded.

This plan is deliberately last: it only pays off once PLAN-013 seams exist (there must
be things to compose) and PLAN-015 integrations create the demand (repos that want
different MCP servers, guards, templates, models).

## Proposal

### `kronyx.yml` — layered composition

Layers, most-local-first (mirrors our permissions layering, which already proved out):

1. Built-in defaults (mode definitions, standard tool set, guards, thresholds).
2. `~/.kronyx/kronyx.yml` — user-level.
3. `<repo>/.kronyx/kronyx.yml` — committed repo config.
4. `.kronyx/kronyx.local.yml` — personal, gitignored.
5. Session/run overrides (API payload fields, Composer-style settings).

Each layer can:

- enable/disable seam providers and guards by id;
- configure guard thresholds, tool visibility, deferred-tool set;
- declare MCP servers and webhook rules (PLAN-015);
- set model/template defaults (template catalog priority, `e2bTemplate`);
- define named **profiles**: e.g. a `review` profile = read-only tools + PR-comment
  integration + no writes, distinct from `agent`.

### Extension vs. cloud

Same file, same loader in the vscode-free core; the extension composes for the local
workspace, the worker composes for the cloud session. Backend settings merge as one
more layer.

### Explicit deferrals

- **No runtime plugin manager / npm-installed bundles** (dsh plugin-manager) until real
  third-party demand exists — config composes built-in and repo-provided pieces only.
- **No HMR** — composition is resolved at run start; mid-run changes apply next run.

## Open questions

- YAML vs. JSON vs. TS-module config — YAML matches dsh convention and comments; JSON
  matches our existing `permissions.json` layering.
- Schema versioning and validation surface (settings UI in web vs. hand-edited file).
- Per-session override granularity: which fields may a single API call override
  (model? template? guard thresholds?) — security review needed since cloud runs are
  multi-tenant.
- Relationship to Composer template field + `e2bTemplate` settings default: does
  `kronyx.yml` become the canonical home and those become layers?

## Decision and reason

Pending — gated on PLAN-013 and PLAN-015.

## Work log

- 2026-11-18: proposed as Phase 4 of PLAN-012; explicitly deferred.
