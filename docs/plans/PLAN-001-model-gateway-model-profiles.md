# PLAN-001: Model gateway and model profiles

- Status: In progress
- Owner: Jacob
- Created: 2026-10-31
- Decided: -
- Closed: -
- Related: ADR-0001, ADR-0007

## Context

See [architecture overview](../architecture/overview.md).

## Proposal

Custom AI API adapters (OpenAI-compatible, Anthropic, Azure, Bedrock, Ollama, vLLM) on top of `@cline/llms`; per-model capability profile (context size, tool-call format, preferred edit format, cost); routing by role (planner, editor, summariser).

## Open questions

- 

## Decision and reason

Pending.

## Work log

- 2026-10-31: proposed in the initial architecture review.
- 2026-10-31: started. Phase 0: Cline SDK `openai-compatible` provider wired via `kronyx.provider.*` settings (default Vercel AI Gateway); API key in VS Code SecretStorage. Model profiles not started.
