import * as vscode from "vscode";
import { log } from "./log";
import type { ProviderSettings } from "./agent/runner";
import { isProviderKey, providerKeyToField, saveUserConfig, userConfig, type UserProviderConfig } from "./userConfig";
import { selectProvider, type ModelSelection, type ProviderError } from "./providerSelection";

export { providerErrorMessage, type ProviderError } from "./providerSelection";

const API_KEY_SECRET = "kronyx.provider.apiKey";

export interface ProviderProfile {
	name: string;
	providerId?: string;
	baseUrl?: string;
	modelId?: string;
	enabled?: boolean;
	/** Last fetched model catalog, persisted so the Models page renders without re-fetching. */
	models?: ModelOption[];
	modelsFetchedAt?: number;
}

/** A provider profile's model catalog, as shown by the composer's provider filter. */
export interface ProfileCatalog {
	profile: string;
	active: boolean;
	models: ModelOption[];
}

export function profiles(): ProviderProfile[] {
	// ~/.kronyx/config.json is the single source for saved providers.
	return userConfig().profiles ?? [];
}

export function activeProfile(): ProviderProfile | undefined {
	const name = userConfig().activeProfile;
	return name ? profiles().find((p) => p.name === name) : undefined;
}

/** The pick saved in ~/.kronyx/config.json; undefined until the user chooses a model. */
export function currentSelection(): ModelSelection | undefined {
	const { modelProfile, modelId } = userConfig();
	return modelProfile && modelId ? { profile: modelProfile, modelId } : undefined;
}

/** Resolve the runnable config for the composer's pick (or an explicit selection). Strict: see selectProvider. */
export async function resolveProvider(
	secrets: vscode.SecretStorage,
	selection = currentSelection(),
): Promise<{ settings?: ProviderSettings; error?: ProviderError }> {
	const maxIterations = vscode.workspace.getConfiguration("kronyx").get<number>("agent.maxIterations", 300);
	return selectProvider(profiles(), selection, (name) => profileApiKey(secrets, name), maxIterations);
}

/**
 * Record the composer's pick: the model and the provider profile it belongs to.
 * This pair is the only selection runs use; the Settings default (activeProfile) is untouched.
 */
export async function pickModel(modelId: string, profile: string): Promise<void> {
	await vscode.workspace.getConfiguration("kronyx").update("provider.modelId", modelId, vscode.ConfigurationTarget.Global);
	await saveUserConfig({ modelId, modelProfile: profile });
}

/** Catalog for every enabled profile: cached per profile, fetched when missing, stale, or forced. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export async function profileCatalogs(secrets: vscode.SecretStorage, force: boolean): Promise<ProfileCatalog[]> {
	const list = profiles();
	const active = userConfig().activeProfile;
	const results = await Promise.all(
		list
			.filter((p) => p.enabled !== false && p.baseUrl)
			.map(async (p) => {
				const stale = !p.modelsFetchedAt || Date.now() - p.modelsFetchedAt > CATALOG_TTL_MS;
				if (!force && p.models?.length && !stale) return { name: p.name, models: p.models, fetched: false };
				const { models, error } = await fetchModelCatalog({ baseUrl: p.baseUrl!, apiKey: await profileApiKey(secrets, p.name) });
				if (error) log("models", `${p.name}: ${error}`);
				return { name: p.name, models: models.length ? models : (p.models ?? []), fetched: models.length > 0 };
			}),
	);
	const fresh = new Map(results.filter((r) => r.fetched).map((r) => [r.name, r.models]));
	if (fresh.size) {
		await saveUserConfig({ profiles: list.map((p) => (fresh.has(p.name) ? { ...p, models: fresh.get(p.name), modelsFetchedAt: Date.now() } : p)) });
	}
	return results.map((r) => ({ profile: r.name, active: r.name === active, models: r.models }));
}

/** Write a provider-related value to the shared user config; other keys stay in VS Code settings. */
export async function writeProviderValue(key: string, value: unknown): Promise<boolean> {
	if (!isProviderKey(key)) return false;
	const field = providerKeyToField(key);
	await saveUserConfig({ [field]: value } as UserProviderConfig);
	// Picking a model from the composer also pins it on the active provider profile.
	if (key === "provider.modelId" && typeof value === "string") {
		const list = profiles();
		const name = userConfig().activeProfile;
		const profile = name ? list.find((p) => p.name === name) : undefined;
		if (profile) {
			profile.modelId = value;
			await saveUserConfig({ profiles: list });
		}
	}
	return true;
}

const profileSecret = (name: string) => `kronyx.profile.apiKey.${name}`;

