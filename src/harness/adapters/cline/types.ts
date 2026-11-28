import type { Message as ClineMessage } from "@cline/shared";

export interface ClinePortConfig {
	providerId: string;
	baseUrl?: string;
	apiKey: string;
	modelId: string;
	maxOutputTokens?: number;
	contextWindow?: number;
	signal?: AbortSignal;
}

export type { ClineMessage };
