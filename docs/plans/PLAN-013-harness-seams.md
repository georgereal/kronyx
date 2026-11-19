# PLAN-013: Harness seams and tool-pipeline guards

- Status: Proposed
- Owner: Jacob
- Created: 2026-11-18
- Decided: -
- Closed: -
- Related: PLAN-012 (parent), PLAN-014 (event log), PLAN-015 (integrations)

## Context

Kronyx's extensibility today is `RunnerHost` — a callback bag (`createTools`,
`confirmWrite`, `checkPermission`, `memoryContext`, `emit`, …) that the extension and
`backend/src/worker/executor.ts` each implement differently. All policy lives inside one
`beforeTool` hook in `src/agent/runner.ts` (loop guard, permission rules, mode gating,
`save_plan` exception). Adding a capability means widening the bag and touching the hook.

Both deepseek-harness (capability seams: Service Definition / Provider / Consumer +
tool-execution waterfalls) and the GrowMagik platform writeup (vendor adapters with a
framework-free interface; "edges are where the checks sit") point at the same fix:
named seams with provider registration, and ordered guard stages at the tool boundary.

## Proposal

### 1. Minimal registry + event surface (`src/agent/registry.ts`, new)

- `KronyxRegistry`: `register(name, provider) → disposer`; providers per seam name.
- Sequential middleware for the tool pipeline:
  `preTool(call) → "allow" | "ask" | "deny" | transform`, `aroundTool` (timeout/retry
  wrappers), `postTool(result) → result | replace`. Waterfall semantics: each stage
  must explicitly delegate to the next (dsh's `next()` contract).
- Keep `@cline/agents` `Agent` as the executor; our middleware wraps `beforeTool`/`onEvent`.

### 2. Extract existing policy into guards

Each becomes a registered guard with a disposer, removable per composition:

- `repeatToolGuard` — current dup-detection (nudge at 3, stop at 5); make thresholds
  and tool scope configurable (cf. dsh `repeat-tool-reminder`).
- `permissionGuard` — `checkPermission` allow/ask/deny rule evaluation.
- `modeGuard` — `WRITE_TOOL_NAMES`/`READ_ONLY_HIDDEN` gating, `save_plan` plan-mode
  exception, `mode-blocked` event.
- `approvalGuard` — `confirmWrite` as the ask-resolution stage.

### 3. Promote `RunnerHost` callbacks into named seams

| Seam | Local (extension) provider | Cloud (worker) provider |
|---|---|---|
| `fs/exec` | `createFileTools` + `execCommand` | `remoteFileTools` over `SandboxHandle` |
| `sandbox` | none (host fs) | E2B handle + template catalog |
| `approvals` | vscode confirm UI | auto-allow / rules only |
| `memory` | `memoryContext`, `onMemoryFact`, recall | worker memory.ts |
| `events` | webview emit | `run_events` append |

`RunnerHost` narrows to: workspace identity, mode, emit, log. Everything else comes
through seam resolution, so a new capability (e.g. SSH devbox, non-E2B sandbox) is a
provider registration, not a signature change in two call sites.

### 4. Architecture-boundary check (cheap, from GrowMagik "edges")

- Script/CI check: `src/agent`, `src/tools`, `src/sandbox`, `src/diff` must not import
  `vscode`. Enforced mechanically instead of by AGENTS.md convention.
- Optionally extend: forbid worker imports of extension glue and vice versa.

## Open questions

- Middleware signature: simple `(call, next) => decision` vs. dsh-style waterfall with
  typed event map — pick the smallest that covers guards + future hooks.
- Do tools themselves register through the registry (making `createTools` a provider),
  or keep the tool list flat and only policy pluggable?
- Where does the registry live: per-`AgentRunner` instance vs. per-session composition?

## Decision and reason

Pending.

## Work log

- 2026-11-18: proposed as Phase 1 of PLAN-012.