export async function profileApiKey(secrets: vscode.SecretStorage, name: string): Promise<string> {
	return sanitizeApiKey((await secrets.get(profileSecret(name))) ?? "");
}

/** Strip whitespace and non-ASCII junk (copy-paste artifacts) from a stored API key. */
function sanitizeApiKey(key: string): string {
	const clean = key.trim();
	if (/^[\x20-\x7E]*$/.test(clean)) return clean;
	const stripped = clean.replace(/[^\x21-\x7E]/g, "");
	if (stripped) {
		log("config", "stored API key contained non-ASCII characters — they were stripped; re-set the key if auth fails");
		return stripped;
	}
	return clean;
}

export async function promptForProfileKey(secrets: vscode.SecretStorage, name: string): Promise<boolean> {
	const entered = await vscode.window.showInputBox({
		title: `Kronyx: API key for "${name}"`,
		password: true,
		ignoreFocusOut: true,
	});
	if (!entered) return false;
	await secrets.store(profileSecret(name), sanitizeApiKey(entered));
	return true;
}

export async function clearProfileKey(secrets: vscode.SecretStorage, name: string): Promise<void> {
	await secrets.delete(profileSecret(name));
}

/** Migrate a stored profile key to a new profile name (rename-safe). */
export async function renameProfileKey(secrets: vscode.SecretStorage, oldName: string, newName: string): Promise<void> {
	const key = await secrets.get(profileSecret(oldName));
	if (key) {
		await secrets.store(profileSecret(newName), key);
		await secrets.delete(profileSecret(oldName));
	}
}

/** Settings for non-run reads (model list, indexing) — the same strict selection as runs. */
export async function readProviderSettings(secrets: vscode.SecretStorage): Promise<ProviderSettings | undefined> {
	return (await resolveProvider(secrets)).settings;
}

export function autoApproveWrites(): boolean {
	return vscode.workspace.getConfiguration("kronyx").get<boolean>("approval.autoApproveWrites", false);
}

/** Private hosts the fetch and browser tools may reach (kronyx.network.allowHosts). */
export function networkAllowHosts(): string[] {
	return vscode.workspace.getConfiguration("kronyx").get<string[]>("network.allowHosts", []);
}

export function planDir(): string {
	return vscode.workspace.getConfiguration("kronyx").get<string>("agent.planDir", ".kronyx/plans");
}

export function implementPrompt(path: string): string {
	const template = vscode.workspace
		.getConfiguration("kronyx")
		.get<string>("agent.implementPrompt", "Implement the plan in `{path}`. Read it first and follow it step by step.");
	return template.replace("{path}", path);
}

export interface ModelOption {
	id: string;
	label?: string;
	description?: string;
	contextWindow?: number;
	maxTokens?: number;
	tags?: string[];
	modalities?: { input?: string[]; output?: string[] };
	/** USD per token, as reported by the provider. */
	pricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	owner?: string;
	releasedAt?: number;
	knowledgeCutoff?: string;
	supportedParameters?: string[];
	reasoning?: string[];
}

/** Per-token USD pricing for a model, from the profile's cached catalog or configured models. */
export function modelPricing(
	modelId: string,
	profile?: ProviderProfile,
): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined {
	return (
		profile?.models?.find((m) => m.id === modelId)?.pricing ??
		configuredModels().find((m) => m.id === modelId)?.pricing ??
		profiles().flatMap((p) => p.models ?? []).find((m) => m.id === modelId)?.pricing
	);
}

export type ModelPricing = NonNullable<ReturnType<typeof modelPricing>>;

/** Estimated USD cost from catalog pricing (per-token). Undefined when pricing is unknown. */
export function estimateCostUsd(
	delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
	pricing: ModelPricing | undefined,
): number | undefined {
	if (!pricing) return undefined;
	const { input, output, cacheRead, cacheWrite } = pricing;
	if ([input, output, cacheRead, cacheWrite].every((v) => v === undefined)) return undefined;
	return (
		(delta.inputTokens ?? 0) * (input ?? 0) +
		(delta.outputTokens ?? 0) * (output ?? 0) +
		(delta.cacheReadTokens ?? 0) * (cacheRead ?? input ?? 0) +
		(delta.cacheWriteTokens ?? 0) * (cacheWrite ?? input ?? 0)
	);
}

export function configuredModels(): ModelOption[] {
	return vscode.workspace.getConfiguration("kronyx").get<ModelOption[]>("provider.models", []);
}

