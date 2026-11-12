# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security reports. Email **security@kronyx.dev** (or open a private report via GitHub's "Report a vulnerability" feature on the Security tab) with a description and reproduction steps. We'll acknowledge within a few days and coordinate disclosure with you.

## Scope notes

Kronyx is agent tooling — it deliberately executes LLM-generated code and shell commands. Security boundaries we care about:

- **Secrets handling** — API keys in SecretStorage / server-side secrets; they must never reach transcripts, commits, `run_events`, or the web UI.
- **Permission rules** — `deny` lists must hold in every mode including `bypass`, and the global layer must never be overridable by repo or local rules.
- **Cloud isolation** — agent code runs inside sandboxes; anything escaping sandbox boundaries, leaking `.kronyx/permissions.local.json`/attachments into commits or PRs, or crossing user tenancy in the API is a bug we want to hear about.
- **Prompt-injection-driven actions** — content the agent reads can contain hostile instructions; the permission layer is the mitigation. Bypasses of it are in scope.

## Supported versions

`main` only — the project is pre-1.0 and evolves quickly.
