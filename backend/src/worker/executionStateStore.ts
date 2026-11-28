/** Mongo execution-state snapshots (cloud). Derived/rebuildable; harness events remain authoritative. */

import type { Db } from "mongodb";
import type { ExecutionStateStore } from "../../../src/context/contracts/ports";
import type { ExecutionState } from "../../../src/context/contracts/execution";
import { assertExecutionState } from "../../../src/context/state/executionState";

export class MongoExecutionStateStore implements ExecutionStateStore {
	constructor(
		private readonly db: Db,
		private readonly uid: string,
	) {}

	private collection() {
		return this.db.collection("execution_states");
	}

	async load(sessionId: string, runId?: string): Promise<ExecutionState | undefined> {
		const filter: Record<string, unknown> = { uid: this.uid, sessionId };
		if (runId !== undefined) filter.runId = runId;
		const doc = await this.collection().find(filter).sort({ eventCursor: -1 }).limit(1).next();
		if (!doc?.state) return undefined;
		try {
			return assertExecutionState(doc.state as ExecutionState);
		} catch {
			return undefined;
		}
	}

	async save(state: ExecutionState): Promise<void> {
		assertExecutionState(state);
		await this.collection().updateOne(
			{ uid: this.uid, sessionId: state.sessionId, runId: state.runId ?? "" },
			{ $set: { uid: this.uid, sessionId: state.sessionId, runId: state.runId ?? "", stateVersion: state.stateVersion, eventCursor: state.eventCursor, state, updatedAt: new Date() } },
			{ upsert: true },
		);
	}
}