const num = (v: unknown): number | undefined => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};
const strArr = (v: unknown): string[] | undefined =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** Normalize one entry of a `/models` response (Vercel AI Gateway / OpenRouter / plain OpenAI shapes). */
function toModelOption(m: Record<string, unknown>): ModelOption | undefined {
	if (typeof m?.id !== "string" || m.id.length === 0) return undefined;
	const pricing = m.pricing as Record<string, unknown> | undefined;
	const modalities = m.modalities as Record<string, unknown> | undefined;
	const arch = m.architecture as Record<string, unknown> | undefined;
	const topProvider = m.top_provider as Record<string, unknown> | undefined;
	const opt: ModelOption = { id: m.id };
	opt.label = typeof m.name === "string" && m.name !== m.id ? m.name : undefined;
	opt.description = typeof m.description === "string" ? m.description : undefined;
	opt.contextWindow = num(m.context_window) ?? num(m.context_length) ?? num(topProvider?.context_length);
	opt.maxTokens = num(m.max_tokens) ?? num(m.max_completion_tokens) ?? num(topProvider?.max_completion_tokens);
	opt.tags = strArr(m.tags);
	const input = strArr(modalities?.input) ?? strArr(arch?.input_modalities);
	const output = strArr(modalities?.output) ?? strArr(arch?.output_modalities);
	opt.modalities = input || output ? { input, output } : undefined;
	const inPrice = num(pricing?.input) ?? num(pricing?.prompt);
	const outPrice = num(pricing?.output) ?? num(pricing?.completion);
	const cacheRead = num(pricing?.cache_read) ?? num(pricing?.input_cache_read) ?? num(pricing?.cached_input);
	const cacheWrite = num(pricing?.cache_write) ?? num(pricing?.input_cache_write);
	opt.pricing =
		inPrice !== undefined || outPrice !== undefined || cacheRead !== undefined || cacheWrite !== undefined
			? { input: inPrice, output: outPrice, cacheRead, cacheWrite }
			: undefined;
	opt.owner = typeof m.owned_by === "string" ? m.owned_by : undefined;
	opt.releasedAt = num(m.released) ?? num(m.created);
	opt.knowledgeCutoff = typeof m.knowledge === "string" ? m.knowledge : undefined;
	opt.supportedParameters = strArr(m.supported_parameters);
	const reasoning = m.reasoning_options;
	if (Array.isArray(reasoning)) {
		opt.reasoning = reasoning
			.map((r) => (typeof r === "string" ? r : typeof (r as Record<string, unknown>)?.type === "string" ? (r as Record<string, string>).type : undefined))
			.filter((x): x is string => typeof x === "string");
	}
	return opt;
}

export interface ModelCatalog {
	models: ModelOption[];
	error?: string;
}

/**
 * Fetch the model catalog from an OpenAI-compatible `GET {baseUrl}/models`.
 * Many gateways (e.g. Vercel AI Gateway) serve this endpoint without a key.
 */
export async function fetchModelCatalog(settings: Pick<ProviderSettings, "baseUrl" | "apiKey">): Promise<ModelCatalog> {
	const base = settings.baseUrl.replace(/\/+$/, "");
	// Header values must be Latin-1 ByteStrings; a key with stray Unicode (e.g. an
	// em-dash from copy-paste) makes fetch throw before the request is sent.
	const apiKey = settings.apiKey.trim();
	const headerKey = /^[\x20-\x7E]*$/.test(apiKey) ? apiKey : "";
	if (apiKey && !headerKey) {
		log("models", "stored API key contains non-ASCII characters (copy-paste artifact?) — sending request without it");
	}
	try {
		const response = await fetch(`${base}/models`, {
			headers: headerKey ? { Authorization: `Bearer ${headerKey}` } : {},
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return { models: [], error: `HTTP ${response.status} ${response.statusText}` };
		const body = (await response.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
		const list = body.data ?? body.models ?? [];
		const models = list.map(toModelOption).filter((m): m is ModelOption => m !== undefined);
		const seen = new Set<string>();
		const unique = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
		return unique.length > 0 ? { models: unique } : { models: [], error: "Endpoint returned no models" };
	} catch (e) {
		return { models: [], error: e instanceof Error ? e.message : String(e) };
	}
}

/** Fetch the model list; returns an empty array on any failure so callers can fall back to settings. */
export async function fetchModels(settings: ProviderSettings): Promise<ModelOption[]> {
	return (await fetchModelCatalog(settings)).models;
}

export async function promptForApiKey(secrets: vscode.SecretStorage): Promise<boolean> {
	const value = await vscode.window.showInputBox({
		title: "Kronyx: API key",
		prompt: "API key for the configured OpenAI-compatible endpoint (stored in VS Code SecretStorage).",
		password: true,
		ignoreFocusOut: true,
	});
	if (!value) return false;
	await secrets.store(API_KEY_SECRET, sanitizeApiKey(value));
	return true;
}

export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
	await secrets.delete(API_KEY_SECRET);
}
