# Follow-up: harness/tool-layer review (review-first, no code changes)

## Summary
Folds the review-first plan (`.kronyx/plans/harness-tool-layer-plan.md`) into a concrete, honest next-step list. No source edits, no commits — user reviews before anything is implemented.

## Verified / known this session (from the board + partial reads; do NOT treat as fully re-verified)
- Git state: top commit `a54ae67` ("Session view run isolation, harness tools, and tool-layer hardening") + a 21-file uncommitted diff (+1751/−75).
- `src/agent/toolSet.ts`: mode-filtered tool assembly — PLAN_VISIBLE / READ_ONLY_HIDDEN / READ_PARALLEL sets, readsBatchRules / BATCH_FORCE_AT batch-force logic, `update_progress` tool, deferred/skill dispatch. Partial read only (lines 1–~98 plus the guards section).
- `src/tools/mcpTools.ts`: stdio servers + remote URL servers, `${secret:NAME}` redaction, read-only hints (v1 scope per file header). Partial read only (lines ~10–23); resources/prompts/OAuth not seen.
- `src/harness/shellReadOnly.ts`: conservative read-only classifier; tight allowlist because a false positive would let a write count as exploration. Partial read only (lines 1–11).
- `CODEBASE_EXPLANATION.md` does NOT exist (flagged in the plan's evidence base; board's t2 s1 cannot be closed honestly).
- Board: t3 s1/s2 done, t4 s1 in_progress, t5 s1/s2 marked done — the t5 "done" flags are board claims, NOT re-verified this run.

## Board mismatch to resolve (honest)
The plan is review-first: it says NO files to change. Board t4 s1 asks to "locate the files the plan says to change" — the honest answer is: none. t4 s2/s3 (code changes + tests) are not applicable until the user explicitly approves implementation. Report this rather than "locating files" that do not exist.

## Findings / gaps — honest state
- Harness review (shellReadOnly.ts, steering.ts, recall.ts, loop.ts): NOT fully verified. Only fragments read. Do NOT claim read-only enforcement or loop-invariant soundness. → Next: full read + findings list with file:line and severity.
- IDE vs cloud parity: prior audit lists IDE (fileTools, ideTools, fetchTools/network.ts, procTools, localBrowserTools/Playwright, mcpTools, dispatchTools `use_tool`, recall/explore/update_progress) vs cloud (remoteFileTools, fetchTools, cloud browserTools `browser_use` sub-agent, envTools, mcpTools). Marked NOT re-verified this session. → Next: walk the two lists and publish a parity gap list (tool names only).
- MCP resources/prompts + OAuth: NOT confirmed present; partial read is consistent with absence (stdio+URL only) but is not proof. Doc/PDF read: none seen; unverified.
- Full prior audit transcript (seq 216/274/345) unavailable this session; gap list stays unverified until the full reads.

## Next steps (ordered)
1. Full read of shellReadOnly.ts, steering.ts, recall.ts, loop.ts, mcpTools.ts → findings list (file:line, severity).
2. Re-run the harness suite (`npx tsx test/harness/*.test.ts` + `test/shellReadOnly.test.ts`) and typecheck to confirm t5 s1/s2 (board-marked done; not independently verified).
3. Walk `assembleToolSet` (IDE) vs `src/ui/cloudController.ts` (cloud) tool name lists; publish parity gap list.
4. Confirm gaps (MCP resources/prompts/OAuth, doc/PDF) with full file:line evidence.
5. Decide CODEBASE_EXPLANATION.md: retire it (preferred — never written, evidence unverified) or write fresh from the verified evidence.
6. User reviews findings + this plan before any code change. No commits.

## Not done / open
- No code changes, no commits.
- Full audit transcript unavailable; gap list unverified until steps 1–4.
- t4 board state: s1 resolves honestly to "no files to change."
