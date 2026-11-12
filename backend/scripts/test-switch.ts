/**
 * Dry-run of the template-switch path (mirrors executor.switchTemplate):
 *   listTemplates → create "base" VM → write marker → "switch" → create
 *   "desktop" VM → verify GUI libs → kill both.
 *
 * Usage:  cd backend && npx tsx scripts/test-switch.ts [target-template]
 */
import { MongoClient } from "mongodb";
import { readFileSync } from "node:fs";
import { e2bProvider } from "../../src/sandbox/providers/e2b";
import { resolveTemplateName, type TemplateInfo } from "../../src/sandbox/templateCatalog";

// Load backend/.env
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
	const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
	if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const TARGET = process.argv[2] ?? "desktop";

async function main() {
	const mongo = new MongoClient(process.env.MONGODB_URI ?? "");
	await mongo.connect();
	const db = mongo.db();
	// Any user doc with an E2B key works for this test.
	const user = await db
		.collection("users")
		.findOne({ "settings.secrets.e2bApiKey": { $exists: true } }, { projection: { "settings.secrets.e2bApiKey": 1 } });
	const apiKey = user?.settings?.secrets?.e2bApiKey ?? process.env.E2B_API_KEY ?? "";
	if (!apiKey) throw new Error("No e2bApiKey in users.settings.secrets or E2B_API_KEY env");
	console.log(`[key] using ${apiKey.slice(0, 10)}… from ${user ? "mongo" : "env"}`);
	const creds = { secrets: { e2bApiKey: apiKey }, data: {} };

	// 1. Discovery
	const live: TemplateInfo[] = await e2bProvider.listTemplates!(creds);
	console.log(`[templates] ${live.length} usable:`);
	for (const t of live) console.log(`  - ${t.id} (${t.names.join(", ")})${t.public ? " [public]" : " [account]"}`);

	const target = resolveTemplateName(TARGET, live);
	if (!target) throw new Error(`Target "${TARGET}" not selectable`);
	console.log(`[target] ${TARGET} → ${target}`);

	// 2. Source VM on base: prove the gap + leave a marker (as committed work would).
	const sbxA = await e2bProvider.create(creds, { timeoutMs: 15 * 60_000 });
	const idA = sbxA.id;
	console.log(`[vm-a] base sandbox ${idA}`);
	const probeA = await sbxA.run("ldconfig -p 2>/dev/null | grep -ci libgl || echo 0; which Xvfb || echo 'no Xvfb'", { cwd: "/home/user" });
	console.log(`[vm-a] GL lib count / Xvfb: ${probeA.stdout.trim()}`);
	await sbxA.writeFile("/home/user/marker.txt", "work-before-switch");

	// 3. "Switch" — in the real flow we'd commit+push, kill A, create B.
	console.log(`[switch] killing vm-a, creating "${target}"…`);
	await e2bProvider.killById(idA, creds);
	const sbxB = await e2bProvider.create(creds, { template: target, timeoutMs: 15 * 60_000 });
	console.log(`[vm-b] ${target} sandbox ${sbxB.id}`);
	const probeB = await sbxB.run("ldconfig -p 2>/dev/null | grep -ci libgl || echo 0; which Xvfb xfce4-session || echo 'none'", { cwd: "/home/user" });
	console.log(`[vm-b] GL lib count / X tools: ${probeB.stdout.trim()}`);

	await e2bProvider.killById(sbxB.id, creds);
	console.log("[done] both sandboxes killed");
	await mongo.close();
}

main().catch((e) => {
	console.error("FAILED:", e instanceof Error ? e.message : e);
	process.exit(1);
});
