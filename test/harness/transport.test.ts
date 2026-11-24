import { describe, expect, it } from "vitest";
import { chooseTransport } from "../../src/harness/transport";

describe("chooseTransport", () => {
	const table: Array<[string, "cline" | "openai", boolean]> = [
		["anthropic", "cline", true],
		["anthropic", "openai", false],
		["openai", "cline", true],
		["openai", "openai", true],
		["openrouter", "openai", true],
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
