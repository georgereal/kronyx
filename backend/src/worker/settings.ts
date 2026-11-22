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
	enabled?: boolean;
	models?: { id: string }[];
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
 * Resolve the runnable provider for a job. The job's own profile and model are
 * the only selection: no fallback to the active profile, other profiles, or the
 * flat provider.* fields. Mirrors resolveProvider() in src/config.ts.
 */
export function resolveProvider(
	settings: UserSettings,
	job: { profile?: string; modelId?: string },
): { settings?: ProviderSettings; error?: string } {
	if (!job.profile || !job.modelId) return { error: "No model selected — pick a provider and model in the composer." };
	const profile = ((settings.data.profiles as Profile[] | undefined) ?? []).find((p) => p.name === job.profile);
	if (!profile) return { error: `Provider "${job.profile}" is not configured — add it in Settings → Provider.` };
	if (profile.enabled === false) return { error: `Provider "${job.profile}" is disabled — enable it in Settings.` };
	if (!profile.providerId || !profile.baseUrl) return { error: `Provider "${job.profile}" is missing its provider id or base URL — complete it in Settings → Provider.` };
	if (profile.models?.length && !profile.models.some((m) => m.id === job.modelId))
		return { error: `Model "${job.modelId}" is not in the "${job.profile}" catalog — refresh its models or pick again.` };
	const apiKey = profileKey(settings.secrets, profile.name ?? job.profile);
	if (!apiKey) return { error: `No API key for provider "${job.profile}" — set it in Settings → Provider.` };
	return {
		settings: {
			providerId: profile.providerId,
			baseUrl: profile.baseUrl,
			modelId: job.modelId,
			apiKey,
			profile: job.profile,
			maxIterations: Number(settings.data.agentMaxIterations) || 300,
		},
	};
}

/** Credentials of the account's active provider profile, for account-level calls that aren't runs (embeddings, pricing). */
export function activeProviderCreds(settings: UserSettings): { baseUrl: string; apiKey: string } | undefined {
	const profiles = (settings.data.profiles as Profile[] | undefined) ?? [];
	const profile = profiles.find((p) => p.name === settings.data.activeProfile && p.enabled !== false);
	if (!profile?.name || !profile.baseUrl) return undefined;
	const apiKey = profileKey(settings.secrets, profile.name);
	return apiKey ? { baseUrl: profile.baseUrl, apiKey } : undefined;
}

export function e2bApiKey(settings: UserSettings): string {
	return settings.secrets.e2bApiKey ?? process.env.E2B_API_KEY ?? "";
}

export function githubPat(settings: UserSettings): string {
	return settings.secrets.githubToken ?? "";
}
