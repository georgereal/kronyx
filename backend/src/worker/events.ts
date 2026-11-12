import type { Db } from "mongodb";
import { swallow } from "../lib/log";
import type { RunViewEvent } from "../../../src/agent/runner";

/**
 * Seq-numbered event writer for one run — same `run_events` shape as the
 * extension's /api/ingest sync so the web timeline renders both sources.
 */
export class RunSink {
	private seq = 0;
	private maskSecrets: string[] = [];

	constructor(
		private readonly db: Db,
		readonly uid: string,
		readonly runId: string,
		readonly sessionId: string,
	) {}

	mask(secret: string | undefined): void {
		if (secret && secret.length > 6 && !this.maskSecrets.includes(secret)) this.maskSecrets.push(secret);
	}

	async init(): Promise<void> {
		const last = await this.db
			.collection("run_events")
			.find({ uid: this.uid, runId: this.runId })
			.sort({ seq: -1 })
			.limit(1)
			.next();
		this.seq = (last?.seq as number | undefined) ?? 0;
		await this.patchRun({ status: "running", startedAt: new Date() });
	}

	private scrub(event: RunViewEvent | Record<string, unknown>): Record<string, unknown> {
		if (!this.maskSecrets.length) return event as Record<string, unknown>;
		let raw = JSON.stringify(event);
		for (const s of this.maskSecrets) raw = raw.split(s).join("•••");
		return JSON.parse(raw);
	}

	private queue: Record<string, unknown>[] = [];
	private pumping = false;
	private readonly MAX_QUEUE = 10_000;

	/** Buffered emit: never throws; drains via pump with retry/backoff.
	 *  `extra` lands as top-level fields on the run_events doc (e.g. agentIndex). */
	async emit(event: RunViewEvent | Record<string, unknown>, extra?: { agentIndex?: number }): Promise<void> {
		this.queue.push({ ...this.scrub(event), ...extra });
		// Cap: drop oldest token deltas only — tool/status/finish events must land.
		while (this.queue.length > this.MAX_QUEUE) {
			const i = this.queue.findIndex((e) => e.type === "reasoning-delta" || e.type === "assistant-delta");
			if (i < 0) break;
			this.queue.splice(i, 1);
		}
		void this.pump();
	}

	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			while (this.queue.length) {
				const event = this.queue[0];
				let attempt = 0;
				for (;;) {
					try {
						await this.db.collection("run_events").insertOne({
							uid: this.uid,
							runId: this.runId,
							sessionId: this.sessionId,
							seq: ++this.seq,
							event,
							ingestedAt: new Date(),
						});
						this.queue.shift();
						break;
					} catch (err) {
						// Transient Mongo/network — back off and retry, event stays queued.
						const wait = [500, 2000, 5000][Math.min(attempt++, 2)];
						console.error(`[sink] emit retry ${attempt} for ${this.runId}:`, (err as Error).message);
						await new Promise((r) => setTimeout(r, wait));
					}
				}
			}
		} finally {
			this.pumping = false;
		}
	}

	/** Wait for the queue to fully drain — call before run-end status patches. */
	async drain(): Promise<void> {
		while (this.queue.length || this.pumping) await new Promise((r) => setTimeout(r, 200));
	}

	async patchRun(patch: Record<string, unknown>): Promise<void> {
		await this.db.collection("runs").updateOne(
			{ uid: this.uid, runId: this.runId },
			{ $set: { uid: this.uid, runId: this.runId, sessionId: this.sessionId, ...patch, updatedAt: new Date() } },
			{ upsert: true },
		);
		await this.db
			.collection("sessions")
			.updateOne({ uid: this.uid, sessionId: this.sessionId }, { $set: { updatedAt: new Date() } })
			.catch(swallow("events", "op"));
	}

	async patchSession(patch: Record<string, unknown>): Promise<void> {
		await this.db
			.collection("sessions")
			.updateOne({ uid: this.uid, sessionId: this.sessionId }, { $set: { ...patch, updatedAt: new Date() } });
	}
}
