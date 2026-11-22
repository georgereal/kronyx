import type { ProviderSettings } from "./agent/runner";

/** The composer's model pick: the only selection a run may use. */
export interface ModelSelection {
	profile: string;
	modelId: string;
}

/** A saved provider profile, as far as selection needs it. */
export interface SelectableProfile {
	name: string;
	providerId?: string;
	baseUrl?: string;
	enabled?: boolean;
	models?: { id: string; contextWindow?: number }[];
}

/** Typed error describing why the selected provider and model can't run. */
export type ProviderError =
	| { reason: "no-selection" }
	| { reason: "no-profile"; provider: string }
	| { reason: "profile-disabled"; provider: string }
	| { reason: "missing-field"; provider: string; field: string }
	| { reason: "model-not-in-catalog"; provider: string; modelId: string }
	| { reason: "no-api-key"; provider: string };

export function providerErrorMessage(err: ProviderError): string {
	switch (err.reason) {
		case "no-selection":
			return "No model selected — pick a provider and model in the composer before running.";
		case "no-profile":
			return `Provider "${err.provider}" is not configured — add it in Settings → Provider.`;
		case "profile-disabled":
			return `Provider "${err.provider}" is disabled — enable it in Settings → Provider.`;
		case "missing-field":
			return `Provider "${err.provider}" is missing ${err.field} — complete it in Settings → Provider.`;
		case "model-not-in-catalog":
			return `Model "${err.modelId}" is not in the "${err.provider}" catalog — refresh its models or pick again.`;
		case "no-api-key":
			return `No API key for provider "${err.provider}" — set it in Settings → Provider.`;
	}
}

/**
 * Resolve the runnable config for exactly the selected provider and model.
 * No fallbacks: a missing or disabled provider, an incomplete profile, a model
 * its catalog doesn't list, or a missing key is a hard error.
 */
export async function selectProvider(
	profiles: SelectableProfile[],
	selection: ModelSelection | undefined,
	apiKeyOf: (profile: string) => Promise<string>,
	maxIterations: number,
): Promise<{ settings?: ProviderSettings; error?: ProviderError }> {
	if (!selection?.profile || !selection.modelId) return { error: { reason: "no-selection" } };
	const { profile: name, modelId } = selection;
	const profile = profiles.find((p) => p.name === name);
	if (!profile) return { error: { reason: "no-profile", provider: name } };
	if (profile.enabled === false) return { error: { reason: "profile-disabled", provider: name } };
	const field = !profile.providerId ? "providerId" : !profile.baseUrl ? "baseUrl" : "";
	if (field) return { error: { reason: "missing-field", provider: name, field } };
	const known = profile.models?.find((m) => m.id === modelId);
	if (profile.models?.length && !known) return { error: { reason: "model-not-in-catalog", provider: name, modelId } };
	const apiKey = await apiKeyOf(name);
	if (!apiKey) return { error: { reason: "no-api-key", provider: name } };
	return {
		settings: {
			providerId: profile.providerId!,
			baseUrl: profile.baseUrl!,
			modelId,
			profile: name,
			maxIterations,
			apiKey,
			contextWindow: known?.contextWindow,
		},
	};
}
