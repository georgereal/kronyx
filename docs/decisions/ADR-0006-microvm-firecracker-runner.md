# ADR-0006: MicroVM host: remote Linux runner with Firecracker

- Status: Proposed
- Owner: Jacob
- Created: 2026-10-31
- Decided: -
- Closed: -

## Context

Firecracker needs KVM on Linux, so Mac and Windows developers need a remote host.

## Proposal

Ship Docker and devcontainer first; build a Firecracker runner service for agent mode afterwards.

## Alternatives considered

- Local VMs via Lima or Apple Virtualization: per-OS work.
- Hosted sandbox vendor: less ops, external dependency.

## Decision and reason

Pending.

## Work log

- 2026-10-31: proposed in the initial architecture review.
