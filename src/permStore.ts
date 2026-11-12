import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parsePermissionsText, type PermissionRules } from "./agent/permissions";
import { userConfigDir } from "./userConfig";

/** Global (cross-repo) rules file: ~/.kronyx/permissions.json — honors KRONYX_CONFIG_DIR. */
export function globalPermissionsPath(): string {
	return path.join(userConfigDir(), "permissions.json");
}

export async function readGlobalPermissions(): Promise<PermissionRules> {
	return parsePermissionsText(await fs.readFile(globalPermissionsPath(), "utf8").catch(() => ""));
}

export async function writeGlobalPermissions(rules: PermissionRules): Promise<void> {
	await fs.mkdir(userConfigDir(), { recursive: true });
	await fs.writeFile(globalPermissionsPath(), JSON.stringify({ permissions: rules }, null, 2) + "\n");
}
