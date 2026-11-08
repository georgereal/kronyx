import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/** Lazy init — module load must not require env vars (Next build collects page data without them). */
function adminApp(): App {
	if (getApps().length) return getApps()[0];
	const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	if (!json) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
	return initializeApp({ credential: cert(JSON.parse(json)) });
}

/** Verify a Firebase ID token from `Authorization: Bearer …`; returns uid or null. */
export async function verifyRequest(req: Request): Promise<string | null> {
	const header = req.headers.get("authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (!token) return null;
	try {
		const decoded = await getAuth(adminApp()).verifyIdToken(token);
		return decoded.uid;
	} catch {
		return null;
	}
}
