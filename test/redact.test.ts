import { describe, expect, it } from "vitest";
import type { AgentTool } from "@cline/shared";
import { assembleToolSet } from "../src/agent/toolSet";
import type { AgentMode, ProviderSettings, RunnerHost } from "../src/agent/runner";
import { redactForModel } from "../src/tools/redact";

describe("redactForModel", () => {
	it("masks known secret values, longest first, and skips trivially short values", () => {
		const out = redactForModel("token=hunter2hunter2 short=ab again=hunter2hunter2 seven=hunter2", ["hunter2hunter2", "ab", "hunter2"]);
		expect(out).toBe("token=[redacted] short=ab again=[redacted] seven=hunter2");
	});

	it("masks credential-shaped strings without a known value", () => {
		const gh = "ghp_" + "a".repeat(36);
		const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
		const out = redactForModel(`${gh} ${aws} ${pem} ${jwt} plain text`);
		expect(out).not.toContain(gh);
		expect(out).not.toContain(aws);
		expect(out).not.toContain("MIIEow");
		expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(out).toContain("plain text");
	});
});

describe("assembleToolSet result redaction", () => {
	const settings: ProviderSettings = { providerId: "openai", baseUrl: "https://x.test/v1", modelId: "m", apiKey: "k", maxIterations: 3 };
	const leaky: AgentTool<any, string> = {
		name: "read_file",
		description: "leaky",
		inputSchema: { type: "object", properties: {} },
		executionMode: "sequential",
		execute: async () => "exit 0\nMONGODB=mongodb+srv://u:supersecretvalue@db",
	};
	const host = (mode: AgentMode): RunnerHost => ({
		workspaceRoot: "/tmp/ws",
		isDirty: () => false,
		relativePath: (p) => p,
		currentMode: () => mode,
		emit: () => {},
		tools: async () => [leaky],
		ideTools: true,
		secretValues: () => ["supersecretvalue"],
	});

	it("scrubs tool output before it reaches the model, for every mode", async () => {
		for (const mode of ["code", "ask"] as const) {
			const { tools } = await assembleToolSet(host(mode), settings, "t", () => {});
			const out = await tools.find((t) => t.name === "read_file")!.execute!({}, {} as never);
			expect(out).not.toContain("supersecretvalue");
			expect(out).toContain("[redacted]");
		}
	});
});
