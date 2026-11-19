import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

/**
 * Compaction before/after context dumps live as gzipped files on the backend
 * server — same convention as planStore (Mongo stays lean; run_events docs
 * carry only stats + a `dumpRef` pointer). Layout:
 *   <root>/<uid>/<runId>/<ts>-<rand>.json.gz   — { before: ContextDumpLine[], after: ContextDumpLine[] }
 */
const gz = promisify(gzip);
const ungz = promisify(gunzip);

const ROOT = process.env.DUMPS_DIR
	? path.resolve(process.env.DUMPS_DIR)
	: path.join(process.cwd(), "data", "dumps");

const clean = (s: string): string => s.replace(/[^\w.-]+/g, "-").replace(/^\.+/, "").slice(0, 80) || "x";

/** Allocates the dumpRef stored on the run_event (`<runId>/<file>`) so it can
 *  be emitted synchronously while the file write completes in the background. */
export const newDumpRef = (runId: string): string =>
	`${clean(runId)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json.gz`;

export async function saveDump(uid: string, dumpRef: string, dump: unknown): Promise<void> {
	const file = path.join(ROOT, clean(uid), clean(dumpRef.split("/")[0] ?? ""), clean(dumpRef.split("/")[1] ?? ""));
	if (!file.endsWith(".json.gz")) return;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, await gz(JSON.stringify(dump)));
}

export async function loadDump<T = unknown>(uid: string, dumpRef: string): Promise<T | null> {
	// dumpRef is `<runId>/<file>` written by saveDump — normalize segments so a
	// tampered ref can't walk out of the user's directory.
	const file = path.join(ROOT, clean(uid), clean(dumpRef.split("/")[0] ?? ""), clean(dumpRef.split("/")[1] ?? ""));
	if (!file.endsWith(".json.gz")) return null;
	const buf = await fs.readFile(file).catch(() => null);
	if (!buf) return null;
	return ungz(buf)
		.then((b) => JSON.parse(b.toString("utf8")) as T)
		.catch(() => null);
}

/** Remove a run's dumps (call alongside run/session deletion). */
export async function deleteRunDumps(uid: string, runId: string): Promise<void> {
	await fs.rm(path.join(ROOT, clean(uid), clean(runId)), { recursive: true, force: true }).catch(() => {});
}
