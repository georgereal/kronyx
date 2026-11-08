import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderProfile } from "./config";

/** User-level provider config shared across every VS Code/Devin window and profile. */
export interface UserProviderConfig {
	providerId?: string;
	baseUrl?: string;
	modelId?: string;
	profiles?: ProviderProfile[];
	activeProfile?: string;
}

let cached: UserProviderConfig | undefined;

export function userConfigDir(): string {
	return process.env.KRONYX_CONFIG_DIR || path.join(os.homedir(), ".kronyx");
}

export function userConfigPath(): string {
	return path.join(userConfigDir(), "config.json");
}

export async function refreshUserConfig(): Promise<UserProviderConfig> {
	try {
		cached = JSON.parse(await fs.readFile(userConfigPath(), "utf8")) as UserProviderConfig;
	} catch {
		cached = {};
	}
	return cached;
}

/** Synchronous view of the shared config — call `refreshUserConfig` once at activation. */
export function userConfig(): UserProviderConfig {
	return cached ?? {};
}

/** Fired after every saveUserConfig write — extension wires this to settings sync. */
export let onUserConfigSaved: (() => void) | undefined;
export function setUserConfigSavedListener(fn: () => void): void {
	onUserConfigSaved = fn;
}

export async function saveUserConfig(patch: UserProviderConfig): Promise<void> {
	const base = await refreshUserConfig();
	cached = { ...base, ...patch };
	await fs.mkdir(userConfigDir(), { recursive: true });
	const tmp = `${userConfigPath()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(cached, null, 2));
	await fs.rename(tmp, userConfigPath());
	onUserConfigSaved?.();
}

/** Seed the shared file from existing settings values (called once at activation). */
export async function seedUserConfig(values: UserProviderConfig): Promise<void> {
	const existing = await refreshUserConfig();
	if (Object.keys(existing).length > 0) return;
	if (!values.profiles?.length && !values.providerId && !values.baseUrl) return;
	await saveUserConfig(Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== "")));
}

const PROVIDER_KEYS = new Set(["provider.id", "provider.baseUrl", "provider.modelId", "provider.profile", "provider.profiles"]);
export function isProviderKey(key: string): boolean {
	return PROVIDER_KEYS.has(key);
}

export function providerKeyToField(key: string): keyof UserProviderConfig {
	return (
		{ "provider.id": "providerId", "provider.baseUrl": "baseUrl", "provider.modelId": "modelId", "provider.profile": "activeProfile", "provider.profiles": "profiles" } as const
	)[key] as keyof UserProviderConfig;
}
