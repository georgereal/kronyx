/** Harness messages → Cline messages (vscode-free). Tool results travel as user tool_result blocks. */

import type { Message as ClineMessage } from "@cline/shared";
import type { Message } from "../../core/projections";

export function toClineMessages(messages: readonly Message[]): ClineMessage[] {
	return messages.map((m): ClineMessage => {
		if (m.kind === "user" || m.kind === "system") {
			const images = m.kind === "user" ? (m.images ?? []) : [];
			if (images.length === 0) return { role: "user", content: m.text };
			return {
				role: "user",
				content: [
					{ type: "text", text: m.text },
					...images.map((img) => ({ type: "image" as const, data: img.base64, mediaType: img.mediaType })),
				],
			};
		}
		if (m.kind === "assistant") {
			const blocks: NonNullable<Extract<ClineMessage["content"], unknown[]>> = [];
			if (m.text) blocks.push({ type: "text", text: m.text });
			for (const c of m.toolCalls) blocks.push({ type: "tool_use", id: c.callId, name: c.name, input: c.input as Record<string, unknown> });
			return { role: "assistant", content: blocks.length ? blocks : "" };
		}
		return { role: "user", content: [{ type: "tool_result", tool_use_id: m.callId, name: m.name, content: m.output, is_error: !m.ok } as never] };
	});
}
