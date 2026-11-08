import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getAuth } from "firebase-admin/auth";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";

export const runtime = "nodejs";

function adminApp(): App {
	if (getApps().length) return getApps()[0];
	const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	if (!json) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
	return initializeApp({ credential: cert(JSON.parse(json)) });
}

/** GET /api/me — identity for the caller's API key or Firebase token. */
export async function GET(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	try {
		const user = await getAuth(adminApp()).getUser(uid);
		return NextResponse.json({ uid, email: user.email ?? null, name: user.displayName ?? null });
	} catch {
		return NextResponse.json({ uid });
	}
}
