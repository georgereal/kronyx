/**
 * Harness messages → Responses input items (shared by the stateless and
 * conversations slices). A turn from the same provider+model replays its stored
 * output items verbatim — reasoning, message, call and any provider-specific
 * items keep their original ids and order. Call items that expect an output
 * (`function_call`, `custom_tool_call`, …) are dropped when their call_id is not
 * a canonical call in the log, so a call the harness can never answer is never
 * resent. Cross-model/provider turns — or ones with no stored items — are
 * rebuilt from the projection, so compaction and digests still apply.
 */

import { toResponsesInput } from "../../../agent/openaiWire";
import type { Message } from "../../core/projections";
import { toAgentMessages } from "./responses/messages";

export function toResponsesItems(messages: readonly Message[], target: { providerId: string; modelId: string }): Record<string, unknown>[] {
	const canonicalCalls = new Set(
		messages.flatMap((m) => (m.kind === "tool" ? [m.callId] : m.kind === "assistant" ? m.toolCalls.map((c) => c.callId) : [])),
	);
	return messages.flatMap((m) => {
		const pi = m.kind === "assistant" ? m.providerItems : undefined;
		if (pi && pi.providerId === target.providerId && pi.modelId === target.modelId && pi.items.length)
			return pi.items.filter((i): i is Record<string, unknown> => {
				const callId = (i as { call_id?: unknown } | null)?.call_id;
				return typeof callId !== "string" || canonicalCalls.has(callId);
			});
		return toResponsesInput(toAgentMessages([m]));
	});
}
