# ADR-0002: Core language: TypeScript

- Status: Proposed
- Owner: Jacob
- Created: 2026-10-31
- Decided: -
- Closed: -

## Context

The extension host, webview and Cline SDK are TypeScript; the core must also run headless in a microVM.

## Proposal

Use TypeScript (Node runtime) for the core and extension. Consider a Rust indexer later only if large repos need it.

## Alternatives considered

- Python core: better ML ecosystem but a second runtime in the extension.
- Rust core: fast, slower to build features.

## Decision and reason

Pending.

## Work log

- 2026-10-31: proposed in the initial architecture review.
