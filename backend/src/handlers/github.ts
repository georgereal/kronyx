import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { installationRepos, installationToken, listInstallations } from "../lib/githubApp";
import { json } from "../routes";
import { swallow } from "../lib/log";

/** GET /api/github/repos */
export async function repos(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const doc = await (await getDb()).collection<{ _id: string; githubInstallationId?: number }>("users").findOne({ _id: uid });
	const installs = doc?.githubInstallationId
		? [{ id: doc.githubInstallationId, account: { login: "", type: "" } }]
		: await listInstallations();
	const out: { repo: string; defaultBranch: string; installationId: number; owner: string }[] = [];
	for (const i of installs) {
		for (const r of await installationRepos(i.id)) {
			out.push({ repo: r.fullName, defaultBranch: r.defaultBranch, installationId: i.id, owner: i.account.login });
		}
	}
	return json({
		repos: out,
		configured: !!process.env.GITHUB_APP_ID && !!process.env.GITHUB_APP_PRIVATE_KEY,
		appSlug: (process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "").replace(/^https?:\/\/github\.com\/apps\//, "").replace(/\/.*/, ""),
	});
}

/** POST /api/github/token */
export async function token(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const { installationId } = (await req.json().catch(swallow("github", "bad json", {}))) as { installationId?: number };
	if (!installationId) return json({ error: "installationId required" }, { status: 400 });
	const t = await installationToken(installationId).catch(swallow("github", "installationToken", ""));
	if (!t) return json({ error: "token_failed" }, { status: 502 });
	return json({ token: t });
}

/** GET /api/github/callback — GitHub redirects here after install; forward into the web app. */
export function callback(req: Request): Response {
	const url = new URL(req.url);
	const id = url.searchParams.get("installation_id") ?? "";
	const web = process.env.WEB_APP_URL ?? "http://localhost:3000";
	return Response.redirect(`${web}/settings?installation=${encodeURIComponent(id)}`, 307);
}

/** POST /api/github/link */
export async function link(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const { installationId } = (await req.json().catch(swallow("github", "bad json", {}))) as { installationId?: number };
	if (!installationId) return json({ error: "installationId required" }, { status: 400 });
	const db = await getDb();
	await db.collection<{ _id: string }>("users").updateOne(
		{ _id: uid },
		{ $set: { githubInstallationId: installationId, githubLinkedAt: new Date() } },
		{ upsert: true },
	);
	return json({ ok: true });
}
