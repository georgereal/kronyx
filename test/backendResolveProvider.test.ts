import { describe, expect, it } from "vitest";
import { activeProviderCreds, resolveProvider } from "../backend/src/worker/settings";

type Settings = Parameters<typeof resolveProvider>[0];
const userSettings = (data: Record<string, unknown>, secrets: Record<string, string> = {}): Settings => ({ data, secrets }) as Settings;

const data = {
	activeProfile: "Vercel",
	profiles: [
		{ name: "Vercel", providerId: "vercel-ai-gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", enabled: true, models: [{ id: "anthropic/claude-haiku-5.5" }] },
		{ name: "Openrouter", providerId: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", enabled: true, models: [{ id: "thinkingmachines/inkling-2-mini" }] },
		{ name: "Off", providerId: "openai-compatible", baseUrl: "https://off.example/v1", enabled: false },
	],
};
const secrets = { "profile.apiKey.Vercel": "sk-vercel", "profile.apiKey.Openrouter": "sk-openrouter", "profile.apiKey.Off": "sk-off" };

describe("worker resolveProvider — the job's pick is the only selection", () => {
	it("runs the job's profile and model, never the account's activeProfile", () => {
		const { settings } = resolveProvider(userSettings(data, secrets), { profile: "Openrouter", modelId: "thinkingmachines/inkling-2-mini" });
		expect(settings).toMatchObject({
			profile: "Openrouter",
			providerId: "openai-compatible",
			baseUrl: "https://openrouter.ai/api/v1",
			modelId: "thinkingmachines/inkling-2-mini",
			apiKey: "sk-openrouter",
		});
	});

	it("refuses a job with no profile or model instead of defaulting", () => {
		expect(resolveProvider(userSettings(data, secrets), {}).error).toMatch(/No model selected/);
		expect(resolveProvider(userSettings(data, secrets), { modelId: "anthropic/claude-haiku-5.5" }).error).toMatch(/No model selected/);
		expect(resolveProvider(userSettings(data, secrets), { profile: "Vercel" }).error).toMatch(/No model selected/);
	});

	it("refuses a missing or disabled profile instead of falling back to another", () => {
		expect(resolveProvider(userSettings(data, secrets), { profile: "Gone", modelId: "x" }).error).toMatch(/not configured/);
		expect(resolveProvider(userSettings(data, secrets), { profile: "Off", modelId: "x" }).error).toMatch(/disabled/);
	});

	it("refuses a model not in the profile's catalog", () => {
		expect(resolveProvider(userSettings(data, secrets), { profile: "Vercel", modelId: "thinkingmachines/inkling-2-mini" }).error).toMatch(/not in the "Vercel" catalog/);
	});

	it("never uses the legacy flat provider key when the profile has none", () => {
		const legacy = userSettings({ profiles: [data.profiles[0]] }, { providerApiKey: "sk-flat" });
		expect(resolveProvider(legacy, { profile: "Vercel", modelId: "anthropic/claude-haiku-5.5" }).error).toMatch(/No API key/);
	});
});

describe("activeProviderCreds — account-level calls (embeddings, pricing) use the active profile record", () => {
	it("returns the active profile's base URL and key", () => {
		expect(activeProviderCreds(userSettings(data, secrets))).toEqual({ baseUrl: "https://ai-gateway.vercel.sh/v1", apiKey: "sk-vercel" });
	});

	it("ignores the legacy flat provider fields", () => {
		expect(activeProviderCreds(userSettings({ baseUrl: "https://flat.example/v1", profiles: [] }, { providerApiKey: "sk-flat" }))).toBeUndefined();
	});

	it("returns nothing when the active profile is disabled", () => {
		expect(activeProviderCreds(userSettings({ ...data, activeProfile: "Off" }, secrets))).toBeUndefined();
	});
});
