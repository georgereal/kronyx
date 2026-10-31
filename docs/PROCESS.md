# Planning process

## Rules

1. Every plan and decision is written down in this repo before work starts.
2. Every record has an ID, an owner and a status, and appears in [TRACKER.md](TRACKER.md).
3. Every record is tracked to closure. Deciding not to do something is a valid closure.
4. Records are never deleted. Rejected, deferred and superseded records stay, with the reason.

## Record types

| Prefix | Type | Folder |
|---|---|---|
| `ADR-` | Architecture decision | `decisions/` |
| `PLAN-` | Feature or capability plan | `plans/` |

## Status lifecycle

```
Proposed -> Accepted -> In progress -> Done
         \-> Deferred  (revisit date required)
         \-> Rejected  (reason required)
Accepted/Done -> Superseded by <ID>
```

Closed statuses: **Done**, **Rejected**, **Superseded**. Deferred is open until revisited.

## Workflow

1. Copy the template below into a new file, take the next free ID, set status `Proposed`.
2. Add a row to `TRACKER.md` in the same PR.
3. When decided, update the status, the decision date and the reason in both places.
4. When work lands, link the PRs in the record and set `Done`.

## Template

```markdown
# <ID>: <title>

- Status: Proposed
- Owner: <name>
- Created: YYYY-MM-DD
- Decided: -
- Closed: -
- Related: <IDs>

## Context
## Proposal
## Alternatives considered
## Decision and reason
## Work log (PRs, notes)
```
