import { describe, expect, it } from "vitest";
import { createModelAdapter } from "../../src/harness/adapters";
import { openaiAdapter, ChatCompletionsPort, ConversationsApiPort, ResponsesApiPort } from "../../src/harness/adapters/openai";
import { ClineModelPort } from "../../src/harness/adapters/cline";

const direct = { providerId: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", modelId: "m" };

describe("openaiAdapter (shape explicit — production resolves through the matrix)", () => {
	it("conversations shape on direct api.openai.com with store + conversations on", () => {
		const port = openaiAdapter({ ...direct, shape: "conversations" });
		expect(port).toBeInstanceOf(ConversationsApiPort);
		expect(port.capabilities).toMatchObject({ wire: "conversations", serverConversations: true });
		expect(port.strategy).toBeDefined();
		expect(port.conversations).toBeDefined();
	});

	it("conversations shape degrades to stateless Responses when store/conversations off or host not direct (auto pick only)", () => {
		expect(openaiAdapter({ ...direct, shape: "conversations", store: false })).toBeInstanceOf(ResponsesApiPort);
		expect(openaiAdapter({ ...direct, shape: "conversations", conversations: false })).toBeInstanceOf(ResponsesApiPort);
		expect(openaiAdapter({ ...direct, shape: "conversations", baseUrl: "https://ai-gateway.vercel.sh/v1" })).toBeInstanceOf(ResponsesApiPort);
	});

	it("explicit conversations pick hard-fails off the direct host", () => {
		expect(() => openaiAdapter({ ...direct, shape: "conversations", explicit: true, baseUrl: "https://ai-gateway.vercel.sh/v1" })).toThrow(/api\.openai\.com/);
	});

	it("responses and chat shapes build their ports", () => {
		expect(openaiAdapter({ ...direct, shape: "responses" })).toBeInstanceOf(ResponsesApiPort);
		expect(openaiAdapter({ ...direct, shape: "chat" })).toBeInstanceOf(ChatCompletionsPort);
	});
});

describe("createModelAdapter (matrix)", () => {
	it("selects the transport family independently of provider", () => {
		expect(createModelAdapter("auto", direct)).toBeInstanceOf(ConversationsApiPort);
		expect(createModelAdapter("cline", direct)).toBeInstanceOf(ClineModelPort);
	});

	it("hard-fails unsupported explicit picks, naming what IS supported", () => {
		const openrouter = { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", modelId: "m" };
		expect(() => createModelAdapter("conversations", openrouter)).toThrow(/does not serve the conversations API/);
		// ...while responses on openrouter is now fully supported (stateless).
		expect(createModelAdapter("responses", openrouter)).toBeInstanceOf(ResponsesApiPort);
		// Anthropic serves only cline.
		const anthropic = { providerId: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k", modelId: "m" };
		expect(() => createModelAdapter("responses", anthropic)).toThrow(/does not serve/);
		expect(createModelAdapter("cline", anthropic)).toBeInstanceOf(ClineModelPort);
		expect(createModelAdapter("auto", anthropic)).toBeInstanceOf(ClineModelPort);
		// Conversations requires directness even where the shape exists.
		expect(() => createModelAdapter("conversations", { ...direct, baseUrl: "https://ai-gateway.vercel.sh/v1" })).toThrow();
		// The gateway proxies the Responses API.
		const gw = { providerId: "vercel-ai-gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", apiKey: "k" };
		expect(createModelAdapter("responses", { ...gw, modelId: "openai/gpt-5" })).toBeInstanceOf(ResponsesApiPort);
		// Auto resolution: responses for openrouter and the gateway, conversations for direct openai.
		expect(createModelAdapter("auto", openrouter)).toBeInstanceOf(ResponsesApiPort);
		expect(createModelAdapter("auto", { ...gw, modelId: "openai/gpt-5" })).toBeInstanceOf(ResponsesApiPort);
		expect(createModelAdapter("auto", direct)).toBeInstanceOf(ConversationsApiPort);
		expect(createModelAdapter("conversations", direct)).toBeInstanceOf(ConversationsApiPort);
	});

	it("threads matrix constraints into the port config", () => {
		const openrouter = { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", modelId: "m" };
		const port = createModelAdapter("responses", openrouter) as ResponsesApiPort;
		expect(port.capabilities.store).toBe(false);
	});
});
