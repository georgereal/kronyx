export type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

export interface Route {
	method: string;
	pattern: string;
	handler: Handler;
	regex: RegExp;
	keys: string[];
	match(pathname: string): Record<string, string> | null;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	if (!headers.has("content-type")) headers.set("content-type", "application/json");
	return new Response(JSON.stringify(body), { ...init, headers });
}

function compile(method: string, pattern: string, handler: Handler): Route {
	const keys: string[] = [];
	const regex = new RegExp(
		"^" +
			pattern
				.split("/")
				.map((seg) => {
					if (seg.startsWith(":")) {
						keys.push(seg.slice(1));
						return "([^/]+)";
					}
					return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				})
				.join("/") +
			"/?$",
	);
	return {
		method,
		pattern,
		handler,
		regex,
		keys,
		match(pathname) {
			const m = regex.exec(pathname);
			if (!m) return null;
			const params: Record<string, string> = {};
			keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
			return params;
		},
	};
}

export function makeRoutes(defs: [method: string, pattern: string, handler: Handler][]): Route[] {
	return defs.map(([m, p, h]) => compile(m, p, h));
}

import * as core from "./handlers/core";
import * as gh from "./handlers/github";
import * as runsH from "./handlers/runs";
import * as sess from "./handlers/sessions";
import * as misc from "./handlers/misc";

export const routes: Route[] = makeRoutes([
	["GET", "/api/me", core.me],
	["POST", "/api/keys", core.createKey],
	["GET", "/api/keys", core.listKeys],
	["DELETE", "/api/keys", core.deleteKey],
	["GET", "/api/settings", core.getSettings],
	["PUT", "/api/settings", core.putSettings],
	["GET", "/api/usage", core.usage],
	["POST", "/api/ingest", core.ingest],
	["GET", "/api/github/repos", gh.repos],
	["POST", "/api/github/token", gh.token],
	["GET", "/api/github/callback", gh.callback],
	["POST", "/api/github/link", gh.link],
	["GET", "/api/runs", runsH.listRuns],
	["GET", "/api/runs/:id", runsH.getRun],
	["POST", "/api/runs/:id/stop", runsH.stopRun],
	["GET", "/api/sandboxes", runsH.listSandboxes],
	["DELETE", "/api/sandboxes/:id", runsH.deleteSandbox],
	["POST", "/api/sandboxes/:id/pause", runsH.pauseSandbox],
	["GET", "/api/sessions", sess.listSessions],
	["POST", "/api/sessions", sess.createSession],
	["GET", "/api/sessions/:id", sess.getSession],
	["POST", "/api/sessions/:id/messages", sess.postMessage],
	["GET", "/api/sessions/:id/events", sess.sessionEvents],
	["POST", "/api/sessions/:id/plans/:slug/push", sess.pushPlan],
	["POST", "/api/sessions/:id/pr", sess.openSessionPr],
	["POST", "/api/sessions/:id/preflight", sess.preflight],
	["POST", "/api/attachments", misc.attachments],
	["GET", "/api/models", misc.models],
	["GET", "/api/plans/:id", misc.getPlan],
	["GET", "/api/cron/janitor", misc.janitor],
	["GET", "/api/mcp", misc.mcp],
	["POST", "/api/mcp", misc.mcp],
]);
