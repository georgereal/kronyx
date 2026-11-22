import { describe, expect, it } from "vitest";
import { selectProvider, type SelectableProfile } from "../src/providerSelection";

const profiles: SelectableProfile[] = [
	{ name: "Vercel", providerId: "vercel-ai-gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", models: [{ id: "anthropic/claude-haiku-5.5", contextWindow: 200000 }] },
	{ name: "Openrouter", providerId: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "thinkingmachines/inkling-2-mini" }] },
	{ name: "Off", providerId: "openai-compatible", baseUrl: "https://off.example/v1", enabled: false },
	{ name: "Bare", providerId: "openai-compatible", baseUrl: "" },
	{ name: "Fresh", providerId: "openai-compatible", baseUrl: "https://fresh.example/v1" },
];
const withKey = async () => "sk-test";
const run = (selection: Parameters<typeof selectProvider>[1], apiKeyOf = withKey) => selectProvider(profiles, selection, apiKeyOf, 40);

describe("selectProvider — the composer's pick is the only selection", () => {
	it("runs exactly the selected profile and model", async () => {
		const { settings } = await run({ profile: "Openrouter", modelId: "thinkingmachines/inkling-2-mini" });
		expect(settings).toMatchObject({
			providerId: "openai-compatible",
			baseUrl: "https://openrouter.ai/api/v1",
			modelId: "thinkingmachines/inkling-2-mini",
			profile: "Openrouter",
		});
	});

	it("refuses to run without a complete selection instead of using the active profile", async () => {
		expect((await run(undefined)).error).toEqual({ reason: "no-selection" });
		expect((await run({ profile: "Vercel", modelId: "" })).error).toEqual({ reason: "no-selection" });
		expect((await run({ profile: "", modelId: "anthropic/claude-haiku-5.5" })).error).toEqual({ reason: "no-selection" });
	});

	it("refuses an unknown or disabled profile rather than substituting another", async () => {
		expect((await run({ profile: "Gone", modelId: "x" })).error).toEqual({ reason: "no-profile", provider: "Gone" });
		expect((await run({ profile: "Off", modelId: "x" })).error).toEqual({ reason: "profile-disabled", provider: "Off" });
	});

	it("refuses an incomplete profile", async () => {
		expect((await run({ profile: "Bare", modelId: "x" })).error).toEqual({ reason: "missing-field", provider: "Bare", field: "baseUrl" });
	});

	it("refuses a model the selected profile's catalog does not list", async () => {
		expect((await run({ profile: "Vercel", modelId: "thinkingmachines/inkling-2-mini" })).error).toEqual({
			reason: "model-not-in-catalog",
			provider: "Vercel",
			modelId: "thinkingmachines/inkling-2-mini",
		});
	});

	it("accepts any model when the profile's catalog has not been loaded", async () => {
		const { settings } = await selectProvider(profiles, { profile: "Fresh", modelId: "any/model" }, withKey, 40);
		expect(settings?.modelId).toBe("any/model");
	});

	it("refuses a missing API key", async () => {
		expect((await run({ profile: "Vercel", modelId: "anthropic/claude-haiku-5.5" }, async () => "")).error).toEqual({
			reason: "no-api-key",
			provider: "Vercel",
		});
	});

	it("carries the context window of the selected model only", async () => {
		expect((await run({ profile: "Vercel", modelId: "anthropic/claude-haiku-5.5" })).settings?.contextWindow).toBe(200000);
		expect((await run({ profile: "Openrouter", modelId: "thinkingmachines/inkling-2-mini" })).settings?.contextWindow).toBeUndefined();
	});
});
