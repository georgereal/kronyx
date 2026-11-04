import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProviderKey, providerKeyToField, refreshUserConfig, saveUserConfig, seedUserConfig, userConfig, userConfigPath } from "../src/userConfig";

let dir = "";

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "kronyx-cfg-"));
	process.env.KRONYX_CONFIG_DIR = dir;
	await refreshUserConfig();
});

afterEach(async () => {
	delete process.env.KRONYX_CONFIG_DIR;
	await fs.rm(dir, { recursive: true, force: true });
});

describe("userConfig", () => {
	it("round-trips a saved provider config", async () => {
		await saveUserConfig({ providerId: "openrouter", baseUrl: "https://x/v1", modelId: "m1" });
		const cfg = await refreshUserConfig();
		expect(cfg.providerId).toBe("openrouter");
		expect(cfg.modelId).toBe("m1");
		const onDisk = JSON.parse(await fs.readFile(userConfigPath(), "utf8"));
		expect(onDisk.baseUrl).toBe("https://x/v1");
	});

	it("merges patches without losing fields", async () => {
		await saveUserConfig({ providerId: "p1" });
		await saveUserConfig({ modelId: "m2" });
		expect(userConfig().providerId).toBe("p1");
		expect(userConfig().modelId).toBe("m2");
	});

	it("returns empty config for missing/corrupt files", async () => {
		expect((await refreshUserConfig()).providerId).toBeUndefined();
		await fs.writeFile(userConfigPath(), "{bad json");
		expect((await refreshUserConfig()).modelId).toBeUndefined();
	});

	it("seeds only into an empty config", async () => {
		await seedUserConfig({ providerId: "seeded", profiles: [{ name: "a" }] });
		expect(userConfig().providerId).toBe("seeded");
		await seedUserConfig({ providerId: "overwritten" });
		expect(userConfig().providerId).toBe("seeded");
	});

	it("maps provider keys to fields", () => {
		expect(isProviderKey("provider.profiles")).toBe(true);
		expect(isProviderKey("agent.maxIterations")).toBe(false);
		expect(providerKeyToField("provider.profile")).toBe("activeProfile");
	});
});
