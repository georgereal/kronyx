/**
 * IDE substitute for `web/lib/api.ts`.
 *
 * The web app's apiFetch prefixes nothing (Next rewrites /api/* to the
 * backend) and pulls a Firebase ID token from the `User`. Inside the VS Code
 * webview there is no Next server and no Firebase — we call the backend
 * directly with the extension's `krx_` API key, which the backend accepts on
 * every endpoint (`authenticate` in backend/src/lib/apiKeys.ts).
 *
 * `configure()` must be called before the session page mounts.
 */

export interface IdeApiConfig {
	/** Backend API base, e.g. http://localhost:4000 */
	apiBase: string;
	/** Web dashboard base — used to resolve relative Links to external URLs. */
	webBase: string;
	/** The account's krx_ API key. */
	token: string;
}

let cfg: IdeApiConfig = { apiBase: "", webBase: "", token: "" };

export function configure(next: IdeApiConfig): void {
	cfg = next;
}

export function apiBase(): string {
	return cfg.apiBase.replace(/\/+$/, "");
}

export function webBase(): string {
	return cfg.webBase.replace(/\/+$/, "");
}

export function resolveApiUrl(path: string): string {
	if (/^https?:/i.test(path)) return path;
	return `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Same signature as web/lib/api.ts — `user` is accepted and ignored. */
export async function apiFetch(path: string, user?: unknown, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${cfg.token}`);
	if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	return fetch(resolveApiUrl(path), { ...init, headers });
}

interface FakeUser {
	uid: string;
	email?: string;
	getIdToken: () => Promise<string>;
}

const fakeUser: FakeUser = {
	uid: "ide",
	getIdToken: async () => cfg.token,
};

/**
 * The page renders null while `user` is falsy, so return the shim user as
 * soon as a token is configured (the entry only mounts post-configure).
 */
export function useUser(): FakeUser | undefined {
	return cfg.token ? fakeUser : undefined;
}

/** RBAC role — the IDE embed doesn't gate admin UI, report a plain user. */
export function useRole(): string {
	return "user";
}
