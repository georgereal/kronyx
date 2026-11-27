import { describe, expect, it } from "vitest";
import { chooseTransport } from "../../src/harness/adapters";

describe("chooseTransport", () => {
	const table: Array<[string, "cline" | "openai" | "conversations" | "responses", boolean]> = [
		["anthropic", "cline", true],
		["anthropic", "openai", false],
		["anthropic", "conversations", false],
		["anthropic", "responses", false],
		["openai", "cline", true],
		["openai", "openai", true],
		["openai", "conversations", true],
		["openai", "responses", true],
		["openrouter", "openai", true],
		["openrouter", "conversations", true],
		["openrouter", "responses", true],
		["openrouter", "cline", true],
	];
	it.each(table)("provider %s with transport %s is allowed: %s", (provider, transport, allowed) => {
		expect(chooseTransport(provider, transport).ok).toBe(allowed);
	});

	it("explains the refusal for Anthropic on the OpenAI transport", () => {
		const choice = chooseTransport("anthropic", "openai");
		expect(choice).toMatchObject({ ok: false });
		expect(choice.ok === false && choice.message).toMatch(/Cline SDK/);
	});
});
