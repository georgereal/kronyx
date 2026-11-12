import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";
import { apiKey, currentUser, webAppUrl } from "./auth";
import { profiles, profileApiKey } from "./config";
import { refreshUserConfig, saveUserConfig, userConfig } from "./userConfig";
import { kvGet, kvSet, openStore } from "./store";
import { log } from "./log";
import { readGlobalPermissions, writeGlobalPermissions } from "./permStore";
import { parsePermissionsText } from "./agent/permissions";

const DEVICE_KEY = "kronyx.deviceId";
const SYNC_STAMP = "settings.syncedAt";
const PUSH_DEBOUNCE_MS = 2_000;

function providerKeysEnabled(): boolean {
	return vscode.workspace.getConfiguration("kronyx").get<boolean>("sync.providerKeys", true);
}

/** Stable per-installation device id (uuid in globalState). */
export async function getDeviceId(context: vscode.ExtensionContext): Promise<string> {
	let id = context.globalState.get<string>(DEVICE_KEY);
	if (!id) {
		id = randomUUID();
		await context.globalState.update(DEVICE_KEY, id);
	}
	return id;
}

/** Short machine label for rows/cards — hostname, trimmed. */
export function deviceName(): string {
	return os.hostname().replace(/\.local$/, "");
}

/**
 * Cross-device settings sync. Local `~/.kronyx/config.json` stays source of
 * truth; remote `users/{uid}.settings` is a copy merged by doc-level
 * last-writer-wins on `updatedAt`.
 */
export class SettingsSync implements vscode.Disposable {
	private pushTimer: ReturnType<typeof setTimeout> | undefined;
	private pulling = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Debounced push — call after every local config write. */
	schedulePush(): void {
		clearTimeout(this.pushTimer);
		this.pushTimer = setTimeout(() => void this.push(), PUSH_DEBOUNCE_MS);
	}

	private async payload(): Promise<Record<string, unknown> | undefined> {
		const user = await currentUser(this.context);
		const key = await apiKey(this.context);
		const base = webAppUrl();
		if (!user || !key || !base) return undefined;
		const secrets: Record<string, string> = {};
		if (providerKeysEnabled()) {
			const e2b = await this.context.secrets.get("kronyx.sandbox.e2bApiKey");
			if (e2b) secrets.e2bApiKey = e2b;
			const gh = await this.context.secrets.get("kronyx.github.token");
			if (gh) secrets.githubToken = gh;
			for (const p of profiles()) {
				if (p.name) {
					const k = await profileApiKey(this.context.secrets, p.name);
					if (k) secrets[p.name] = k;
				}
			}
		}
		return { user, key, base, secrets };
	}

	/** Upload local config to users/{uid}. No-op when signed out or sync disabled. */
	async push(): Promise<void> {
		const p = await this.payload();
		if (!p) return;
		const uc = userConfig();
		try {
			const res = await fetch(`${p.base}/api/settings`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
				body: JSON.stringify({
					version: 1,
					data: {
						providerId: uc.providerId,
						baseUrl: uc.baseUrl,
						modelId: uc.modelId,
						profiles: uc.profiles,
						activeProfile: uc.activeProfile,
						permissions: await readGlobalPermissions(),
					},
					...(Object.keys(p.secrets as object).length ? { secrets: p.secrets } : {}),
					device: { id: await getDeviceId(this.context), name: deviceName() },
				}),
				signal: AbortSignal.timeout(10_000),
			});
			if (res.ok) await this.stamp(Date.now());
			else log("settingsSync", `push failed: HTTP ${res.status}`);
		} catch (error) {
			log("settingsSync", `push failed: ${error instanceof Error ? error.message : error}`);
		}
	}

	/** Download remote config when it's newer than our last sync stamp. */
	async pull(): Promise<void> {
		if (this.pulling) return;
		const p = await this.payload();
		if (!p) return;
		this.pulling = true;
		try {
			const res = await fetch(`${p.base}/api/settings`, {
				headers: { Authorization: `Bearer ${p.key}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (res.status === 404) {
				await this.push(); // first sync from this account — local wins
				return;
			}
			if (!res.ok) return;
			const { settings } = (await res.json()) as {
				settings?: { updatedAt?: string; data?: Record<string, unknown>; secrets?: Record<string, string> };
			};
			const remoteAt = settings?.updatedAt ? new Date(settings.updatedAt).getTime() : 0;
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const localStamp = root ? (kvGet<number>(await openStore(root), SYNC_STAMP) ?? 0) : 0;
			if (!settings?.data || remoteAt <= localStamp) return;
			await saveUserConfig(
				Object.fromEntries(
					Object.entries(settings.data).filter(([, v]) => v !== undefined),
				) as Parameters<typeof saveUserConfig>[0],
			);
			await refreshUserConfig();
			// Global permission rules travel in settings.data.permissions — apply them
			// to ~/.kronyx/permissions.json so local runs match cloud behavior.
			if (settings.data.permissions) {
				await writeGlobalPermissions(
					parsePermissionsText(JSON.stringify(settings.data.permissions)),
				).catch(() => {});
			}
			// Secrets set on the web are user-explicit — always apply on pull
			// (the providerKeys opt-in only gates the push direction).
			if (settings.secrets) {
				for (const [name, key] of Object.entries(settings.secrets)) {
					const secretKey =
						name === "e2bApiKey"
							? "kronyx.sandbox.e2bApiKey"
							: name === "githubToken"
								? "kronyx.github.token"
								: `kronyx.profile.apiKey.${name}`;
					await this.context.secrets.store(secretKey, key);
				}
			}
			await this.stamp(remoteAt);
			log("settingsSync", `pulled settings (updated ${settings.updatedAt})`);
		} catch (error) {
			log("settingsSync", `pull failed: ${error instanceof Error ? error.message : error}`);
		} finally {
			this.pulling = false;
		}
	}

	private async stamp(at: number): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) kvSet(await openStore(root), SYNC_STAMP, at);
	}

	dispose(): void {
		clearTimeout(this.pushTimer);
	}
}
