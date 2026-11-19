import { describe, expect, it } from "vitest";
import { createLoadSkillTool, parseSkill, skillsIndex } from "../src/agent/skills";

const FRONT = `---
name: deploy
description: How to deploy this service
---
# Deploy

Run ./deploy.sh --prod.
`;

describe("parseSkill", () => {
	it("reads frontmatter name/description and strips it from the body", () => {
		const s = parseSkill(".kronyx/skills/deploy/SKILL.md", FRONT);
		expect(s.name).toBe("deploy");
		expect(s.description).toBe("How to deploy this service");
		expect(s.body).toContain("Run ./deploy.sh --prod.");
		expect(s.body).not.toContain("---");
	});

	it("falls back to dir name and first body line", () => {
		const s = parseSkill(".kronyx/skills/release/SKILL.md", "# Title\nDoes the release dance.\n");
		expect(s.name).toBe("release");
		expect(s.description).toBe("Does the release dance.");
	});
});

describe("skillsIndex", () => {
	it("renders an index line per skill and empty string for none", () => {
		expect(skillsIndex([])).toBe("");
		const idx = skillsIndex([parseSkill(".kronyx/skills/deploy/SKILL.md", FRONT)]);
		expect(idx).toContain("- deploy: How to deploy this service");
		expect(idx).toContain("load_skill");
	});
});

describe("load_skill", () => {
	it("returns the body and reports unknown names", async () => {
		const tool = createLoadSkillTool([parseSkill(".kronyx/skills/deploy/SKILL.md", FRONT)]);
		expect(await tool.execute({ name: "deploy" }, {} as never)).toContain("Run ./deploy.sh --prod.");
		expect(await tool.execute({ name: "nope" }, {} as never)).toContain('Unknown skill "nope"');
	});
});
