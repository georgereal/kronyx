import { describe, expect, it } from "vitest";
import type { ModelPort, ToolPort } from "../../src/harness/contracts";
import { MemoryEventLog } from "../../src/harness/eventLog";
import { HarnessLoop } from "../../src/harness/loop";
import { toClineMessages } from "../../src/harness/adapters/cline";
import { toAgentMessages } from "../../src/harness/adapters/openai";

const tools: ToolPort = { specs: () => [], execute: async () => ({ ok: true, output: "" }) };
const img = { mediaType: "image/png", base64: "AAAA" };

describe("image attachments on the harness (step 5)", () => {
	it("records images on the user input event and the projection", async () => {
		const log = new MemoryEventLog(() => 1);
		const model: ModelPort = { complete: async () => ({ text: "ok", toolCalls: [] }) };
		const loop = new HarnessLoop({ runId: "r", log, model, tools });
		await loop.run("look at this", undefined, [img]);
		const event = (await log.read()).find((e) => e.type === "user.input");
		expect(event).toMatchObject({ images: [img] });
		expect(loop.projection.messages[0]).toMatchObject({ kind: "user", images: [img] });
	});

	it("maps the image to an image part for the OpenAI transport", () => {
		const msgs = toAgentMessages([{ kind: "user", text: "look", seq: 1, images: [img] }]);
		expect(msgs[0]?.content).toEqual([{ type: "text", text: "look" }, { type: "image", image: "AAAA", mediaType: "image/png" }]);
	});

	it("maps the image to an image block for the Cline transport", () => {
		const msgs = toClineMessages([{ kind: "user", text: "look", seq: 1, images: [img] }]);
		expect(msgs[0]?.content).toEqual([{ type: "text", text: "look" }, { type: "image", data: "AAAA", mediaType: "image/png" }]);
	});

	it("keeps a text-only user message as a plain string for the Cline transport", () => {
		expect(toClineMessages([{ kind: "user", text: "plain", seq: 1 }])[0]?.content).toBe("plain");
	});
});
