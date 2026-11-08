import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { listInstallations, installationRepos } from "@/lib/githubApp";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

/** GET /api/github/repos — repos across all app installations (+ their installation ids). */
export async function GET(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	// Prefer the user's own linked installation; fall back to all app installs.
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
	return NextResponse.json({
		repos: out,
		configured: !!process.env.GITHUB_APP_ID && !!process.env.GITHUB_APP_PRIVATE_KEY,
		appSlug: (process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "")
			.replace(/^https?:\/\/github\.com\/apps\//, "")
			.replace(/\/.*/, ""),
	});
}
