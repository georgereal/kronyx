import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { installationToken } from "@/lib/githubApp";

export const runtime = "nodejs";

/** POST /api/github/token {installationId} — short-lived installation token for clone/push/PR. */
export async function POST(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const { installationId } = (await req.json().catch(() => ({}))) as { installationId?: number };
	if (!installationId) return NextResponse.json({ error: "installationId required" }, { status: 400 });
	const token = await installationToken(installationId).catch(() => "");
	if (!token) return NextResponse.json({ error: "token_failed" }, { status: 502 });
	return NextResponse.json({ token });
}
