import { describe, expect, it } from "vitest";
import { chooseTransport } from "../../src/harness/adapters";
import { providerShapes, resolveShape } from "../../src/harness/adapters/apiShapes";

describe("chooseTransport (matrix-driven)", () => {
	const table: Array<[string, Parameters<typeof chooseTransport>[1], boolean]> = [
		// Anthropic serves only cline; explicit OpenAI shapes hard-fail.
		["anthropic", "cline", true],
		["anthropic", "auto", true], // auto resolves to the sole shape (cline)
		["anthropic", "conversations", false],
		["anthropic", "responses", false],
		["anthropic", "chat", false],
		// OpenAI direct serves everything.
		["openai", "cline", true],
		["openai", "auto", true],
		["openai", "conversations", false], // requires direct api.openai.com baseUrl — tested below
		["openai", "responses", true],
		["openai", "chat", true],
		// OpenRouter: responses yes (stateless), conversations no.
		["openrouter", "auto", true],
		["openrouter", "responses", true],
		["openrouter", "chat", true],
		["openrouter", "cline", true],
		["openrouter", "conversations", false],
		// Unknown providers: chat + cline only.
		["some-custom", "auto", true],
		["some-custom", "chat", true],
		["some-custom", "responses", false],
		["some-custom", "conversations", false],
	];
	it.each(table)("provider %s with transport %s is allowed: %s", (provider, transport, allowed) => {
		expect(chooseTransport(provider, transport).ok).toBe(allowed);
	});

	it("hard failure names the supported shapes, never falls back", () => {
		const choice = chooseTransport("openrouter", "conversations");
		expect(choice.ok).toBe(false);
		if (!choice.ok) {
			expect(choice.message).toMatch(/conversations/);
			expect(choice.message).toMatch(/responses/);
			expect(choice.message).toMatch(/chat/);
		}
	});

	it("explicit conversations succeeds on direct api.openai.com", () => {
		expect(chooseTransport("openai", "conversations", "https://api.openai.com/v1").ok).toBe(true);
	});

	it("legacy openai pick behaves as auto", () => {
		expect(chooseTransport("openai", "openai").ok).toBe(true);
		expect(chooseTransport("anthropic", "openai").ok).toBe(true); // resolves to cline
	});
});

describe("resolveShape auto ordering", () => {
	it("direct api.openai.com prefers conversations", () => {
		const r = resolveShape("openai", "https://api.openai.com/v1", "auto");
		expect(r).toMatchObject({ ok: true, shape: "conversations" });
	});
	it("openai via a proxy falls to responses", () => {
		const r = resolveShape("openai", "https://proxy.example.com/v1", "auto");
		expect(r).toMatchObject({ ok: true, shape: "responses" });
	});
	it("openrouter auto resolves to responses", () => {
		const r = resolveShape("openrouter", "https://openrouter.ai/api/v1", "auto");
		expect(r).toMatchObject({ ok: true, shape: "responses" });
	});
	it("vercel auto resolves to responses", () => {
		const r = resolveShape("vercel-ai-gateway", "", "auto");
		expect(r).toMatchObject({ ok: true, shape: "responses" });
	});
	it("anthropic auto resolves to cline", () => {
		const r = resolveShape("anthropic", "", "auto");
		expect(r).toMatchObject({ ok: true, shape: "cline" });
	});
	it("unknown providers auto-resolve to chat", () => {
		const r = resolveShape("custom", "http://localhost:1234/v1", "auto");
		expect(r).toMatchObject({ ok: true, shape: "chat" });
	});
});

describe("shape constraints", () => {
	it("openrouter responses is stateless with a reasoning override", () => {
		const table = providerShapes("openrouter", "https://openrouter.ai/api/v1");
		expect(table.responses?.stateless).toBe(true);
		expect(table.responses?.extras?.("any-model")).toMatchObject({ reasoning: { effort: "medium" } });
	});
	it("qwen3 chat extras opt into thinking; instruct variants do not", () => {
		const table = providerShapes("vercel-ai-gateway", "");
		expect(table.chat?.extras?.("alibaba/qwen3.7-flash")).toMatchObject({ enable_thinking: true });
		expect(table.chat?.extras?.("qwen3-32b-instruct")).toEqual({});
	});
	it("openai reasoning families get summary auto on responses", () => {
		const table = providerShapes("openai", "https://api.openai.com/v1");
		expect(table.responses?.extras?.("gpt-5-mini")).toMatchObject({ reasoning: { summary: "auto" } });
		expect(table.responses?.extras?.("gpt-4o")).toEqual({});
	});
	it("anthropic serves cline only", () => {
		expect(Object.keys(providerShapes("anthropic", ""))).toEqual(["cline"]);
	});
});
