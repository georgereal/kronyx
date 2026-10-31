# ADR-0008: Kronyx owns its file tools

- Status: Accepted
- Owner: Jacob
- Created: 2026-10-31
- Decided: 2026-10-31
- Closed: -
- Related: ADR-0001, PLAN-002, PLAN-003

## Context

Some models struggle to edit files with Cline's built-in tools. The Cline SDK's `@cline/core` ships its own built-in tools (`editor`, `read_files`, `apply_patch`, ...), while `@cline/agents` runs the agent loop with only the tools the host passes in.

## Proposal

Kronyx provides its own file tools as additional tool calls: `read_file`, `write_file`, `edit_file`, `append_file`, plus `list_files` and `search_files`. They are registered on the `@cline/agents` `Agent`, so we control formats, matching and validation. Built-in Cline core tools are not used in Phase 0.

## Alternatives considered

- **Use Cline core built-in tools**: no work, but keeps the editing behaviour that fails for some models.
- **Wrap built-in tools with hooks**: limited control over input format and matching.

## Decision and reason

Accepted by Jacob. Custom tools let us tune read and edit formats per model (PLAN-002) and validate every change.

## Work log

- 2026-10-31: accepted; first version built in Phase 0.
