import type { Db } from "mongodb";
import { swallow } from "./log";

export interface SandboxEventInput {
	uid: string;
	sandboxId: string;
	sessionId?: string;
	provider?: string;
	event: string; // "start" | "pause" | "resume" | "kill" | "stop" | ...
	state?: string;
	reason?: string;
	device?: string;
	runId?: string;
	at?: Date;
}

/** Append-only per-sandbox lifecycle log — `sandboxes` stays latest-state. */
export async function recordSandboxEvent(db: Db, e: SandboxEventInput): Promise<void> {
	if (!e.sandboxId) return;
	await db
		.collection("sandbox_events")
		.insertOne({ ...e, at: e.at ?? new Date(), ingestedAt: new Date() })
		.catch(swallow("sandboxEvents", "insert"));
}
