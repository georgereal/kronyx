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

/** Repos visible to an installation. */
export async function installationRepos(installationId: number): Promise<{ fullName: string; defaultBranch: string }[]> {
	const res = await gh(`/installation/repositories?per_page=100`, {}, await installationToken(installationId));
	if (!res.ok) return [];
	const data = (await res.json()) as { repositories?: { full_name: string; default_branch: string }[] };
	return (data.repositories ?? []).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch }));
}

/** Short-lived installation access token — scoped to the installed repos only. */
export async function installationToken(installationId: number): Promise<string> {
	const res = await gh(`/app/installations/${installationId}/access_tokens`, { method: "POST" });
	if (!res.ok) throw new Error(`installation token failed: ${res.status}`);
	return ((await res.json()) as { token: string }).token;
}
