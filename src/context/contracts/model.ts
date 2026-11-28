/** Model identity, measured window, and provider capabilities used for context budgeting. */
export interface ModelProfile {
	providerId: string;
	modelId: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	tokenizer?: "cl100k" | "o200k" | "provider" | "estimate";
	capabilities: {
		wire?: "cline" | "responses" | "chat" | "conversations";
		serverConversations: boolean;
		providerManagedCompaction: boolean;
		reasoningItems: boolean;
		store: boolean;
		parallelTools?: boolean;
		images?: boolean;
	};
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_OUTPUT_RESERVE = 8_000;
