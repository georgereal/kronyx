import * as vscode from "vscode";
import { createMcpTools, type McpServerConfig } from "../tools/mcpTools";
import { saveUserConfig, userConfig } from "../userConfig";

/**
 * MCP server setup UX — presets + a manage flow that writes
 * `mcpServers` into ~/.kronyx/config.json. Secret answers go to
 * SecretStorage and the config references them via ${secret:NAME}, so
 * tokens never sit in plaintext.
 */

interface PresetField {
	key: string;
	prompt: string;
	secret?: boolean;
	placeholder?: string;
}

interface Preset {
	id: string;
	label: string;
	description: string;
	fields: PresetField[];
	build: (name: string, a: Record<string, string>) => McpServerConfig;
}

const secretRef = (server: string, key: string) => `kronyx.mcp.${server}.${key}`;

export const MCP_PRESETS: Preset[] = [
	{
		id: "github",
		label: "GitHub",
		description: "Repos, issues, PRs, code search — hosted remote server (PAT).",
		fields: [{ key: "token", prompt: "GitHub personal access token", secret: true, placeholder: "ghp_… / github_pat_…" }],
		build: (name, _a) => ({
			name,
			url: "https://api.githubcopilot.com/mcp/",
			headers: { Authorization: `Bearer \${secret:${secretRef(name, "token")}}` },
		}),
	},
	{
		id: "jira",
		label: "Jira / Atlassian (stdio)",
		description: "Community mcp-atlassian via uvx/npx — API token auth. (Hosted Rovo MCP needs OAuth — add manually later.)",
		fields: [
			{ key: "base", prompt: "Atlassian site URL", placeholder: "https://you.atlassian.net" },
			{ key: "email", prompt: "Atlassian account email" },
			{ key: "token", prompt: "Atlassian API token", secret: true },
		],
		build: (name, a) => ({
			name,
			command: "npx",
			args: ["-y", "mcp-atlassian"],
			env: {
				JIRA_BASE_URL: a.base,
				JIRA_EMAIL: a.email,
				JIRA_API_TOKEN: `\${secret:${secretRef(name, "token")}}`,
			},
		}),
	},
	{
		id: "linear",
		label: "Linear",
		description: "Issues/projects — hosted remote server (API key).",
		fields: [{ key: "token", prompt: "Linear API key", secret: true, placeholder: "lin_api_…" }],
		build: (name, _a) => ({
			name,
			url: "https://mcp.linear.app/sse",
			headers: { Authorization: `Bearer \${secret:${secretRef(name, "token")}}` },
		}),
	},
	{
		id: "notion",
		label: "Notion",
		description: "Pages/databases — hosted remote server (integration token).",
		fields: [{ key: "token", prompt: "Notion integration token", secret: true, placeholder: "ntn_…" }],
		build: (name, _a) => ({
			name,
			url: "https://mcp.notion.com/mcp",
			headers: { Authorization: `Bearer \${secret:${secretRef(name, "token")}}` },
		}),
	},
	{
		id: "postgres",
		label: "Postgres",
		description: "Read-only SQL — stdio reference server.",
		fields: [{ key: "conn", prompt: "Postgres connection string", secret: true, placeholder: "postgresql://user:pass@host/db" }],
		build: (name) => ({
			name,
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-postgres", `\${secret:${secretRef(name, "conn")}}`],
		}),
	},
	{
		id: "playwright",
		label: "Playwright",
		description: "Browser automation via accessibility snapshots — stdio, no secrets.",
		fields: [],
		build: (name) => ({ name, command: "npx", args: ["-y", "@playwright/mcp@latest"] }),
	},
];

async function pickFields(preset: Preset): Promise<Record<string, string> | undefined> {
	const answers: Record<string, string> = {};
	for (const f of preset.fields) {
		const v = await vscode.window.showInputBox({
			prompt: f.prompt,
			placeHolder: f.placeholder,
			password: f.secret === true,
			ignoreFocusOut: true,
		});
		if (v === undefined) return undefined;
		answers[f.key] = v.trim();
	}
	return answers;
}

