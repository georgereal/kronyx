export interface ModelOption {
	id: string;
	label?: string;
	description?: string;
	contextWindow?: number;
	maxTokens?: number;
	pricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	modalities?: { input?: string[]; output?: string[] };
	tags?: string[];
	owner?: string;
}

const num = (v: unknown): number | undefined => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
};
const strArr = (v: unknown): string[] | undefined =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** Normalize one entry of a `/models` response (Vercel AI Gateway / OpenRouter / OpenAI shapes). */
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
	const input = strArr(modalities?.input) ?? strArr(arch?.input_modalities);
	const output = strArr(modalities?.output) ?? strArr(arch?.output_modalities);
	opt.modalities = input || output ? { input, output } : undefined;
	opt.tags = strArr(m.tags);
	opt.owner = typeof m.owned_by === "string" ? m.owned_by : undefined;
	const inPrice = num(pricing?.input) ?? num(pricing?.prompt);
	const outPrice = num(pricing?.output) ?? num(pricing?.completion);
	const cacheRead = num(pricing?.cache_read) ?? num(pricing?.input_cache_read) ?? num(pricing?.cached_input);
	const cacheWrite = num(pricing?.cache_write) ?? num(pricing?.input_cache_write);
	opt.pricing =
		inPrice !== undefined || outPrice !== undefined || cacheRead !== undefined || cacheWrite !== undefined
			? { input: inPrice, output: outPrice, cacheRead, cacheWrite }
			: undefined;
	return opt;
}

/** GET {baseUrl}/models with the user's key; returns [] on any failure. */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<ModelOption[]> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return [];
		const body = (await res.json()) as { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
		const list = body.data ?? body.models ?? [];
		const seen = new Set<string>();
		return list
			.map(toModelOption)
			.filter((m): m is ModelOption => m !== undefined)
			.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
	} catch {
		return [];
	}
}
