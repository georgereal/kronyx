# PLAN-002: Edit engine

- Status: In progress
- Owner: Jacob
- Created: 2026-10-31
- Decided: -
- Closed: -
- Related: ADR-0001

## Context

See [architecture overview](../architecture/overview.md).

## Proposal

Multi-strategy edits: anchored line edits, fuzzy search/replace, symbol (AST) edits, lenient unified diff, whole-file write, optional apply model. Every edit is parsed, formatted and diagnostics-checked; failures return the current snippet for a grounded retry. Outcomes update the model profile.

## Open questions

- 

## Decision and reason

Pending.

## Work log

- 2026-10-31: proposed in the initial architecture review.
- 2026-10-31: started. Phase 0: `edit_file` (exact, then indentation/whitespace-tolerant matching, all-or-nothing, closest-match hint on failure, CRLF preserved), `write_file`, `append_file`, `insert_lines` in src/tools. Hash-anchored lines, AST edits and post-edit validation not started.
