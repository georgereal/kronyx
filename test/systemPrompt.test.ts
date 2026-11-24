import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/systemPrompt";

describe("buildSystemPrompt host awareness", () => {
	it("cites only the tools the run exposes", () => {
		const prompt = buildSystemPrompt("/ws", "code", "", "the user's VS Code workspace", "", new Set(["read_file", "fetch_url", "browser_open", "browser_snapshot"]));
		expect(prompt).toContain("Deferred tools (fetch_url) are reached through the use_tool dispatcher");
		expect(prompt).not.toContain("browser_use");
		expect(prompt).not.toContain("start_process");
		expect(prompt).not.toContain("memory_write");
		expect(prompt).toContain("open it with browser_open");
		expect(prompt).toContain("start the app with run_command in the background");
	});

	it("names the full toolset when no availability set is given", () => {
		const prompt = buildSystemPrompt("/ws");
		expect(prompt).toContain("start_process");
		expect(prompt).toContain("memory_write");
		expect(prompt).toContain("Deferred tools (fetch_url, browser_use, switch_environment)");
	});

	it("drops memory_write and the browser rule when the run has neither", () => {
		const prompt = buildSystemPrompt("/ws", "ask", "", "x", "", new Set(["read_file"]));
		expect(prompt).toContain("mention it in your final summary");
		expect(prompt).toContain("verify it with curl or the test suite instead");
		expect(prompt).not.toContain("8c.");
	});
});
