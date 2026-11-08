import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import Sqlite, { type Database } from "better-sqlite3";

export type Store = Database;

let db: Store | undefined;
let tried = false;
let storageDir = "";
let wasmDir = "";
let dbFile = "";

/** Directory containing sql-wasm.wasm (the extension's dist/). */
export function setWasmDir(dir: string): void {
	wasmDir = dir;
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastError = "";
/** No-op kept for call sites — better-sqlite3 reads the shared WAL file
 *  directly, so cross-process rows are always current. */
export async function refreshStore(): Promise<void> {}

export function storeError(): string {
	return lastError;
}

/** Global state directory — inside extension storage, not the repo. */
export function setStorageDir(dir: string): void {
	storageDir = dir;
}

/** Kronyx store backed by SQLite (better-sqlite3 — WAL; all extension hosts share the file). */
export async function openStore(root: string): Promise<Store | undefined> {
	if (db || tried) return db;
	tried = true;
	try {
		const dir = storageDir || path.join(root, ".kronyx");
		await fs.mkdir(dir, { recursive: true });
		dbFile = path.join(dir, "kronyx.db");
		db = new Sqlite(dbFile);
		db.pragma("journal_mode = WAL");
		db.exec(`CREATE TABLE IF NOT EXISTS runs(
			id INTEGER PRIMARY KEY, root TEXT, task TEXT, session TEXT, status TEXT,
			duration_ms INTEGER, at INTEGER)`);
		for (const col of ["tokens_in INTEGER", "tokens_out INTEGER", "cache_read INTEGER", "cache_write INTEGER"]) {
			try {
				db.exec(`ALTER TABLE runs ADD COLUMN ${col}`);
			} catch { /* column exists */ }
		}
		db.exec(`CREATE TABLE IF NOT EXISTS usage_history(
			id INTEGER PRIMARY KEY, root TEXT, session TEXT, task TEXT,
			tokens_in INTEGER, tokens_out INTEGER, at INTEGER)`);
		for (const col of ["cache_read INTEGER", "cache_write INTEGER"]) {
			try {
				db.exec(`ALTER TABLE usage_history ADD COLUMN ${col}`);
			} catch { /* column exists */ }
		}
		db.exec(`CREATE TABLE IF NOT EXISTS api_calls(
			id INTEGER PRIMARY KEY, root TEXT, session TEXT, task TEXT, at INTEGER,
			status TEXT, provider TEXT, base_url TEXT, model TEXT, profile TEXT,
			key_label TEXT, device TEXT, device_id TEXT, tokens_in INTEGER, tokens_out INTEGER,
			cache_read INTEGER, cache_write INTEGER, cost_usd REAL, duration_ms INTEGER,
			synced INTEGER DEFAULT 0, synced_at INTEGER)`);
		db.exec(`CREATE TABLE IF NOT EXISTS eval_results(
			id INTEGER PRIMARY KEY, root TEXT, name TEXT, model TEXT, status TEXT,
			passed INTEGER, details TEXT, iterations INTEGER, duration_ms INTEGER, at INTEGER)`);
		db.exec(`CREATE TABLE IF NOT EXISTS transcripts(
			id INTEGER PRIMARY KEY, root TEXT, session TEXT, at INTEGER, messages TEXT)`);
		db.exec(`CREATE TABLE IF NOT EXISTS episodes(
			id INTEGER PRIMARY KEY, root TEXT, kind TEXT, path TEXT, task TEXT, at TEXT)`);
		try {
			db.exec(`ALTER TABLE episodes ADD COLUMN data TEXT`);
		} catch { /* column exists */ }
		db.exec(`CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)`);
		db.exec(`CREATE TABLE IF NOT EXISTS session_events(
			id INTEGER PRIMARY KEY, root TEXT, session TEXT, event TEXT)`);
		for (const col of ["run_id TEXT", "synced INTEGER DEFAULT 0"]) {
			try {
				db.exec(`ALTER TABLE session_events ADD COLUMN ${col}`);
			} catch { /* column exists */ }
		}
		db.exec(`CREATE TABLE IF NOT EXISTS prs(
			id INTEGER PRIMARY KEY, root TEXT, run_id TEXT, session TEXT, task TEXT,
			repo TEXT, branch TEXT, url TEXT, title TEXT, status TEXT, at INTEGER,
			synced INTEGER DEFAULT 0)`);
		for (const col of ["run_id TEXT", "synced INTEGER DEFAULT 0"]) {
			try {
				db.exec(`ALTER TABLE runs ADD COLUMN ${col}`);
			} catch { /* column exists */ }
		}
		try {
			db.exec(`ALTER TABLE api_calls ADD COLUMN run_id TEXT`);
		} catch { /* column exists */ }
		db.exec(`CREATE TABLE IF NOT EXISTS sandboxes(
			id INTEGER PRIMARY KEY, root TEXT, sandbox_id TEXT, device TEXT, device_id TEXT,
			template TEXT, repo TEXT, run_id TEXT, event TEXT, at INTEGER,
			synced INTEGER DEFAULT 0)`);
		db.exec(`CREATE TABLE IF NOT EXISTS chunks(
			root TEXT, path TEXT, idx INTEGER, text TEXT, embedding BLOB,
			PRIMARY KEY(root, path, idx))`);
	} catch (error) {
		lastError = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
		db = undefined;
	}
	return db;
}

const nullify = (v: unknown): unknown => (v === undefined ? null : v);

const run = (d: Store | undefined, sql: string, params: unknown[]): void => {
	if (!d) return;
	d.prepare(sql).run(...params.map(nullify));
};

const all = (d: Store | undefined, sql: string, params: unknown[]): Record<string, unknown>[] => {
	if (!d) return [];
	return d.prepare(sql).all(...params.map(nullify)) as Record<string, unknown>[];
};

// ---------- runs ----------

export function insertRun(d: Store | undefined, run2: { task: string; session: string; status: string; durationMs: number; at: number; tokensIn?: number; tokensOut?: number; cacheRead?: number; cacheWrite?: number; runId?: string }, root = ""): void {
	try {
		run(d, "INSERT INTO runs(root, task, session, status, duration_ms, at, tokens_in, tokens_out, cache_read, cache_write, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			root, run2.task, run2.session, run2.status, run2.durationMs, run2.at, run2.tokensIn ?? 0, run2.tokensOut ?? 0, run2.cacheRead ?? 0, run2.cacheWrite ?? 0, run2.runId ?? "",
		]);
	} catch { /* store unavailable */ }
}

