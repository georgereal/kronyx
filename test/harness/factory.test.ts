import { describe, expect, it } from "vitest";
import { createModelAdapter } from "../../src/harness/adapters";
import { openaiAdapter, ChatCompletionsPort, ConversationsApiPort, ResponsesApiPort } from "../../src/harness/adapters/openai";
import { ClineModelPort } from "../../src/harness/adapters/cline";

const direct = { providerId: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", modelId: "m" };

describe("openaiAdapter factory", () => {
	it("picks the Conversations shape for direct api.openai.com with store + conversations on", () => {
		const port = openaiAdapter(direct);
		expect(port).toBeInstanceOf(ConversationsApiPort);
		expect(port.capabilities).toMatchObject({ wire: "conversations", serverConversations: true });
		expect(port.strategy).toBeDefined();
		expect(port.conversations).toBeDefined();
	});

	it("picks stateless Responses when store or conversations are off, or the host is not direct", () => {
		expect(openaiAdapter({ ...direct, store: false })).toBeInstanceOf(ResponsesApiPort);
		expect(openaiAdapter({ ...direct, conversations: false })).toBeInstanceOf(ResponsesApiPort);
		expect(openaiAdapter({ ...direct, baseUrl: "https://ai-gateway.vercel.sh/v1" })).toBeInstanceOf(ResponsesApiPort);
	});

	it("picks chat completions for non-Responses providers", () => {
		expect(openaiAdapter({ ...direct, providerId: "openai-compatible" })).toBeInstanceOf(ChatCompletionsPort);
		expect(openaiAdapter({ providerId: "openrouter", baseUrl: "https://gw.example.test/v1", apiKey: "k", modelId: "m" })).toBeInstanceOf(ChatCompletionsPort);
	});

	it("picks stateless Responses on Vercel AI Gateway", () => {
		const gw = { providerId: "vercel-ai-gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", apiKey: "k" };
		expect(openaiAdapter({ ...gw, modelId: "openai/gpt-5" })).toBeInstanceOf(ResponsesApiPort);
		expect(openaiAdapter({ ...gw, modelId: "anthropic/claude-sonnet-4.6" })).toBeInstanceOf(ResponsesApiPort);
	});
});

describe("createModelAdapter", () => {
	it("selects the transport family independently of provider", () => {
		expect(createModelAdapter("openai", direct)).toBeInstanceOf(ConversationsApiPort);
		expect(createModelAdapter("cline", direct)).toBeInstanceOf(ClineModelPort);
	});

	it("fails loudly instead of falling back for explicit transport picks", () => {
		// Session-14's bug: a conversations chip on a chat-only provider silently ran stateless.
		const openrouter = { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", modelId: "m" };
		expect(() => createModelAdapter("conversations", openrouter)).toThrow(/api\.openai\.com/);
		expect(() => createModelAdapter("responses", openrouter)).toThrow(/Responses-capable/);
		// The gateway proxies the Responses API.
		const gw = { providerId: "vercel-ai-gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", apiKey: "k" };
		expect(createModelAdapter("responses", { ...gw, modelId: "openai/gpt-5" })).toBeInstanceOf(ResponsesApiPort);
		expect(createModelAdapter("responses", { ...gw, modelId: "anthropic/claude-sonnet-4.6" })).toBeInstanceOf(ResponsesApiPort);
		expect(() => createModelAdapter("conversations", { ...direct, store: false })).toThrow();
		expect(() => createModelAdapter("conversations", { ...direct, baseUrl: "https://ai-gateway.vercel.sh/v1" })).toThrow();
		// Auto mode keeps its selection logic.
		expect(createModelAdapter("openai", openrouter)).toBeInstanceOf(ChatCompletionsPort);
		expect(createModelAdapter("responses", direct)).toBeInstanceOf(ResponsesApiPort);
		expect(createModelAdapter("conversations", direct)).toBeInstanceOf(ConversationsApiPort);
	});
});
