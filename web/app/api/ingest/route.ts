import { NextResponse } from "next/server";
import { authenticate } from "@/lib/apiKeys";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

interface IncomingCall {
	clientRowId?: number;
	at?: number;
	status?: string;
	provider?: string;
	baseUrl?: string;
	model?: string;
	profile?: string;
	keyLabel?: string;
	device?: string;
	deviceId?: string;
	tokensIn?: number;
	tokensOut?: number;
	cacheRead?: number;
	cacheWrite?: number;
	costUsd?: number;
	durationMs?: number;
	session?: string;
	task?: string;
	workspace?: string;
	runId?: string;
}

interface IncomingRun {
	runId: string;
	task?: string;
	session?: string;
	status?: string;
	durationMs?: number;
	at?: number;
	tokensIn?: number;
	tokensOut?: number;
	workspace?: string;
}

interface IncomingEvent {
	runId: string;
	seq: number;
	session?: string;
	event?: unknown;
	workspace?: string;
}

interface IncomingPr {
	runId: string;
	session?: string;
	task?: string;
	repo?: string;
	branch?: string;
	url?: string;
	title?: string;
	status?: string;
	at?: number;
	workspace?: string;
}

/** POST /api/ingest — burst upload of api_calls + run/event/pr rows from the extension. */
export async function POST(req: Request) {
	const uid = await authenticate(req);
	if (!uid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	const body = (await req.json().catch(() => ({}))) as {
		calls?: IncomingCall[];
		runs?: IncomingRun[];
		events?: IncomingEvent[];
		prs?: IncomingPr[];
	sandboxes?: { sandboxId?: string; device?: string; deviceId?: string; template?: string; repo?: string; runId?: string; event?: string; at?: number; workspace?: string }[];
	};
	const calls = Array.isArray(body.calls) ? body.calls.slice(0, 500) : [];
	const runs = Array.isArray(body.runs) ? body.runs : [];
	const events = Array.isArray(body.events) ? body.events : [];
	const prs = Array.isArray(body.prs) ? body.prs : [];
	const sandboxes = Array.isArray(body.sandboxes) ? body.sandboxes : [];
	if (calls.length + runs.length + events.length + prs.length + sandboxes.length === 0) return NextResponse.json({ inserted: 0 });
	const db = await getDb();
	const docs = calls
		.filter((c) => typeof c.at === "number" && c.at > 0)
		.map((c) => ({
			uid,
			clientRowId: c.clientRowId,
			at: new Date(c.at!),
			status: c.status === "failed" ? "failed" : "ok",
			provider: c.provider ?? "",
			baseUrl: c.baseUrl ?? "",
			model: c.model ?? "",
			profile: c.profile ?? "",
			keyLabel: c.keyLabel ?? "",
			device: c.device ?? "",
			deviceId: c.deviceId ?? "",
			tokensIn: Number(c.tokensIn) || 0,
			tokensOut: Number(c.tokensOut) || 0,
			cacheRead: Number(c.cacheRead) || 0,
			cacheWrite: Number(c.cacheWrite) || 0,
			costUsd: typeof c.costUsd === "number" ? c.costUsd : null,
			durationMs: Number(c.durationMs) || 0,
			session: c.session ?? "",
			task: c.task ?? "",
			workspace: c.workspace ?? "",
			runId: c.runId ?? "",
			ingestedAt: new Date(),
		}));
	let inserted = 0;
	if (docs.length) {
		const result = await db.collection("usage_events").insertMany(docs, { ordered: false }).catch((e) => {
			// Duplicate (uid, clientRowId) on retry — count what made it in.
			return (e as { result?: { nInserted?: number } }).result ?? { nInserted: 0 };
		});
		inserted = "insertedCount" in result ? result.insertedCount : result.nInserted ?? 0;
	}
	const now = new Date();
	if (runs.length) {
		await db.collection("runs").bulkWrite(
			runs.map((r) => ({
				updateOne: {
					filter: { uid, runId: r.runId },
					update: { $set: { uid, ...r, updatedAt: now } },
					upsert: true,
				},
			})),
			{ ordered: false },
		);
	}
	if (events.length) {
		await db.collection("run_events").bulkWrite(
			events.map((e) => ({
				updateOne: {
					filter: { uid, runId: e.runId, seq: e.seq },
					update: { $setOnInsert: { uid, ...e, ingestedAt: now } },
					upsert: true,
				},
			})),
			{ ordered: false },
		);
	}
	if (prs.length) {
		await db.collection("prs").bulkWrite(
			prs.map((p) => ({
				updateOne: {
					filter: { uid, runId: p.runId },
					update: { $set: { uid, ...p, updatedAt: now } },
					upsert: true,
				},
			})),
			{ ordered: false },
		);
	}
	if (sandboxes.length) {
		await db.collection("sandboxes").insertMany(
			sandboxes.map((s) => ({ uid, ...s, at: new Date(Number(s.at) || Date.now()), ingestedAt: now })),
			{ ordered: false },
		).catch(() => {});
	}
	return NextResponse.json({ inserted, runs: runs.length, events: events.length, prs: prs.length, sandboxes: sandboxes.length });
}
