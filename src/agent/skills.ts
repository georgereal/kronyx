import type { AgentTool } from "@cline/shared";

/**
 * Repo skills (vscode-free): `.kronyx/skills/<name>/SKILL.md` files discovered
 * through the `files` seam. Only name + description reach the system prompt —
 * the `load_skill` deferred tool returns the body on demand, so skills cost
 * nothing until invoked (same lazy pattern as use_tool for heavy tools).
 */

export interface SkillFile {
	/** Repo-relative path (e.g. `.kronyx/skills/deploy/SKILL.md`). */
	path: string;
	content: string;
}

export interface Skill {
	name: string;
	description: string;
	body: string;
}

/** Parse SKILL.md frontmatter (`---` fenced `key: value` lines); falls back
 *  to the parent directory name and the first non-frontmatter line. */
export function parseSkill(path: string, content: string): Skill {
	const dir = path.replace(/\\/g, "/").split("/").slice(-2, -1)[0] ?? "skill";
	let name = dir;
	let description = "";
	let bodyStart = 0;
	if (content.startsWith("---")) {
		const end = content.indexOf("\n---", 3);
		if (end > 0) {
			for (const line of content.slice(3, end).split("\n")) {
				const m = /^([A-Za-z_]+)\s*:\s*(.+)$/.exec(line.trim());
				if (!m) continue;
				const v = m[2].trim().replace(/^["']|["']$/g, "");
				if (m[1] === "name" && v) name = v;
				if (m[1] === "description" && v) description = v;
			}
			bodyStart = end + 4;
		}
	}
	const body = content.slice(bodyStart).trim();
	if (!description) description = body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
	return { name, description, body };
}

/** The index block injected into the system prompt. */
export function skillsIndex(skills: readonly Skill[]): string {
	if (!skills.length) return "";
	const lines = skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}`).join("\n");
	return `Repo skills available (call use_tool with {"name": "load_skill"} to see its schema, then load one by name for the full instructions before acting on it):\n${lines}`;
}

interface LoadSkillInput {
	name: string;
}

/** `load_skill` — deferred tool that returns a skill's full SKILL.md body. */
export function createLoadSkillTool(skills: readonly Skill[]): AgentTool<LoadSkillInput, string> {
	const byName = new Map(skills.map((s) => [s.name, s]));
	return {
		name: "load_skill",
		executionMode: "sequential",
		description:
			"Load a repo skill's full instructions by name (see the skills index in the system prompt). Call this before following a skill.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string", description: "Skill name from the index." } },
			required: ["name"],
		},
		async execute(input) {
			const s = byName.get(input.name);
			return s ? s.body : `Unknown skill "${input.name}". Available: ${[...byName.keys()].join(", ") || "(none)"}.`;
		},
	};
}
