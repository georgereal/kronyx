/** Mongo harness event ledger (cloud). One append-only lane per scope key; the
 * ledger is authoritative and replayable exactly like the IDE JSONL log. */

import type { Db } from "mongodb";
import type { EventLog } from "../../../src/harness/core/eventLog";
import { parseSessionEvent, type NewEvent, type SessionEvent } from "../../../src/harness/core/contracts";

export class MongoHarnessEventLog implements EventLog {
	private cached: SessionEvent[] | undefined;

	constructor(
		private readonly db: Db,
		private readonly uid: string,
		/** Logical ledger lane: usually the session id, or sessionId:slice for parallel agents. */
		private readonly scope: string,
	) {}

	private collection() {
		return this.db.collection("harness_events");
	}

	async append(event: NewEvent): Promise<SessionEvent> {
		// Session lanes are single-writer by job design; the unique index is the
		// hard guard. On a rare duplicate (re-claimed worker), reload and retry.
		for (let attempt = 0; attempt < 3; attempt++) {
			const last = await this.collection()
				.find({ uid: this.uid, scope: this.scope }, { projection: { seq: 1 } })
				.sort({ seq: -1 })
				.limit(1)
				.next();
			const seq = Number(last?.seq ?? 0) + 1;
			const stamped = { ...event, seq, at: Date.now() } as SessionEvent;
			try {
				await this.collection().insertOne({ uid: this.uid, scope: this.scope, seq, runId: event.runId, type: event.type, at: new Date(stamped.at), event: stamped, ingestedAt: new Date() });
				if (this.cached) this.cached.push(stamped);
				return stamped;
			} catch (err) {
				if (attempt === 2 || !String((err as { message?: unknown })?.message ?? err).includes("E11000")) throw err;
				this.cached = undefined;
			}
		}
		throw new Error("unreachable");
	}

	async read(): Promise<SessionEvent[]> {
		if (this.cached) return [...this.cached];
		const docs = await this.collection().find({ uid: this.uid, scope: this.scope }, { projection: { event: 1, seq: 1 } }).sort({ seq: 1 }).toArray();
		const events: SessionEvent[] = [];
		for (const doc of docs) {
			const event = parseSessionEvent(doc.event);
			if (event.seq !== events.length + 1) throw new Error(`harness_events ${this.scope}: seq ${event.seq} out of order, expected ${events.length + 1}`);
			events.push(event);
		}
		this.cached = events;
		return [...events];
	}
}