export function listUnsyncedRuns(d: Store | undefined, limit = 100): Record<string, unknown>[] {
	try {
		return all(d, "SELECT * FROM runs WHERE synced = 0 AND run_id != '' ORDER BY at LIMIT ?", [limit]);
	} catch {
		return [];
	}
}

export function markRunsSynced(d: Store | undefined, ids: number[]): void {
	if (!d || ids.length === 0) return;
	try {
		run(d, `UPDATE runs SET synced = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
	} catch { /* store unavailable */ }
}

// ---------- prs (cloud-run pull requests) ----------

export function insertPr(d: Store | undefined, pr: { runId: string; session: string; task: string; repo: string; branch: string; url: string; title: string; status?: string; at?: number }, root = ""): void {
	try {
		run(d, "INSERT INTO prs(root, run_id, session, task, repo, branch, url, title, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			root, pr.runId, pr.session, pr.task, pr.repo, pr.branch, pr.url, pr.title, pr.status ?? "open", pr.at ?? Date.now(),
		]);
	} catch { /* store unavailable */ }
}

export function listUnsyncedPrs(d: Store | undefined, limit = 100): Record<string, unknown>[] {
	try {
		return all(d, "SELECT * FROM prs WHERE synced = 0 ORDER BY at LIMIT ?", [limit]);
	} catch {
		return [];
	}
}

export function markPrsSynced(d: Store | undefined, ids: number[]): void {
	if (!d || ids.length === 0) return;
	try {
		run(d, `UPDATE prs SET synced = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
	} catch { /* store unavailable */ }
}

// ---------- sandboxes (E2B lifecycle rows) ----------

export function insertSandboxEvent(d: Store | undefined, e: { sandboxId: string; device?: string; deviceId?: string; template?: string; repo?: string; runId?: string; event: string; at?: number }, root = ""): void {
	try {
		run(d, "INSERT INTO sandboxes(root, sandbox_id, device, device_id, template, repo, run_id, event, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			root, e.sandboxId, e.device ?? "", e.deviceId ?? "", e.template ?? "", e.repo ?? "", e.runId ?? "", e.event, e.at ?? Date.now(),
		]);
	} catch { /* store unavailable */ }
}

