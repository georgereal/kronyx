/**
 * Rule-file permissions (Claude Code-style): layered allow/ask/deny lists of
 * `tool` or `tool(glob)` rules. vscode-free — shared by the extension and the
 * cloud worker.
 *
 * Layers (most-local-first):
 *   ~/.kronyx/permissions.json              global — the only cross-repo layer
 *   <repo>/.kronyx/permissions.json         committed, repo-scoped
 *   <repo>/.kronyx/permissions.local.json   personal, repo-scoped, gitignored
 *
 * Precedence: the global deny list is an unoverridable floor (a repo cannot
 * `allow` what the user denied globally); otherwise the most-local matching
 * rule wins, so a local allow CAN override a committed repo deny.
 */

export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionDecision = PermissionAction | undefined;

export interface PermissionRules {
	allow: string[];
	ask: string[];
	deny: string[];
}

export interface PermissionLayers {
	global: PermissionRules;
	project: PermissionRules;
	local: PermissionRules;
	/** Optional per-mode global overrides keyed by "ask" | "plan" | "agent". */
	modes?: Record<string, PermissionRules>;
}

const EMPTY: PermissionRules = { allow: [], ask: [], deny: [] };

const asList = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((r): r is string => typeof r === "string" && r.trim().length > 0) : [];

/** Parse a permissions document; tolerates missing/extra keys. */
export function parsePermissions(json: unknown): PermissionRules {
	const p = (json as { permissions?: Record<string, unknown> } | null)?.permissions ?? json;
	if (!p || typeof p !== "object") return { ...EMPTY };
	return {
		allow: asList((p as Record<string, unknown>).allow),
		ask: asList((p as Record<string, unknown>).ask),
		deny: asList((p as Record<string, unknown>).deny),
	};
}

export function parsePermissionsText(text: string): PermissionRules {
	try {
		return parsePermissions(JSON.parse(text));
	} catch {
		return { ...EMPTY };
	}
}

/** Parse the optional `permissions.modes` map — per-mode global overrides. */
export function parseModePermissions(json: unknown): Record<string, PermissionRules> {
	if (typeof json === "string") {
		try {
			return parseModePermissions(JSON.parse(json));
		} catch {
			return {};
		}
	}
	const p = (json as { permissions?: Record<string, unknown> } | null)?.permissions ?? json;
	const modes = (p as Record<string, unknown> | null)?.modes;
	if (!modes || typeof modes !== "object") return {};
	const out: Record<string, PermissionRules> = {};
	for (const [mode, rules] of Object.entries(modes as Record<string, unknown>)) {
		const parsed = parsePermissions(rules);
		if (parsed.allow.length || parsed.ask.length || parsed.deny.length) out[mode] = parsed;
	}
	return out;
}

/** Map any runtime mode onto the rule-bucket keys the web UI exposes. */
export function modeKey(mode: string | undefined): string {
	return mode === "ask" || mode === "plan" ? mode : "agent";
}

/** The value a `tool(glob)` rule matches against per tool. */
export function ruleTarget(toolName: string, input: unknown): string {
	const rec = (input ?? {}) as Record<string, unknown>;
	const str = (k: string) => (typeof rec[k] === "string" ? rec[k] : undefined);
	switch (toolName) {
		case "run_command":
			return str("command") ?? "";
		case "browser_use":
			return str("url") ?? str("task") ?? "";
		case "switch_environment":
			return str("template") ?? str("templateName") ?? "";
		default:
			return str("path") ?? str("file") ?? str("rel") ?? str("pattern") ?? "";
	}
}

/** Path-targeted tools: `*` stays within a path segment. Everything else
 *  (commands, URLs, templates) treats `*` as any run of characters. */
const PATH_TOOLS = new Set([
	"read_file",
	"write_file",
	"edit_file",
	"append_file",
	"insert_lines",
	"file_editor",
	"list_files",
	"search_files",
	"save_plan",
]);

/** `*` (segment-limited for paths, anything for commands) and `**` (anything). */
export function globToRe(glob: string, isPath: boolean): RegExp {
	const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const re = esc
		.replace(/\*\*/g, "\uE000")
		.replace(/\*/g, isPath ? "[^/]*" : ".*")
		.replace(/\uE000/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${re}$`);
}

/** One rule: "tool" or "tool(glob)". */
function ruleMatches(rule: string, toolName: string, target: string): boolean {
	const m = /^([\w-]+)(?:\((.*)\))?$/.exec(rule.trim());
	if (!m || m[1] !== toolName) return false;
	if (m[2] === undefined) return true; // whole-tool rule
	return globToRe(m[2], PATH_TOOLS.has(toolName)).test(target);
}

const matchList = (rules: string[], toolName: string, target: string): boolean =>
	rules.some((r) => ruleMatches(r, toolName, target));

const matchLayer = (rules: PermissionRules, toolName: string, target: string): PermissionDecision => {
	if (matchList(rules.deny, toolName, target)) return "deny";
	if (matchList(rules.allow, toolName, target)) return "allow";
	if (matchList(rules.ask, toolName, target)) return "ask";
	return undefined;
};

/**
 * Evaluate a tool call against the layered rules. Global deny wins outright;
 * then local, then project, then global allow/ask. Returns undefined when no
 * rule matches (caller falls back to mode defaults).
 */
export function evaluate(layers: PermissionLayers, toolName: string, input: unknown, mode?: string): PermissionDecision {
	const target = ruleTarget(toolName, input);
	if (matchList(layers.global.deny, toolName, target)) return "deny";
	for (const rules of [layers.local, layers.project]) {
		const d = matchLayer(rules, toolName, target);
		if (d !== undefined) return d;
	}
	const modeRules = mode ? layers.modes?.[modeKey(mode)] : undefined;
	if (modeRules) {
		const d = matchLayer(modeRules, toolName, target);
		if (d !== undefined) return d;
	}
	if (matchList(layers.global.allow, toolName, target)) return "allow";
	if (matchList(layers.global.ask, toolName, target)) return "ask";
	return undefined;
}

/** The narrowest useful rule for a "always allow this" card action. */
export function ruleFor(toolName: string, input: unknown): string {
	const target = ruleTarget(toolName, input);
	return target ? `${toolName}(${target})` : toolName;
}
