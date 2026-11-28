/**
 * Cline transport model port (vscode-free). Uses @cline/llms `createHandler` for
 * a single streamed turn. The handler owns no conversation state; every request
 * is rebuilt from the harness projection, so no SDK loop runs.
 */

import { createHandler, type ApiHandler } from "@cline/llms";
import type { AdapterCapabilities, ModelPort, ModelRequest, ModelResponse } from "../../core/contracts";
import { toClineMessages } from "./messages";
import { toClineTools } from "./tools";
import { collectTurn } from "./stream";
import type { ClinePortConfig } from "./types";

export { toClineMessages } from "./messages";
export { toClineTools } from "./tools";
export { collectTurn } from "./stream";
export { parseArguments } from "./args";
export type { ClinePortConfig } from "./types";

export class ClineModelPort implements ModelPort {
	readonly capabilities: AdapterCapabilities = { wire: "cline", serverConversations: false, reasoningItems: false, store: false };
	private readonly handler: ApiHandler;

	readonly identity: { providerId: string; modelId: string; contextWindow?: number };

	constructor(private readonly config: ClinePortConfig) {
		this.identity = { providerId: config.providerId, modelId: config.modelId, ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}) };
		this.handler = createHandler({
			providerId: (config.providerId === "azure" ? "openai-compatible" : config.providerId) as never,
			modelId: config.modelId,
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			maxOutputTokens: config.maxOutputTokens,
			abortSignal: config.signal,
		});
	}

	async complete(request: ModelRequest): Promise<ModelResponse> {
		this.handler.setAbortSignal?.(request.signal ?? this.config.signal);
		const stream = this.handler.createMessage(request.system, toClineMessages(request.messages), toClineTools(request.tools));
		return collectTurn(stream, request.onReasoningDelta, request.onTextDelta);
	}
}
