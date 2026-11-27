/** Harness messages → the AgentMessage shape the shared wire layer converts (Responses API slice). */

import type { AgentMessage } from "@cline/shared";
import type { Message } from "../../../core/projections";

export function toAgentMessages(messages: readonly Message[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	messages.forEach((m, i) => {
		const id = `m${i}`;
		const createdAt = i;
		if (m.kind === "user" || m.kind === "system") {
			const images = m.kind === "user" ? (m.images ?? []) : [];
			const content: AgentMessage["content"] = [
				{ type: "text", text: m.text },
				...images.map((img) => ({ type: "image" as const, image: img.base64, mediaType: img.mediaType })),
			];
			out.push({ id, role: "user", createdAt, content });
		} else if (m.kind === "assistant") {
			const content: AgentMessage["content"] = [
				...(m.text ? [{ type: "text" as const, text: m.text }] : []),
				...m.toolCalls.map((c) => ({ type: "tool-call" as const, toolCallId: c.callId, toolName: c.name, input: c.input })),
			];
			out.push({ id, role: "assistant", createdAt, content: content.length ? content : [{ type: "text", text: "" }] });
		} else {
			out.push({ id, role: "tool", createdAt, content: [{ type: "tool-result", toolCallId: m.callId, toolName: m.name, output: m.output, isError: !m.ok }] });
		}
	});
	return out;
}
