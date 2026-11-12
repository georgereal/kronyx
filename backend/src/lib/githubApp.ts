import { createSign } from "node:crypto";

const APP_ID = () => process.env.GITHUB_APP_ID ?? "";
const APP_KEY = () => (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

/** RS256 JWT for GitHub App auth (10 min max). */
function appJwt(): string {
	const now = Math.floor(Date.now() / 1000);
	const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: APP_ID(), iat: now - 60, exp: now + 540 })}`;
	const sig = createSign("RSA-SHA256").update(unsigned).sign(APP_KEY(), "base64url");
	return `${unsigned}.${sig}`;
}

async function gh(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
	return fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token ?? appJwt()}`,
			Accept: "application/vnd.github+json",
			...(init.headers ?? {}),
		},
	});
}

export interface Installation {
	id: number;
	account: { login: string; type: string };
}

/** All installations of the Kronyx GitHub App (server-side list). */
export async function listInstallations(): Promise<Installation[]> {
	const res = await gh("/app/installations?per_page=100");
	if (!res.ok) return [];
	const data = (await res.json()) as Installation[];
	return Array.isArray(data) ? data : [];
}

/** Single installation's account info (app JWT). */
export async function getInstallation(installationId: number): Promise<Installation | null> {
	const res = await gh(`/app/installations/${installationId}`);
	if (!res.ok) return null;
	return (await res.json()) as Installation;
}

/**
 * Create a repo in an organization — installation token needs the app's
 * Administration (write) org permission. User-account repos can't be created
 * via installation tokens.
 */
export async function createOrgRepo(
	installationId: number,
	org: string,
	name: string,
	isPrivate: boolean,
): Promise<{ fullName: string; defaultBranch: string }> {
	const res = await gh(`/orgs/${org}/repos`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
	}, await installationToken(installationId));
	const data = (await res.json().catch(() => ({}))) as { full_name?: string; default_branch?: string; message?: string };
	if (!res.ok || !data.full_name) throw new Error(data.message ?? `create repo failed: ${res.status}`);
	return { fullName: data.full_name, defaultBranch: data.default_branch ?? "main" };
}

/** GitHub account id for a login (user or org) — used to preselect the install target. */
export async function lookupAccountId(login: string): Promise<number | null> {
	const res = await gh(`/users/${encodeURIComponent(login)}`);
	if (!res.ok) return null;
	const data = (await res.json().catch(() => ({}))) as { id?: number };
	return data.id ?? null;
}

/** Repos visible to an installation. */
export async function installationRepos(installationId: number): Promise<{ fullName: string; defaultBranch: string }[]> {
	const res = await gh(`/installation/repositories?per_page=100`, {}, await installationToken(installationId));
	if (!res.ok) return [];
	const data = (await res.json()) as { repositories?: { full_name: string; default_branch: string }[] };
	return (data.repositories ?? []).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch }));
}

// Installation tokens last ~1h — mint at most once per ~50min per installation.
const tokenCache = new Map<number, { token: string; at: number; inflight?: Promise<string> }>();
const TOKEN_TTL_MS = 50 * 60_000;

/** Short-lived installation access token — scoped to the installed repos only. */
export async function installationToken(installationId: number): Promise<string> {
	const hit = tokenCache.get(installationId);
	if (hit?.inflight) return hit.inflight;
	if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
	const inflight = (async () => {
		const res = await gh(`/app/installations/${installationId}/access_tokens`, { method: "POST" });
		if (!res.ok) throw new Error(`installation token failed: ${res.status}`);
		return ((await res.json()) as { token: string }).token;
	})();
	tokenCache.set(installationId, { token: "", at: 0, inflight });
	try {
		const token = await inflight;
		tokenCache.set(installationId, { token, at: Date.now() });
		return token;
	} finally {
		const cur = tokenCache.get(installationId);
		if (cur?.inflight === inflight) cur.inflight = undefined;
	}
}
