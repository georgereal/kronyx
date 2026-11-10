import type { Db } from "mongodb";
import type { ProviderSettings } from "../../../src/agent/runner";
import { getCache } from "./cache";

export interface UserSettings {
	data: Record<string, unknown>;
	secrets: Record<string, string>;
}

interface Profile {
	name?: string;
	providerId?: string;
	baseUrl?: string;
	modelId?: string;
}

/** Read users/{uid}.settings — BYOK profiles + secrets synced from the editors/web. */
export async function loadUserSettings(db: Db, uid: string): Promise<UserSettings> {
	const cache = await getCache();
	const key = `settings:${uid}`;
	const hit = (await cache.get(key)) as UserSettings | undefined;
	if (hit) return hit;
	const doc = await db
		.collection<{ settings?: { data?: Record<string, unknown>; secrets?: Record<string, string> } }>("users")
		.findOne({ _id: uid as never });
	const out = { data: doc?.settings?.data ?? {}, secrets: doc?.settings?.secrets ?? {} };
	await cache.set(key, out, 5 * 60_000);
	return out;
}

function profileKey(secrets: Record<string, string>, name: string): string {
	// Extension pushes bare profile names; the web settings page writes profile.apiKey.<name>.
	return secrets[`profile.apiKey.${name}`] ?? secrets[name] ?? "";
}

/**
 * Resolve the runnable provider for a job. Job-level profile/model win;
 * otherwise the user's activeProfile, else the first profile, else the flat
 * provider.* fields. Mirrors resolveProvider() in src/config.ts.
 */
export function resolveProvider(
	settings: UserSettings,
	job: { profile?: string; modelId?: string },
): { settings?: ProviderSettings; error?: string } {
	const profiles = (settings.data.profiles as Profile[] | undefined) ?? [];
	const name = job.profile ?? (settings.data.activeProfile as string | undefined) ?? profiles[0]?.name;
	const profile = name ? profiles.find((p) => p.name === name) : undefined;
	if (profiles.length > 0 && !profile) {
		return { error: `No provider profile "${name}" — configure one in Settings → Provider.` };
	}
	const providerId = profile?.providerId ?? (settings.data.providerId as string | undefined) ?? "openai-compatible";
	const baseUrl = profile?.baseUrl ?? (settings.data.baseUrl as string | undefined) ?? "";
	const modelId = job.modelId ?? profile?.modelId ?? (settings.data.modelId as string | undefined) ?? "";
	const apiKey = profile?.name ? profileKey(settings.secrets, profile.name) : (settings.secrets.providerApiKey ?? "");
	if (!baseUrl) return { error: "Provider is missing a base URL — complete it in Settings → Provider." };
	if (!modelId) return { error: "No model selected — pick one in the composer or Settings → Provider." };
	if (!apiKey) return { error: `No API key for provider "${name ?? "default"}" — set it in Settings → Provider.` };
	return {
		settings: {
			providerId,
			baseUrl,
			modelId,
			apiKey,
			profile: name,
			maxIterations: Number(settings.data.agentMaxIterations) || 300,
		},
	};
}

export function e2bApiKey(settings: UserSettings): string {
	return settings.secrets.e2bApiKey ?? process.env.E2B_API_KEY ?? "";
}

export function githubPat(settings: UserSettings): string {
	return settings.secrets.githubToken ?? "";
}
