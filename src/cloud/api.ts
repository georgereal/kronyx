import { execFileSync } from "node:child_process";

/** Backend session document (subset the IDE needs). */
export interface CloudSession {
	sessionId: string;
	title: string;
	repo: string | null;
	branch: string | null;
	prUrl: string | null;
	mode: string;
	createdAt?: string;
	updatedAt?: string;
	latestRunStatus?: string;
}

function headers(key: string): Record<string, string> {
	return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function req<T>(endpoint: string, key: string, path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${endpoint}${path}`, { ...init, headers: { ...headers(key), ...(init.headers as Record<string, string> | undefined) } });
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
	if (!res.ok) throw new Error(String(body.error ?? `${res.status} ${res.statusText}`));
	return body;
}

/** List the account's backend sessions — the same rows the dashboard shows. */
export async function listCloudSessions(endpoint: string, key: string): Promise<CloudSession[]> {
	const body = await req<{ sessions?: CloudSession[] } | CloudSession[]>(endpoint, key, "/api/sessions");
	const list = Array.isArray(body) ? body : (body.sessions ?? []);
	return list.slice(0, 50);
}

/** Create a backend session bound to a repo; installationId/base auto-resolve server-side. */
export async function createCloudSession(
	endpoint: string,
	key: string,
	opts: { repo: string; title?: string; mode?: "agent" | "plan" | "ask" | "multi"; modelId?: string },
): Promise<string> {
	const body = await req<{ session: { sessionId: string } }>(endpoint, key, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ repo: opts.repo, title: opts.title?.slice(0, 120), mode: opts.mode ?? "agent", modelId: opts.modelId }),
	});
	return body.session.sessionId;
}

/** Enqueue a task for the session — the worker picks it up, same as the web composer. */
export async function sendTask(endpoint: string, key: string, sessionId: string, task: string): Promise<void> {
	await req(endpoint, key, `/api/sessions/${sessionId}/messages`, {
		method: "POST",
		body: JSON.stringify({ task }),
	});
}

let repoCache: { cwd: string; repo: string | null } | undefined;
/** Infer `owner/name` from the workspace's git origin remote. */
export function workspaceRepo(cwd: string): string | null {
	if (repoCache?.cwd === cwd) return repoCache.repo;
	let repo: string | null = null;
	try {
		const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", timeout: 4000 }).trim();
		const m = url.match(/[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
		if (m) repo = m[1];
	} catch {
		repo = null;
	}
	repoCache = { cwd, repo };
	return repo;
}
