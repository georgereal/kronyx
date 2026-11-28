export interface OpenAIPortConfig {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	modelId: string;
	maxOutputTokens?: number;
	signal?: AbortSignal;
	/** Responses `store` flag. Default true; Conversations need it. */
	store?: boolean;
	/** Server-side conversations on direct api.openai.com. Default true. */
	conversations?: boolean;
	/** Model context window; server compaction triggers at a share of it. */
	contextWindow?: number;
	/** Resolved API shape (from the matrix) — the port family is chosen on this, not re-detected. */
	shape?: "responses" | "conversations" | "chat";
	/** Stateless endpoint: store is forced false, no chaining (OpenRouter Responses). */
	stateless?: boolean;
	/** Provider/shape-specific request-body extras (reasoning opt-ins), keyed off the model id. */
	extras?: (modelId: string) => Record<string, unknown>;
	/** The shape pick was explicit (not auto) — unsupported configurations hard-fail instead of resolving down. */
	explicit?: boolean;
}

export const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
};
