import { authenticate } from "../lib/apiKeys";
import { getDb } from "../lib/mongo";
import { createOrgRepo, getInstallation, installationRepos, installationToken, listInstallations, lookupAccountId } from "../lib/githubApp";
import type { Installation } from "../lib/githubApp";
import { json } from "../routes";
import { swallow } from "../lib/log";

const appSlug = () => (process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "").replace(/^https?:\/\/github\.com\/apps\//, "").replace(/\/.*/, "");

/** Installations the user has linked; falls back to all app installs (single-tenant dev). */
async function userInstallations(uid: string): Promise<Installation[]> {
	const doc = await (await getDb())
		.collection<{ _id: string; githubInstallationId?: number; githubInstallationIds?: number[] }>("users")
		.findOne({ _id: uid });
	const ids = doc?.githubInstallationIds?.length ? doc.githubInstallationIds : doc?.githubInstallationId ? [doc.githubInstallationId] : null;
	if (!ids) return listInstallations();
	const installs = await Promise.all(ids.map((id) => getInstallation(id).catch(swallow("github", "getInstallation", null))));
	return installs.filter((i): i is Installation => !!i);
}

/** GET /api/github/repos */
export async function repos(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const installs = await userInstallations(uid);
	const out: { repo: string; defaultBranch: string; installationId: number; owner: string }[] = [];
	for (const i of installs) {
		for (const r of await installationRepos(i.id)) {
			out.push({ repo: r.fullName, defaultBranch: r.defaultBranch, installationId: i.id, owner: i.account.login });
		}
	}
	return json({
		repos: out,
		installations: installs.map((i) => ({ id: i.id, account: i.account.login, type: i.account.type })),
		configured: !!process.env.GITHUB_APP_ID && !!process.env.GITHUB_APP_PRIVATE_KEY,
		appSlug: appSlug(),
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

/** GET /api/github/branches?installationId=&repo= — branch names for the start-point picker. */
export async function branches(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const inst = Number(url.searchParams.get("installationId"));
	const repo = url.searchParams.get("repo") ?? "";
	if (!inst || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "installationId and repo required" }, { status: 400 });
	const token = await installationToken(inst).catch(swallow("github", "installationToken", ""));
	if (!token) return json({ error: "token_failed" }, { status: 502 });
	const res = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
	}).catch(swallow("github", "branches", null));
	if (!res?.ok) return json({ branches: [] });
	const list = (await res.json()) as { name: string }[];
	return json({ branches: (Array.isArray(list) ? list : []).map((b) => b.name) });
}

/** GET /api/github/prs?installationId=&repo= — open PRs for the start-point picker. */
export async function prs(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const url = new URL(req.url);
	const inst = Number(url.searchParams.get("installationId"));
	const repo = url.searchParams.get("repo") ?? "";
	if (!inst || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return json({ error: "installationId and repo required" }, { status: 400 });
	const token = await installationToken(inst).catch(swallow("github", "installationToken", ""));
	if (!token) return json({ error: "token_failed" }, { status: 502 });
	const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=50&sort=updated`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
	}).catch(swallow("github", "prs", null));
	if (!res?.ok) return json({ prs: [] });
	const list = (await res.json()) as {
		number: number;
		title: string;
		head: { ref: string; repo?: { full_name: string } | null; user?: { login: string } };
		base: { ref: string };
	}[];
	return json({
		prs: (Array.isArray(list) ? list : []).map((p) => ({
			number: p.number,
			title: p.title,
			headRef: p.head.ref,
			headRepo: p.head.repo?.full_name ?? null,
			baseRef: p.base.ref,
			user: p.head.user?.login ?? "",
		})),
	});
}

/** POST /api/github/create-repo — create a repo in an org the app is installed on. */
export async function createRepo(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(swallow("github", "bad json", {}))) as {
		installationId?: number;
		name?: string;
		private?: boolean;
	};
	const name = (body.name ?? "").trim();
	if (!body.installationId || !/^[\w.-]{1,100}$/.test(name)) {
		return json({ error: "installationId and a valid repo name required" }, { status: 400 });
	}
	const inst = await getInstallation(body.installationId).catch(swallow("github", "getInstallation", null));
	if (!inst) return json({ error: "installation not found" }, { status: 404 });
	if (inst.account.type !== "Organization") {
		return json({ error: "repos can only be created on organization accounts — install the app on an org, or pick an existing repo" }, { status: 400 });
	}
	const repo = await createOrgRepo(body.installationId, inst.account.login, name, body.private !== false).catch((e: Error) => {
		swallow("github", "createOrgRepo", e);
		return null;
	});
	if (!repo) return json({ error: "create failed — the app may need Administration (write) permission on the org" }, { status: 502 });
	return json({ repo: { repo: repo.fullName, defaultBranch: repo.defaultBranch, installationId: body.installationId, owner: inst.account.login } });
}

/**
 * POST /api/github/resolve { repo: "owner/name" } — is the repo covered by an
 * installation the user can see? If yes, link that installation to the user and
 * return the repo; if not, return an install URL preselecting the owner account.
 */
export async function resolve(req: Request): Promise<Response> {
	const uid = await authenticate(req);
	if (!uid) return json({ error: "unauthorized" }, { status: 401 });
	const { repo } = (await req.json().catch(swallow("github", "bad json", {}))) as { repo?: string };
	const name = (repo ?? "").trim();
	if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return json({ error: "repo must be owner/name" }, { status: 400 });
	for (const inst of await userInstallations(uid)) {
		const hit = (await installationRepos(inst.id)).find((r) => r.fullName === name);
		if (hit) {
			await (await getDb()).collection("users").updateOne(
				{ _id: uid as never },
				{ $addToSet: { githubInstallationIds: inst.id }, $set: { githubInstallationId: inst.id } },
				{ upsert: true },
			).catch(swallow("github", "link installation", null));
			return json({ covered: true, repo: { repo: hit.fullName, defaultBranch: hit.defaultBranch, installationId: inst.id, owner: inst.account.login } });
		}
	}
	const owner = name.split("/")[0];
	const accountId = await lookupAccountId(owner).catch(swallow("github", "lookupAccountId", null));
	const base = `https://github.com/apps/${appSlug()}/installations/new`;
	return json({ covered: false, installUrl: accountId ? `${base}?suggested_target_id=${accountId}` : base });
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
	const inst = await getInstallation(installationId).catch(swallow("github", "getInstallation", null));
	if (!inst) return json({ error: "installation not found" }, { status: 404 });
	const db = await getDb();
	await db.collection<{ _id: string }>("users").updateOne(
		{ _id: uid },
		{ $addToSet: { githubInstallationIds: installationId }, $set: { githubInstallationId: installationId, githubLinkedAt: new Date() } },
		{ upsert: true },
	);
	return json({ ok: true });
}