export function listUnsyncedSandboxEvents(d: Store | undefined, limit = 200): Record<string, unknown>[] {
	try {
		return all(d, "SELECT * FROM sandboxes WHERE synced = 0 ORDER BY at LIMIT ?", [limit]);
	} catch {
		return [];
	}
}

export function markSandboxEventsSynced(d: Store | undefined, ids: number[]): void {
	if (!d || ids.length === 0) return;
	try {
		run(d, `UPDATE sandboxes SET synced = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
	} catch { /* store unavailable */ }
}

/** Session-level rollups for the Agents sidebar: title = first run's task. */
/** One-time import of rows from a legacy per-workspace `.kronyx/kronyx.db` into
 *  the shared profile store. Idempotent via a kv flag per source file. */
export function migrateLegacyStore(legacyPath: string): void {
	if (!db || legacyPath === dbFile) return;
	try {
		if (all(db, "SELECT value FROM kv WHERE key = ?", [`migrated:${legacyPath}`]).length) return;
		if (!existsSync(legacyPath)) return;
		db.exec(`ATTACH DATABASE '${legacyPath.replace(/'/g, "''")}' AS legacy`);
		for (const t of ["runs", "session_events", "api_calls", "usage_history", "prs", "transcripts", "episodes", "kv", "sandboxes", "eval_results", "chunks"]) {
			try {
				const cols = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[])
					.map((c) => c.name).filter((n) => n !== "id");
				if (!cols.length) continue;
				db.exec(`INSERT INTO main.${t} (${cols.join(",")}) SELECT ${cols.join(",")} FROM legacy.${t}`);
			} catch { /* table missing in legacy db */ }
		}
		db.exec("DETACH DATABASE legacy");
		run(db, "INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)", [`migrated:${legacyPath}`, String(Date.now())]);
	} catch { /* migration best-effort */ }
}

export function listSessions(d: Store | undefined, limit = 50, root?: string): { session: string; title: string; events: number; lastAt: number; status: string; cloud: boolean }[] {
	try {
		const rows = all(
			d,
			`SELECT session, COUNT(*) AS events, MAX(id) AS lastId FROM session_events
			 ${root ? "WHERE root = ?" : ""} GROUP BY session ORDER BY lastId DESC LIMIT ?`,
			root ? [root, limit] : [limit],
		);
		return rows.map((r) => {
			const session = String(r.session ?? "");
			let title = session;
			for (const e of all(d, "SELECT event FROM session_events WHERE session = ? ORDER BY id LIMIT 20", [session])) {
				try {
					const j = JSON.parse(String(e.event)) as { type?: string; task?: string };
					if (j.type === "run-started" && j.task) {
						title = String(j.task).slice(0, 60);
						break;
					}
				} catch { /* skip */ }
			}
			const lastRun = all(d, "SELECT at, status FROM runs WHERE session = ? ORDER BY at DESC LIMIT 1", [session])[0];
			return {
				session,
				title,
				events: Number(r.events ?? 0),
				lastAt: Number(lastRun?.at ?? 0),
				status: String(lastRun?.status ?? "completed"),
				cloud: session.startsWith("Cloud"),
			};
		});
	} catch {
		return [];
	}
}

