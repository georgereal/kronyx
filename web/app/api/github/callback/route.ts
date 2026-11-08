import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** GitHub redirects here after app install; we forward the id into the app UI to bind it. */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const id = url.searchParams.get("installation_id");
	return NextResponse.redirect(new URL(`/settings?installation=${encodeURIComponent(id ?? "")}`, url.origin));
}
