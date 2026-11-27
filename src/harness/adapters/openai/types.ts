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
}

export const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
};
