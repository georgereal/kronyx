import { describe, expect, it } from "vitest";
import { legacyTranscriptContext } from "../../src/harness/agentEngine";
import type { RunnerHost } from "../../src/agent/types";

function host(messages?: unknown[]): RunnerHost {
	return {
		workspaceRoot: "/repo",
		isDirty: () => false,
		relativePath: (p) => p,
		currentMode: () => "smart",
		emit: () => undefined,
		resume: { resumeLog: async () => messages as never },
	};
}

describe("legacyTranscriptContext", () => {
	it("is absent when there is no legacy transcript", async () => {
		await expect(legacyTranscriptContext(host(undefined))).resolves.toBeUndefined();
	});

	it("renders bounded migration context from legacy messages", async () => {
		const text = await legacyTranscriptContext(
			host([
				{ id: "u1", role: "user", createdAt: 0, content: [{ type: "text", text: "fix the failing test" }] },
				{
					id: "a1",
					role: "assistant",
					createdAt: 1,
					content: [{ type: "tool-call", toolCallId: "c1", toolName: "run_command", input: { command: "npm test" } }],
				},
				{ id: "t1", role: "tool", createdAt: 2, content: [{ type: "tool-result", toolCallId: "c1", toolName: "run_command", output: "1 failing", isError: true }] },
			]),
		);
		expect(text).toContain("Pre-harness execution transcript migration");
		expect(text).toContain("fix the failing test");
		expect(text).toContain("tool-call run_command");
		expect(text).toContain("tool-result run_command (error): 1 failing");
	});
});
