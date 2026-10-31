# ADR-0001: Build on the Cline SDK with our own VS Code extension

- Status: Accepted
- Owner: Jacob
- Created: 2026-10-31
- Decided: 2026-10-31
- Closed: -

## Context

Cline is Apache-2.0. It now ships a headless SDK (`@cline/shared`, `@cline/llms`, `@cline/agents`, `@cline/core`) separate from its VS Code app, with custom tools, hooks, plugins, MCP and SQLite session storage. Roo Code, the main Cline fork, is archived. The main complaint about Cline is the usability of its chat window.

## Proposal

Depend on the Cline SDK packages for the agent loop, providers and tool plumbing. Build our own VS Code extension and UI (run-centric, native VS Code surfaces). Add Kronyx capabilities as SDK custom tools, hooks and plugins: edit engine, verification gates, memory capture, sandbox backends.

## Alternatives considered

- **Fork the whole Cline monorepo**: fastest start, but inherits the chat UI we dislike, and the repo moves fast (Bun toolchain, daily commits), so merges get painful once we diverge.
- **Build from scratch**: full control, but months spent rebuilding providers, tool calling, MCP and session storage that the SDK already has.
- **Fork only the SDK**: fallback if the SDK's extension points cannot host our edit engine or memory hooks.

## Decision and reason

Accepted by Jacob: build on the Cline SDK with our own UI. Cline's chat-window usability is the main reason not to fork the full app. First provider is OpenAI-compatible (Vercel AI Gateway). File tools are our own (ADR-0008).

## Work log

- 2026-10-31: proposed in the initial architecture review.
- 2026-10-31: accepted; Phase 0 implementation started.
