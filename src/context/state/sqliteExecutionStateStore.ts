/** SQLite execution-state snapshots (IDE/local). The event ledger remains authoritative; snapshots are rebuildable acceleration/audit state. */

import type { Database } from "better-sqlite3";
import type { ExecutionStateStore } from "../contracts/ports";
import type { ExecutionState } from "../contracts/execution";
import { assertExecutionState } from "./executionState";

export function migrateExecutionStateStore(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS execution_states(
		session_id TEXT NOT NULL,
		run_id TEXT NOT NULL DEFAULT '',
		state_version INTEGER NOT NULL,
		event_cursor INTEGER NOT NULL,
		state_hash TEXT,
		state_json TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY(session_id, run_id)
	)`);
	db.exec(`CREATE INDEX IF NOT EXISTS execution_states_session ON execution_states(session_id, event_cursor)`);
}

export class SqliteExecutionStateStore implements ExecutionStateStore {
	constructor(private readonly db: Database) {
		migrateExecutionStateStore(db);
	}

	async load(sessionId: string, runId?: string): Promise<ExecutionState | undefined> {
		const row = runId === undefined
			? this.db.prepare("SELECT state_json FROM execution_states WHERE session_id = ? ORDER BY event_cursor DESC LIMIT 1").get(sessionId)
			: this.db.prepare("SELECT state_json FROM execution_states WHERE session_id = ? AND run_id = ?").get(sessionId, runId);
		if (!row) return undefined;
		try {
			return assertExecutionState(JSON.parse(String((row as Record<string, unknown>).state_json)) as ExecutionState);
		} catch {
			return undefined;
		}
	}

	async save(state: ExecutionState): Promise<void> {
		assertExecutionState(state);
		this.db.prepare(`INSERT OR REPLACE INTO execution_states(session_id, run_id, state_version, event_cursor, state_hash, state_json, updated_at)
			VALUES (?, ?, ?, ?, NULL, ?, ?)`).run(
			state.sessionId,
			state.runId ?? "",
			state.stateVersion,
			state.eventCursor,
			JSON.stringify(state),
			state.updatedAt,
		);
	}
}
