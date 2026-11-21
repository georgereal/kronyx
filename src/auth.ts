import * as vscode from "vscode";
import { log } from "./log";

const API_KEY_SECRET = "kronyx.account.apiKey";
const API_KEY_ID = "kronyx.account.apiKeyId";
const USER_KEY = "kronyx.account.user";

/** Fired whenever the stored account changes (sign-in, sign-out, key swap). */
const listeners = new Set<(user: KronyxUser | undefined) => void>();
export function onAuthChanged(listener: (user: KronyxUser | undefined) => void): void {
	listeners.add(listener);
}
function fireAuthChanged(user: KronyxUser | undefined): void {
	for (const fn of listeners) fn(user);
}

export interface KronyxUser {
	uid: string;
	email?: string;
	name?: string;
}

function config() {
	return vscode.workspace.getConfiguration("kronyx");
}

/** Web app base URL for ingest + deep links, or "" when unconfigured. */
export function webAppUrl(): string {
	return config().get<string>("sync.endpoint", "").replace(/\/+$/, "");
}

/** The stored `krx_…` API key sent as Bearer on all backend calls. */
export async function apiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const key = (await context.secrets.get(API_KEY_SECRET))?.trim();
	return key || undefined;
}

async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
	await context.secrets.store(API_KEY_SECRET, key.trim());
	// Key changed — refresh the cached user profile next time it's read.
	await context.globalState.update(USER_KEY, undefined);
}

export async function currentUser(context: vscode.ExtensionContext): Promise<KronyxUser | undefined> {
	const cached = context.globalState.get<KronyxUser>(USER_KEY);
	if (cached) return cached;
	const user = await fetchMe(context);
	if (user) await context.globalState.update(USER_KEY, user);
	return user;
}

/** GET /api/me with the stored key; undefined when signed out or offline. */
async function fetchMe(context: vscode.ExtensionContext): Promise<KronyxUser | undefined> {
	const key = await apiKey(context);
	const base = webAppUrl();
	if (!key || !base) return undefined;
	try {
		const res = await fetch(`${base}/api/me`, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return undefined;
		return (await res.json()) as KronyxUser;
	} catch {
		return undefined;
	}
}

/**
 * Sign in (Cursor/Devin-style): open the web app's /connect page in the browser.
 * The page mints a `krx_` key and deep-links back via vscode://kronyx.kronyx/auth?key=…
 * (see handleAuthUri). If the deep link can't reach this IDE (web/remote), the user
 * can paste the key directly instead.
 */
export async function signIn(context: vscode.ExtensionContext): Promise<KronyxUser | undefined> {
	const base = webAppUrl();
	if (!base) {
		void vscode.window.showErrorMessage("Kronyx: set kronyx.sync.endpoint first (the web app URL).");
		return undefined;
	}
	// Open /connect directly — same account as the web (Firebase). The page mints
	// a krx_ key labeled per-device and deep-links it back via handleAuthUri.
	// For web/remote where the deep link can't reach this IDE, the user can paste
	// the key via the non-blocking notification below.
	const { getDeviceId, deviceName } = await import("./settingsSync");
	const device = await getDeviceId(context).catch(() => "");
	const qs = device ? `?device=${encodeURIComponent(device)}&name=${encodeURIComponent(deviceName())}` : "";
	await vscode.env.openExternal(vscode.Uri.parse(`${base}/connect${qs}`));
	const pick = await vscode.window.showInformationMessage(
		"Kronyx: finish sign-in in the browser — or paste an API key if the link can't reach this editor.",
		"Paste API key",
	);
	if (pick !== "Paste API key") return undefined;
	const key = await vscode.window.showInputBox({
		title: "Kronyx: API key",
		prompt: "Paste a key from the Kronyx dashboard (starts with krx_).",
		password: true,
		ignoreFocusOut: true,
	});
	if (!key?.trim()) return undefined;
	await setApiKey(context, key);
	const user = await currentUser(context);
	if (!user) {
		await context.secrets.delete(API_KEY_SECRET);
		void vscode.window.showErrorMessage("Kronyx: that API key was rejected (invalid or revoked).");
		return undefined;
	}
	log("auth", `signed in as ${user.email ?? user.uid} (pasted key)`);
	fireAuthChanged(user);
	return user;
}

/** Handle vscode://kronyx.kronyx/auth?key=krx_… deep links from the connect page. */
export async function handleAuthUri(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<KronyxUser | undefined> {
	if (uri.path !== "/auth") return undefined;
	const params = new URLSearchParams(uri.query);
	const key = params.get("key")?.trim() ?? "";
	if (!key.startsWith("krx_")) {
		void vscode.window.showErrorMessage("Kronyx: sign-in link didn't contain a valid API key.");
		return undefined;
	}
	await setApiKey(context, key);
	await context.globalState.update(API_KEY_ID, params.get("id") ?? undefined);
	const user = await currentUser(context);
	if (user) {
		log("auth", `signed in as ${user.email ?? user.uid} (deep link)`);
		void vscode.window.showInformationMessage(`Kronyx: signed in as ${user.email ?? user.name ?? user.uid}`);
		fireAuthChanged(user);
		return user;
	}
	await context.secrets.delete(API_KEY_SECRET);
	void vscode.window.showErrorMessage("Kronyx: sign-in key was rejected (invalid or revoked).");
	return undefined;
}

export async function signOut(context: vscode.ExtensionContext): Promise<void> {
	// Best-effort remote revoke — the minted key must not stay valid server-side
	// after the editor signs out.
	const [key, id, base] = await Promise.all([apiKey(context), Promise.resolve(context.globalState.get<string>(API_KEY_ID)), Promise.resolve(webAppUrl())]);
	if (key && id && base) {
		await fetch(`${base}/api/keys?id=${encodeURIComponent(id)}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(8000),
		}).catch(() => {});
	}
	await context.secrets.delete(API_KEY_SECRET);
	await context.globalState.update(API_KEY_ID, undefined);
	await context.globalState.update(USER_KEY, undefined);
	fireAuthChanged(undefined);
}
