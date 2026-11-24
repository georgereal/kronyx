/**
 * Durable run events: the canonical per-run record ("model-visible ⟺ logged").
 * vscode-free — shared by the extension and the cloud worker.
 *
 * `KronyxEvent` is a superset of `RunViewEvent` (the live/UI stream). Durable
 * record types carry what the UI stream lacks: the actual transcript messages
 * (`agent-message`), compaction markers, and lifecycle facts needed for replay.
 * Anything that reached a model request must be reconstructable from these
 * records; `deriveMessages` projects the model history back out.
 */

import type { AgentMessage } from "@cline/shared";
import type { RunViewEvent } from "./runner";

export type KronyxEvent =
	| RunViewEvent
	/** Canonical transcript message as the runtime committed it — user inputs,
	 *  assistant messages (with tool-call parts), and tool-result messages.
	 *  Deduped by `message.id` during projection. */
	| { type: "agent-message"; message: AgentMessage }
	/** Context compaction applied (hard tier / manual). `stats` is the
	 *  prepareTurn compaction summary — opaque, for observability. */
	| { type: "compaction"; stats?: unknown }
	/** Sandbox was recreated mid-run; uncommitted work was lost. */
	| { type: "sandbox-recreated"; reason?: string }
	/** Resume marker: the agent was seeded from a prior run's event log.
	 *  `repaired` counts tool-call/result pairs fixed by sanitizeMessages. */
	| { type: "resumed-from-log"; messages: number; repaired?: number };

/**
 * Project the model-visible message history out of the durable record.
 * `agent-message` records are replayed in order, deduped by message id
 * (assistant-message and message-added may both record the same message).
 */
export function deriveMessages(events: readonly KronyxEvent[]): AgentMessage[] {
	const seen = new Set<string>();
	const out: AgentMessage[] = [];
	for (const e of events) {
		if (e.type !== "agent-message") continue;
		const m = e.message;
		const id = m?.id ?? "";
		if (id && seen.has(id)) continue;
		if (id) seen.add(id);
		out.push(m);
	}
	return out;
}
