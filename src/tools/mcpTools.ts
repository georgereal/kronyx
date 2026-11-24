import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "@cline/shared";

/**
 * MCP client seam (vscode-free): connect to configured Model Context
 * Protocol servers and expose their tools to the agent as
 * `mcp_<server>_<tool>`. Tools flow through the normal pipeline guards —
 * permission rules see the server as the tool (`mcp_github`, `mcp_*`) and
 * the subtool as the target (`mcp_github(create_*)`).
 *
 * v1 scope: stdio servers spawned on the host + remote URL servers. The
 * worker's MCP processes run on the worker host, NOT inside the E2B VM —
 * they don't see the cloned repo.
 */

export interface McpServerConfig {
	name: string;
	/** Inferred when omitted: `url` → remote, `command` → stdio. */
	type?: "stdio" | "url";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	/** Extra HTTP headers for remote servers (Authorization etc). Values may
	 *  use ${ENV_VAR} and ${secret:NAME} expansion like every other field. */
	headers?: Record<string, string>;
	/** Skip this server entirely — keep it in config, out of the tool list. */
	disabled?: boolean;
	/** Per-server connect timeout (default 15s). */
	connectTimeoutMs?: number;
}

export interface McpToolsOptions {
	servers: readonly McpServerConfig[];
	/** Receives every substituted ${ENV_VAR} value so hosts can mask them in
	 *  logs/run_events (worker → RunSink.mask). */
	onSecret?: (value: string) => void;
	/** Resolves ${secret:NAME} references — IDE SecretStorage, worker secrets map. */
	resolveSecret?: (name: string) => Promise<string | undefined>;
	log?: (msg: string) => void;
}

export interface McpToolSet {
	tools: AgentTool<any, string>[];
	/** Close all server connections (stdio children are killed). */
	close(): Promise<void>;
}

/** `${VAR}`/`${VAR:-default}` expansion against process.env. Substituted
 *  values are reported via onSecret so they never reach run_events. */
export function expandEnv(value: string, onSecret?: (v: string) => void): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, dflt?: string) => {
		const v = process.env[name];
		if (v === undefined) return dflt ?? "";
		if (v) onSecret?.(v);
		return v;
	});
}

const SECRET_RE = /\$\{secret:([^}]+)\}/g;

/** Async pre-pass: `${secret:NAME}` → host secret store, before ${ENV} expansion. */
async function expandSecrets(value: string, opts: McpToolsOptions): Promise<string> {
	if (!opts.resolveSecret || !SECRET_RE.test(value)) return value;
	SECRET_RE.lastIndex = 0;
	const parts: (string | Promise<string>)[] = [];
	let last = 0;
	for (const m of value.matchAll(SECRET_RE)) {
		parts.push(value.slice(last, m.index));
		parts.push(
			opts.resolveSecret!(m[1]).then((v) => {
				if (v) opts.onSecret?.(v);
				return v ?? "";
			}),
		);
		last = m.index + m[0].length;
	}
	parts.push(value.slice(last));
	return (await Promise.all(parts)).join("");
}

/** MCP tools the server marked `readOnlyHint: true`. Anything else is treated
 *  as a write (the MCP spec default is non-read-only). */
const readOnlyMcpTools = new WeakSet<object>();
export const isReadOnlyMcpTool = (tool: object): boolean => readOnlyMcpTools.has(tool);

/** Permission rules key off `mcp_<server>` — the server part must stay a
 *  single word or the canonical split in permissions.ts breaks. */
const sanitizeName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";

function toolResultText(result: unknown): string {
	const r = result as { content?: { type?: string; text?: string }[]; isError?: boolean };
	if (!r?.content?.length) return JSON.stringify(result ?? null);
	const parts = r.content.map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)));
	return (r.isError ? "Error: " : "") + parts.join("\n");
}

async function connectOne(cfg: McpServerConfig, opts: McpToolsOptions): Promise<{ client: Client; close: () => Promise<void> }> {
	const client = new Client({ name: "kronyx", version: "1.0.0" }, { capabilities: {} });
	const remote = cfg.type ? cfg.type === "url" : !!cfg.url;
	const timeout = cfg.connectTimeoutMs ?? 15_000;
	if (remote) {
		if (!cfg.url) throw new Error(`MCP server "${cfg.name}": url type requires url`);
		const url = expandEnv(await expandSecrets(cfg.url, opts), opts.onSecret);
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = expandEnv(await expandSecrets(v, opts), opts.onSecret);
		const transport = new StreamableHTTPClientTransport(
			new URL(url),
			Object.keys(headers).length ? { requestInit: { headers } } : undefined,
		);
		await client.connect(transport, { timeout });
	} else {
		if (!cfg.command) throw new Error(`MCP server "${cfg.name}": stdio type requires command`);
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = expandEnv(await expandSecrets(v, opts), opts.onSecret);
		const transport = new StdioClientTransport({
			command: expandEnv(await expandSecrets(cfg.command, opts), opts.onSecret),
			args: await Promise.all((cfg.args ?? []).map(async (a) => expandEnv(await expandSecrets(a, opts), opts.onSecret))),
			env,
			stderr: "pipe",
		});
		await client.connect(transport, { timeout });
	}
	return { client, close: () => client.close() };
}

/** Connect to every configured server (failures are logged and skipped — a
 *  dead server must never kill the run) and flatten their tool lists. */
export async function createMcpTools(opts: McpToolsOptions): Promise<McpToolSet> {
	const tools: AgentTool<any, string>[] = [];
	const closers: (() => Promise<void>)[] = [];
	for (const raw of opts.servers) {
		if (raw.disabled) continue;
		const cfg = { ...raw, name: sanitizeName(raw.name) };
		try {
			const { client, close } = await connectOne(cfg, opts);
			closers.push(close);
			const listed = await client.listTools();
			for (const t of listed.tools ?? []) {
				const remote = t.name;
				const tool: AgentTool<any, string> = {
					name: `mcp_${cfg.name}_${remote.replace(/[^\w-]+/g, "_")}`,
					executionMode: "sequential",
					description: `[MCP ${cfg.name}] ${t.description ?? remote}`,
					inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as never,
					async execute(input: Record<string, unknown>) {
						const out = await client.callTool({ name: remote, arguments: input });
						return toolResultText(out);
					},
				};
				if (t.annotations?.readOnlyHint === true) readOnlyMcpTools.add(tool);
				tools.push(tool);
			}
		} catch (err) {
			opts.log?.(`MCP server "${cfg.name}" unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return {
		tools,
		close: async () => {
			await Promise.allSettled(closers.map((c) => c()));
		},
	};
}
