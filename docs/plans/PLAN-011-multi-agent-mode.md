# PLAN-011: Multi-Agent Mode

- Status: Proposed
- Owner: Jacob
- Created: 2026-11-02
- Decided: -
- Closed: -
- Related: PLAN-007 (sandboxes/agent mode)

## Context

Extend the cloud run model beyond a single agent: one task decomposed into bounded sub-tasks executed by parallel agents, with fan-out/fan-in semantics in the UI. See [architecture overview](../architecture/overview.md) and PLAN-007 for the sandbox + executor substrate this builds on.

Three shapes were considered:

1. Split task, same codebase — viable via `git worktree` (isolated dirs, shared `.git`, one sandbox).
2. True multi-agent, N branches — worktrees cover it; sandbox-per-slice deferred to phase 2.
3. Different repos — that is just parallel sessions; no new machinery.

## Proposal

New session mode `multi`:

- **Planner pass** decomposes the task into 4–6 slices, each with `task`, `title`, `owns` (path globs), and optional `env` (signals need for a different sandbox — detection only in v1).
- **Execution**: worktree-per-slice inside the shared sandbox (`git worktree add -b kronyx/<slug>-<id>/part-<i>`), each slice with its own `AgentRunner`, file tools rooted at its worktree, and `LiveSlot` for stop/interrupt. `Promise.allSettled` inside the parent executor — no scheduler changes.
- **Conflict prevention by design**: strict `owns` guards on `write_file`/`edit_file`; shared root manifests (lockfiles, root `package.json`) are coordinator-owned — slices defer dep changes to the coordinator.
- **Fan-in**: sequential `merge --no-ff` of each part branch into the session branch; coordinator pass resolves residual conflicts and applies deferred manifest changes; then the existing verify → push → **single PR** tail runs unchanged.
- **Events/data**: `run_events` gain `agentIndex` (0 = planner/coordinator, 1..N = slices); `runs` doc gets `slices[{index,title,status,summary}]`; new event types `fanout`, `fanin`, `fanin-conflict`, `slice-done`, `slice-failed`.
- **UI**: timeline groups by `agentIndex` — fan-out card with per-slice status pills, collapsible slice lanes, fan-in merge card; stop fans out to all slices via existing interrupt machinery.

## Decisions (locked)

- One merged PR (not PR-per-slice).
- 4–6 max parallel agents; planner picks count within cap.
- Prevent conflicts by design (strict boundaries + coordinator-owned manifests).
- Sandbox-per-slice deferred; planner `env` field is the detection mechanism.

## Files to touch (phase 1)

- `backend/src/handlers/sessions.ts` — allow `multi` mode.
- `backend/src/worker/executor.ts` — planner → worktrees → parallel slice runners → merge fan-in → coordinator → existing tail.
- `backend/src/worker/events.ts` — `agentIndex` field.
- `src/agent/decompose.ts` (new, vscode-free) — planner prompt, slice JSON parse/validate, `owns` glob helper.
- `src/agent/permissions.ts` — `modeKey("multi")` → `agent`.
- `src/tools/*` — path-guard wrapper for write tools.
- `web/components/Composer.tsx` — Multi mode chip.
- `web/components/Timeline.tsx` — fanout/fanin cards, slice lanes.
- `web/app/globals.css`, `web/app/(app)/sessions/page.tsx` — styles + mode list.

## Phase 2 (deferred)

- Honor `env` → sandbox-per-slice (own clone + branch push; fan-in merges remote branches).
- Cross-repo fan-out = parent session spawning child sessions (launcher UI + watcher).

## Open questions

- Per-slice `cloud_jobs` for multi-worker scaling — needed once a single executor's concurrency becomes the bottleneck.
- Whether slice lanes should be collapsible in-timeline vs. a side-by-side view.

## Decision and reason

Pending.

## Work log

- 2026-11-02: proposed; design agreed in planning session (one merged PR, 4–6 cap, prevent-by-design, worktree substrate).