export function listRuns(d: Store | undefined, limit = 50, root?: string): { task: string; session: string; status: string; duration_ms: number; at: number }[] {
	try {
		return (root
			? all(d, "SELECT task, session, status, duration_ms, at, tokens_in, tokens_out, cache_read, cache_write FROM runs WHERE root = ? ORDER BY at DESC LIMIT ?", [root, limit])
			: all(d, "SELECT task, session, status, duration_ms, at, tokens_in, tokens_out, cache_read, cache_write FROM runs ORDER BY at DESC LIMIT ?", [limit])) as {
			task: string; session: string; status: string; duration_ms: number; at: number; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number;
		}[];
	} catch {
		return [];
	}
}

// ---------- session events ----------

export function appendEvent(d: Store | undefined, session: string, event: unknown, root = "", runId = ""): void {
	try {
		run(d, "INSERT INTO session_events(root, session, event, run_id) VALUES (?, ?, ?, ?)", [root, session, JSON.stringify(event), runId]);
	} catch { /* store unavailable */ }
}

export function listUnsyncedRunEvents(d: Store | undefined, limit = 500): Record<string, unknown>[] {
	try {
		return all(d, "SELECT * FROM session_events WHERE synced = 0 AND run_id != '' ORDER BY id LIMIT ?", [limit]);
	} catch {
		return [];
	}
}

