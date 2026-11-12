import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseModePermissions, parsePermissionsText, type PermissionRules } from "./agent/permissions";
import { userConfigDir } from "./userConfig";

/** Global (cross-repo) rules file: ~/.kronyx/permissions.json — honors KRONYX_CONFIG_DIR. */
export function globalPermissionsPath(): string {
	return path.join(userConfigDir(), "permissions.json");
}

export async function readGlobalPermissions(): Promise<PermissionRules> {
	return parsePermissionsText(await fs.readFile(globalPermissionsPath(), "utf8").catch(() => ""));
}

/** Per-mode overrides stored alongside the global lists. */
export async function readGlobalModePermissions(): Promise<Record<string, PermissionRules>> {
	try {
		return parseModePermissions(JSON.parse(await fs.readFile(globalPermissionsPath(), "utf8")));
	} catch {
		return {};
	}
}

export async function writeGlobalPermissions(rules: PermissionRules, modes?: Record<string, PermissionRules>): Promise<void> {
	await fs.mkdir(userConfigDir(), { recursive: true });
	const doc = modes && Object.keys(modes).length ? { permissions: { ...rules, modes } } : { permissions: rules };
	await fs.writeFile(globalPermissionsPath(), JSON.stringify(doc, null, 2) + "\n");
}
