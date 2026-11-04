import { promises as fs } from "node:fs";
import * as path from "node:path";
import initSqlJs, { type Database } from "sql.js";

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

export function storeError(): string {
	return lastError;
}

/** Global state directory — inside extension storage, not the repo. */
export function setStorageDir(dir: string): void {
	storageDir = dir;
}

function persist(): void {
	if (!db || !dbFile) return;
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		if (db) void fs.writeFile(dbFile, Buffer.from(db.export())).catch(() => {});
	}, 250);
}

/** Kronyx store backed by SQLite (sql.js/WASM — no native deps in the extension host). */
export async function openStore(root: string): Promise<Store | undefined> {
	if (db || tried) return db;
	tried = true;
	try {
		const dir = storageDir || path.join(root, ".kronyx");
		await fs.mkdir(dir, { recursive: true });
		dbFile = path.join(dir, "kronyx.db");
		const wasmPath = path.join(wasmDir || __dirname, "sql-wasm.wasm");
		const SQL = await initSqlJs({ locateFile: () => wasmPath });
		const existing = await fs.readFile(dbFile).catch(() => undefined);
		db = new SQL.Database(existing ? new Uint8Array(existing) : undefined);
		db.run(`CREATE TABLE IF NOT EXISTS runs(
			id INTEGER PRIMARY KEY, root TEXT, task TEXT, session TEXT, status TEXT,
			duration_ms INTEGER, at INTEGER)`);
		for (const col of ["tokens_in INTEGER", "tokens_out INTEGER", "cache_read INTEGER", "cache_write INTEGER"]) {
			try {
				db.run(`ALTER TABLE runs ADD COLUMN ${col}`);
			} catch { /* column exists */ }
		}
		db.run(`CREATE TABLE IF NOT EXISTS usage_history(
			id INTEGER PRIMARY KEY, root TEXT, session TEXT, task TEXT,
			tokens_in INTEGER, tokens_out INTEGER, at INTEGER)`);
		for (const col of ["cache_read INTEGER", "cache_write INTEGER"]) {
			try {
				db.run(`ALTER TABLE usage_history ADD COLUMN ${col}`);
			} catch { /* column exists */ }
		}
		db.run(`CREATE TABLE IF NOT EXISTS eval_results(
			id INTEGER PRIMARY KEY, root TEXT, name TEXT, model TEXT, status TEXT,
			passed INTEGER, details TEXT, iterations INTEGER, duration_ms INTEGER, at INTEGER)`);
		db.run(`CREATE TABLE IF NOT EXISTS transcripts(
			id INTEGER PRIMARY KEY, root TEXT, session TEXT, at INTEGER, messages TEXT)`);
		db.run(`CREATE TABLE IF NOT EXISTS episodes(
			id INTEGER PRIMARY KEY, root TEXT, kind TEXT, path TEXT, task TEXT, at TEXT)`);
		try {
			db.run(`ALTER TABLE episodes ADD COLUMN data TEXT`);
		} catch { /* column exists */ }
		db.run(`CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)`);
		db.run(`CREATE TABLE IF NOT EXISTS session_events(
			id INTEGER PRIMARY KEY, root TEXT, session TEXT, event TEXT)`);
		db.run(`CREATE TABLE IF NOT EXISTS chunks(
			root TEXT, path TEXT, idx INTEGER, text TEXT, embedding BLOB,
			PRIMARY KEY(root, path, idx))`);
	} catch (error) {
		lastError = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
		db = undefined;
	}
	return db;
}

const run = (d: Store | undefined, sql: string, params: unknown[]): void => {
	if (!d) return;
	const stmt = d.prepare(sql);
	try {
		stmt.bind(params as string[]);
		stmt.step();
	} finally {
		stmt.free();
	}
	persist();
};

const all = (d: Store | undefined, sql: string, params: unknown[]): Record<string, unknown>[] => {
	if (!d) return [];
	const stmt = d.prepare(sql);
	const rows: Record<string, unknown>[] = [];
	try {
		stmt.bind(params as string[]);
		while (stmt.step()) rows.push(stmt.getAsObject());
	} finally {
		stmt.free();
	}
	return rows;
};

// ---------- runs ----------

export function insertRun(d: Store | undefined, run2: { task: string; session: string; status: string; durationMs: number; at: number; tokensIn?: number; tokensOut?: number; cacheRead?: number; cacheWrite?: number }, root = ""): void {
	try {
		run(d, "INSERT INTO runs(root, task, session, status, duration_ms, at, tokens_in, tokens_out, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
			root, run2.task, run2.session, run2.status, run2.durationMs, run2.at, run2.tokensIn ?? 0, run2.tokensOut ?? 0, run2.cacheRead ?? 0, run2.cacheWrite ?? 0,
		]);
	} catch { /* store unavailable */ }
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

export function appendEvent(d: Store | undefined, session: string, event: unknown, root = ""): void {
	try {
		run(d, "INSERT INTO session_events(root, session, event) VALUES (?, ?, ?)", [root, session, JSON.stringify(event)]);
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