export function markRunEventsSynced(d: Store | undefined, ids: number[]): void {
	if (!d || ids.length === 0) return;
	try {
		run(d, `UPDATE session_events SET synced = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
	} catch { /* store unavailable */ }
}

export function listEvents(d: Store | undefined, session: string, root?: string): unknown[] {
	try {
		const rows = root
			? all(d, "SELECT event FROM session_events WHERE session = ? AND root = ? ORDER BY id", [session, root])
			: all(d, "SELECT event FROM session_events WHERE session = ? ORDER BY id", [session]);
		return rows.map((r) => JSON.parse(String(r.event)));
	} catch {
		return [];
	}
}

/** Most recently active session name for a workspace (by last event id). */
export function latestSession(d: Store | undefined, root: string): string | undefined {
	try {
		const rows = all(d, "SELECT session FROM session_events WHERE root = ? ORDER BY id DESC LIMIT 1", [root]);
		return rows[0] ? String(rows[0].session) : undefined;
	} catch {
		return undefined;
	}
}

export function clearEvents(d: Store | undefined, session: string, root?: string): void {
	try {
		if (root) run(d, "DELETE FROM session_events WHERE session = ? AND root = ?", [session, root]);
		else run(d, "DELETE FROM session_events WHERE session = ?", [session]);
	} catch { /* store unavailable */ }
}

// ---------- kv ----------

export function kvSet(d: Store | undefined, key: string, value: unknown): void {
	try {
		run(d, "INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
	} catch { /* store unavailable */ }
}

export function kvGet<T>(d: Store | undefined, key: string): T | undefined {
	try {
		const rows = all(d, "SELECT value FROM kv WHERE key = ?", [key]);
		return rows[0] ? (JSON.parse(String(rows[0].value)) as T) : undefined;
	} catch {
		return undefined;
	}
}

// ---------- chunks ----------

export function upsertChunk(d: Store | undefined, path2: string, idx: number, text: string, embedding: Float32Array, root = ""): void {
	try {
		run(d, "INSERT OR REPLACE INTO chunks(root, path, idx, text, embedding) VALUES (?, ?, ?, ?, ?)", [
			root, path2, idx, text,
			Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
		]);
	} catch { /* store unavailable */ }
}

export function deleteChunks(d: Store | undefined, path2: string, root?: string): void {
	try {
		if (root) run(d, "DELETE FROM chunks WHERE path = ? AND root = ?", [path2, root]);
		else run(d, "DELETE FROM chunks WHERE path = ?", [path2]);
	} catch { /* store unavailable */ }
}

export function listChunks(d: Store | undefined, limit = 20000, root?: string): { path: string; text: string; embedding: Float32Array }[] {
	try {
		const rows = root
			? all(d, "SELECT path, text, embedding FROM chunks WHERE root = ? LIMIT ?", [root, limit])
			: all(d, "SELECT path, text, embedding FROM chunks LIMIT ?", [limit]);
		return rows.map((r) => {
			const buf = r.embedding instanceof Uint8Array ? Buffer.from(r.embedding) : (r.embedding as Buffer);
			return {
				path: String(r.path),
				text: String(r.text),
				embedding: new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)),
			};
		});
	} catch {
		return [];
	}
}

// ---------- usage history ----------

export function insertUsage(
	d: Store | undefined,
	u: { session: string; task: string; tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number; at: number },
	root = "",
): void {
	try {
		run(d, "INSERT INTO usage_history(root, session, task, tokens_in, tokens_out, cache_read, cache_write, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
			root, u.session, u.task, u.tokensIn, u.tokensOut, u.cacheRead ?? 0, u.cacheWrite ?? 0, u.at,
		]);
	} catch { /* store unavailable */ }
}

export function listUsage(
	d: Store | undefined,
	session?: string,
	limit = 500,
): { session: string; task: string; tokens_in: number; tokens_out: number; at: number }[] {
	try {
		return (session
			? all(d, "SELECT session, task, tokens_in, tokens_out, cache_read, cache_write, at FROM usage_history WHERE session = ? ORDER BY at DESC LIMIT ?", [session, limit])
			: all(d, "SELECT session, task, tokens_in, tokens_out, cache_read, cache_write, at FROM usage_history ORDER BY at DESC LIMIT ?", [limit])) as {
			session: string; task: string; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number; at: number;
		}[];
	} catch {
		return [];
	}
}

// ---------- api calls (per-request usage ledger, syncable) ----------

export interface ApiCallRow {
	session: string;
	task: string;
	at: number;
	status: string;
	provider?: string;
	baseUrl?: string;
	model?: string;
	profile?: string;
	keyLabel?: string;
	device?: string;
	deviceId?: string;
	tokensIn: number;
	tokensOut: number;
	cacheRead?: number;
	cacheWrite?: number;
	costUsd?: number;
	durationMs?: number;
	runId?: string;
}

export function insertApiCall(d: Store | undefined, call: ApiCallRow, root = ""): number {
	if (!d) return -1;
	try {
		run(
			d,
			`INSERT INTO api_calls(root, session, task, at, status, provider, base_url, model, profile, key_label,
				device, device_id, run_id, tokens_in, tokens_out, cache_read, cache_write, cost_usd, duration_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				root, call.session, call.task, call.at, call.status, call.provider ?? "", call.baseUrl ?? "",
				call.model ?? "", call.profile ?? "", call.keyLabel ?? "", call.device ?? "", call.deviceId ?? "",
				call.runId ?? "",
				call.tokensIn, call.tokensOut, call.cacheRead ?? 0, call.cacheWrite ?? 0,
				call.costUsd ?? null, call.durationMs ?? 0,
			],
		);
		const rows = all(d, "SELECT last_insert_rowid() AS id", []);
		return rows[0] ? Number(rows[0].id) : -1;
	} catch {
		return -1;
	}
}

/** Update the outcome of an api_calls row once the run ends (status/duration known late). */
export function updateApiCall(d: Store | undefined, id: number, patch: { status?: string; durationMs?: number }): void {
	if (!d || id < 0) return;
	try {
		if (patch.status !== undefined) run(d, "UPDATE api_calls SET status = ? WHERE id = ?", [patch.status, id]);
		if (patch.durationMs !== undefined) run(d, "UPDATE api_calls SET duration_ms = ? WHERE id = ?", [patch.durationMs, id]);
	} catch { /* store unavailable */ }
}

export interface ApiCallFilter {
	since?: number;
	until?: number;
	model?: string;
	status?: string;
	limit?: number;
}

