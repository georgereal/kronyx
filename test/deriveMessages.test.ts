import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@cline/shared";
import { deriveMessages, type KronyxEvent } from "../src/agent/events";

const msg = (id: string, role: AgentMessage["role"], text: string): AgentMessage => ({
	id,
	role,
	content: [{ type: "text", text }],
	createdAt: 0,
});

describe("deriveMessages", () => {
	it("replays agent-message records in order", () => {
		const events: KronyxEvent[] = [
			{ type: "run-started", task: "t" },
			{ type: "agent-message", message: msg("1", "user", "task") },
			{ type: "agent-message", message: msg("2", "assistant", "sure") },
			{ type: "agent-message", message: msg("3", "user", "tool result") },
			{ type: "run-finished", status: "completed", text: "done", iterations: 1 },
		];
		const out = deriveMessages(events);
		expect(out.map((m) => m.id)).toEqual(["1", "2", "3"]);
	});

	it("dedupes by message id (assistant-message + message-added record the same message)", () => {
		const m = msg("x", "assistant", "hi");
		const out = deriveMessages([
			{ type: "agent-message", message: m },
			{ type: "agent-message", message: m },
		]);
		expect(out).toHaveLength(1);
	});

	it("ignores UI-only and non-message records", () => {
		const out = deriveMessages([
			{ type: "assistant-delta", text: "partial" },
			{ type: "tool-started", id: "t1", name: "read_file", input: {} },
			{ type: "compaction", stats: { before: 1000 } },
			{ type: "sandbox-recreated", reason: "vm death" },
		]);
		expect(out).toEqual([]);
	});
});
