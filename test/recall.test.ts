import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentToolContext } from "@cline/shared";
import { createRecallTool } from "../src/agent/recall";

let seq = 0;
const msg = (role: AgentMessage["role"], content: AgentMessage["content"]): AgentMessage => ({
	id: `m${++seq}`,
	role,
	content,
	createdAt: seq,
});

const transcript: AgentMessage[] = [
	msg("assistant", [{ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.ts" } }]),
	msg("tool", [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: "FULL-OUTPUT-xyz" }]),
	msg("assistant", [{ type: "text", text: "I looked at the tokenizer code" }]),
];

const ctxWith = (messages: AgentMessage[]) =>
	({ agentId: "t", iteration: 1, snapshot: { messages } }) as unknown as AgentToolContext;

describe("recall_context", () => {
	const tool = createRecallTool({ priorTranscripts: () => [{ label: "run 1", messages: transcript }] });

	it("fetches a stubbed tool result by toolCallId", async () => {
		const out = await Promise.resolve(tool.execute({ toolCallId: "c1" }, ctxWith(transcript)));
		expect(out).toContain("FULL-OUTPUT-xyz");
	});

	it("reports unknown toolCallId", async () => {
		const out = await Promise.resolve(tool.execute({ toolCallId: "nope" }, ctxWith(transcript)));
		expect(out).toContain("No tool result");
	});

	it("keyword-searches the transcript", async () => {
		const out = await Promise.resolve(tool.execute({ query: "tokenizer" }, ctxWith(transcript)));
		expect(out).toContain("tokenizer code");
	});

	it("searches a prior run transcript via runIndex", async () => {
		const out = await Promise.resolve(tool.execute({ toolCallId: "c1", runIndex: 0 }, ctxWith([])));
		expect(out).toContain("FULL-OUTPUT-xyz");
	});
});