async function addServer(context: vscode.ExtensionContext): Promise<McpServerConfig | undefined> {
	const items: (vscode.QuickPickItem & { preset?: Preset; custom?: boolean })[] = [
		...MCP_PRESETS.map((p) => ({ label: p.label, description: p.description, preset: p })),
		{ label: "$(add) Custom stdio server", custom: true },
		{ label: "$(add) Custom remote (URL) server", custom: true },
	];
	const pick = await vscode.window.showQuickPick(items, { placeHolder: "Add an MCP server" });
	if (!pick) return undefined;

	const name = (
		await vscode.window.showInputBox({
			prompt: "Server name (one word — tools become mcp_<name>_*)",
			value: pick.preset?.id ?? "",
			ignoreFocusOut: true,
		})
	)?.trim();
	if (!name) return undefined;

	if (pick.preset) {
		const answers = await pickFields(pick.preset);
		if (!answers) return undefined;
		for (const f of pick.preset.fields.filter((f) => f.secret)) {
			await context.secrets.store(secretRef(name, f.key), answers[f.key]);
			delete answers[f.key];
		}
		return pick.preset.build(name, answers);
	}
	if (pick.label.includes("stdio")) {
		const command = (await vscode.window.showInputBox({ prompt: "Command (e.g. npx)", ignoreFocusOut: true }))?.trim();
		if (!command) return undefined;
		const args = (await vscode.window.showInputBox({ prompt: "Args, space-separated (may use ${ENV_VAR} / ${secret:NAME})", ignoreFocusOut: true })) ?? "";
		return { name, command, args: args.split(/\s+/).filter(Boolean) };
	}
	const url = (await vscode.window.showInputBox({ prompt: "Server URL (https://…)", ignoreFocusOut: true }))?.trim();
	if (!url) return undefined;
	const auth = (await vscode.window.showInputBox({
		prompt: "Authorization header value, optional — e.g. Bearer <token>. Stored as a secret ref.",
		ignoreFocusOut: true,
	}))?.trim();
	const cfg: McpServerConfig = { name, url };
	if (auth) {
		await context.secrets.store(secretRef(name, "auth"), auth);
		cfg.headers = { Authorization: `\${secret:${secretRef(name, "auth")}}` };
	}
	return cfg;
}

async function testServer(context: vscode.ExtensionContext, cfg: McpServerConfig): Promise<void> {
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `MCP: connecting to ${cfg.name}…` }, async () => {
		const set = await createMcpTools({
			servers: [cfg],
			resolveSecret: async (n) => context.secrets.get(n),
			log: () => {},
		});
		await set.close();
		const n = set.tools.length;
		if (n) void vscode.window.showInformationMessage(`MCP "${cfg.name}": connected — ${n} tool(s) available as mcp_${cfg.name}_*.`);
		else void vscode.window.showWarningMessage(`MCP "${cfg.name}": no tools exposed — the connect failed or the server is empty (check output logs).`);
	});
}

/** Quick-pick manage flow: add / toggle / test / remove servers. */
export async function manageMcpServers(context: vscode.ExtensionContext): Promise<void> {
	for (;;) {
		const servers = [...(userConfig().mcpServers ?? [])];
		const items: (vscode.QuickPickItem & { act?: "add"; idx?: number })[] = [
			{ label: "$(add) Add MCP server…", act: "add", alwaysShow: true },
			...servers.map((s, i) => ({
				label: `${s.disabled ? "$(circle-slash)" : "$(plug)"} ${s.name}`,
				description: `${s.url ?? s.command ?? ""}${s.disabled ? " — disabled" : ""}`,
				idx: i,
			})),
		];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: "MCP servers" });
		if (!pick) return;
		if (pick.act === "add") {
			const cfg = await addServer(context);
			if (!cfg) continue;
			servers.push(cfg);
			await saveUserConfig({ mcpServers: servers });
			void vscode.window.showInformationMessage(`MCP server "${cfg.name}" saved — available on the next run.`);
			continue;
		}
		if (pick.idx === undefined) return;
		const cfg = servers[pick.idx];
		const action = await vscode.window.showQuickPick(
			[
				{ label: cfg.disabled ? "$(check) Enable" : "$(circle-slash) Disable", id: "toggle" },
				{ label: "$(debug-start) Test connection", id: "test" },
				{ label: "$(trash) Remove", id: "remove" },
			],
			{ placeHolder: cfg.name },
		);
		if (!action) continue;
		if (action.id === "toggle") cfg.disabled = !cfg.disabled;
		else if (action.id === "remove") servers.splice(pick.idx, 1);
		else if (action.id === "test") await testServer(context, cfg);
		await saveUserConfig({ mcpServers: servers });
	}
}
