import { describe, expect, it } from "vitest";
import { filterModelGroups } from "../web/lib/modelGroups";
import type { ModelGroup } from "../web/lib/types";

const groups: ModelGroup[] = [
	{ profile: "Vercel", active: true, models: [{ id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5" }, { id: "openai/gpt-5", owner: "openai" }] },
	{ profile: "Openrouter", models: [{ id: "alibaba/qwen-3-14b" }, { id: "nvidia/nemotron-3.5-lightning-free", label: "Nemotron Free" }] },
];

describe("filterModelGroups", () => {
	it("returns every group when no profile or query is set", () => {
		expect(filterModelGroups(groups, "", "")).toEqual(groups);
	});

	it("narrows to one provider profile", () => {
		const out = filterModelGroups(groups, "Openrouter", "");
		expect(out.map((g) => g.profile)).toEqual(["Openrouter"]);
		expect(out[0].models).toHaveLength(2);
	});

	it("searches id, label and owner case-insensitively across providers", () => {
		expect(filterModelGroups(groups, "", "HAIKU").map((g) => g.profile)).toEqual(["Vercel"]);
		expect(filterModelGroups(groups, "", "openai").flatMap((g) => g.models.map((m) => m.id))).toEqual(["openai/gpt-5"]);
		expect(filterModelGroups(groups, "", "nemotron").flatMap((g) => g.models.map((m) => m.id))).toEqual(["nvidia/nemotron-3.5-lightning-free"]);
	});

	it("drops groups with no matching models", () => {
		expect(filterModelGroups(groups, "Vercel", "qwen")).toEqual([]);
	});
});