export function listApiCalls(d: Store | undefined, filter: ApiCallFilter = {}, root?: string): Record<string, unknown>[] {
	const where: string[] = [];
	const params: unknown[] = [];
	if (root !== undefined) { where.push("root = ?"); params.push(root); }
	if (filter.since !== undefined) { where.push("at >= ?"); params.push(filter.since); }
	if (filter.until !== undefined) { where.push("at <= ?"); params.push(filter.until); }
	if (filter.model) { where.push("model = ?"); params.push(filter.model); }
	if (filter.status) { where.push("status = ?"); params.push(filter.status); }
	const sql = `SELECT * FROM api_calls${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ?`;
	params.push(filter.limit ?? 500);
	try {
		return all(d, sql, params);
	} catch {
		return [];
	}
}

export function listUnsyncedApiCalls(d: Store | undefined, limit = 200): Record<string, unknown>[] {
	try {
		return all(d, "SELECT * FROM api_calls WHERE synced = 0 ORDER BY at LIMIT ?", [limit]);
	} catch {
		return [];
	}
}

export function markApiCallsSynced(d: Store | undefined, ids: number[]): void {
	if (!d || ids.length === 0) return;
	try {
		run(d, `UPDATE api_calls SET synced = 1, synced_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`, [Date.now(), ...ids]);
	} catch { /* store unavailable */ }
}

// ---------- episodes ----------

export function insertEpisode(d: Store | undefined, ep: { kind: string; path?: string; task?: string; at: string; data?: Record<string, unknown> }, root = ""): void {
	try {
		run(d, "INSERT INTO episodes(root, kind, path, task, at, data) VALUES (?, ?, ?, ?, ?, ?)", [
			root, ep.kind, ep.path ?? "", ep.task ?? "", ep.at, ep.data ? JSON.stringify(ep.data) : "",
		]);
	} catch { /* store unavailable */ }
}

// ---------- eval results ----------

export interface EvalResultRow {
	name: string;
	model?: string;
	status: string;
	passed: boolean;
	details: string;
	iterations: number;
	durationMs: number;
	at: number;
}

export function insertEvalResult(d: Store | undefined, r: EvalResultRow, root = ""): void {
	try {
		run(d, "INSERT INTO eval_results(root, name, model, status, passed, details, iterations, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			root, r.name, r.model ?? "", r.status, r.passed ? 1 : 0, r.details, r.iterations, r.durationMs, r.at,
		]);
	} catch { /* store unavailable */ }
}

export function listEvalResults(d: Store | undefined, limit = 200, root?: string): Record<string, unknown>[] {
	try {
		return root
			? all(d, "SELECT name, model, status, passed, details, iterations, duration_ms, at FROM eval_results WHERE root = ? ORDER BY at DESC LIMIT ?", [root, limit])
			: all(d, "SELECT name, model, status, passed, details, iterations, duration_ms, at FROM eval_results ORDER BY at DESC LIMIT ?", [limit]);
	} catch {
		return [];
	}
}

// ---------- transcripts (cold recall) ----------

export function insertTranscript(d: Store | undefined, session: string, messages: unknown, root = ""): void {
	try {
		run(d, "INSERT INTO transcripts(root, session, at, messages) VALUES (?, ?, ?, ?)", [
			root, session, Date.now(), JSON.stringify(messages),
		]);
	} catch { /* store unavailable */ }
}

export function listTranscripts(d: Store | undefined, session: string, root = ""): { label: string; messages: unknown[] }[] {
	try {
		const rows = all(d, "SELECT id, messages FROM transcripts WHERE session = ? AND root = ? ORDER BY id DESC LIMIT 5", [session, root]);
		// newest first in SQL; reverse so runIndex 0 = oldest
		return rows.map((r) => ({
			label: `run ${String(r.id)}`,
			messages: (JSON.parse(String(r.messages)) as unknown[]) ?? [],
		})).reverse();
	} catch {
		return [];
	}
}
