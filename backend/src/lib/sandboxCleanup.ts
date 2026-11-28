import type { Db } from "mongodb";
import { getProvider, type ProviderCreds } from "../../../src/sandbox/provider";
import { recordSandboxEvent } from "./sandboxEvents";
import { swallow } from "./log";

export const TERMINAL_SANDBOX_STATES = new Set(["dead", "killed", "terminated"]);
export const INACCESSIBLE_SANDBOX_STATES = new Set(["inaccessible", "unknown", "replaced"]);
export const REAP_SCAN_STATES = ["active", "running", "paused", "inaccessible", "unknown", "replaced"];
export const ORPHAN_GRACE_MS = 60 * 60_000;

export interface SandboxRow {
	_id?: any;
	uid?: string;
	sandboxId?: string;
	sessionId?: string | null;
	provider?: string;
	state?: string;
	reason?: string;
	killPending?: boolean;
	at?: Date | string;
	createdAt?: Date | string;
	replacedBy?: string;
	[key: string]: unknown;
}

export const isTerminalSandboxState = (state: unknown): boolean => TERMINAL_SANDBOX_STATES.has(String(state ?? ""));
export const isInaccessibleSandboxState = (state: unknown): boolean => INACCESSIBLE_SANDBOX_STATES.has(String(state ?? ""));

/** Legacy rows used `replaced + killPending` for what is now the retained,
 *  non-reusable `inaccessible` state. Session deletion/quota rows are not
 *  legacy because their reason is absent or explicit. */
export const isLegacyReplacedInaccessible = (row: SandboxRow): boolean =>
	row.state === "replaced" && (row.reason === "unreachable" || row.reason === "snapshot-restore");

/** E2B concurrency exhaustion has a specific message. A 429 alone can be the
 *  much cheaper sandbox-creation rate limit, and template/network failures
 *  must never trigger destructive cleanup. */
export function isSandboxConcurrencyQuotaError(err: unknown): boolean {
	const e = err as { name?: unknown; message?: unknown } | undefined;
	const text = `${String(e?.name ?? "")} ${String(e?.message ?? err ?? "")}`.toLowerCase();
	return /maximum number of concurrent (?:e2b )?sandboxes|concurrent e2b sandboxes|sandbox concurrency|too many concurrent sandboxes/.test(text);
}

const sessionRef = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const dateMs = (v: unknown): number => {
	if (v instanceof Date) return v.getTime();
	if (typeof v === "string") return Date.parse(v);
	return 0;
};
const rowActivityMs = (row: SandboxRow): number => dateMs(row.lastActivityAt) || dateMs(row.at) || dateMs(row.createdAt);

/** Finalize a row when the provider authoritatively says the sandbox no longer
 *  exists. No remote kill is needed or attempted. */
export async function markProviderGone(db: Db, row: SandboxRow): Promise<void> {
	const now = new Date();
	const transitioned = await db
		.collection("sandboxes")
		.updateOne(
			{ _id: row._id, state: { $nin: [...TERMINAL_SANDBOX_STATES] } },
			{ $set: { killPending: false, state: "dead", reason: "provider-gone", at: now, deadAt: now } },
		)
		.catch(swallow("sandboxCleanup", "op", null));
	if (!transitioned?.matchedCount) return;
	await recordSandboxEvent(db, {
		uid: String(row.uid ?? ""),
		sandboxId: String(row.sandboxId ?? ""),
		sessionId: sessionRef(row.sessionId),
		provider: typeof row.provider === "string" ? row.provider : "e2b",
		event: "provider-gone",
		state: "dead",
		reason: "provider-gone",
	});
}

/** Mark a VM unusable without destroying it. The session association is kept
 *  deliberately: it is historical provenance, not permission to reuse. */
export async function markInaccessible(
	db: Db,
	input: {
		uid: string;
		sandboxId: string;
		sessionId?: string | null;
		provider?: string;
		reason: string;
		replacedBy?: string;
	},
): Promise<void> {
	if (!input.sandboxId) return;
	const now = new Date();
	const key = { uid: input.uid, sandboxId: input.sandboxId };
	const existing = (await db.collection("sandboxes").findOne(key).catch(swallow("sandboxCleanup", "op", null))) as SandboxRow | null;
	if (existing && isTerminalSandboxState(existing.state)) return;
	const already = existing?.state === "inaccessible" && existing?.reason === input.reason;
	await db
		.collection("sandboxes")
		.updateOne(
			key,
			{
				$set: {
					uid: input.uid,
					sandboxId: input.sandboxId,
					...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
					...(input.provider ? { provider: input.provider } : {}),
					state: "inaccessible",
					reason: input.reason,
					killPending: false,
					inaccessibleAt: existing?.inaccessibleAt ?? now,
					at: now,
					...(input.replacedBy ? { replacedBy: input.replacedBy } : {}),
				},
				$setOnInsert: { createdAt: now },
			},
			{ upsert: true },
		)
		.catch(swallow("sandboxCleanup", "op"));
	if (!already) {
		await recordSandboxEvent(db, {
			uid: input.uid,
			sandboxId: input.sandboxId,
			sessionId: sessionRef(input.sessionId ?? existing?.sessionId),
			provider: input.provider ?? (typeof existing?.provider === "string" ? existing.provider : "e2b"),
			event: "inaccessible",
			state: "inaccessible",
			reason: input.reason,
		});
	}
}

/** Normalize legacy `replaced + killPending` rows before any reap decision. */
export async function normalizeLegacyInaccessible(db: Db, row: SandboxRow): Promise<boolean> {
	if (!isLegacyReplacedInaccessible(row)) return false;
	await db
		.collection("sandboxes")
		.updateOne(
			{ _id: row._id },
			{ $set: { state: "inaccessible", killPending: false, inaccessibleAt: row.inaccessibleAt ?? row.replacedAt ?? new Date() } },
		)
		.catch(swallow("sandboxCleanup", "op"));
	row.state = "inaccessible";
	row.killPending = false;
	return true;
}

/** Provider kill plus exactly one terminal DB transition/event on success. */
export async function reapSandbox(db: Db, row: SandboxRow, creds: ProviderCreds, reason: string): Promise<boolean> {
	const providerName = typeof row.provider === "string" ? row.provider : "e2b";
	const provider = getProvider(providerName);
	const ok = await provider.killById(String(row.sandboxId), creds).catch(swallow("sandboxCleanup", "op", false));
	if (!ok) return false;
	const now = new Date();
	const transitioned = await db
		.collection("sandboxes")
		.updateOne(
			{ _id: row._id, state: { $nin: [...TERMINAL_SANDBOX_STATES] } },
			{ $set: { killPending: false, state: "dead", reason, at: now, deadAt: now } },
		)
		.catch(swallow("sandboxCleanup", "op", null));
	if (transitioned?.matchedCount) {
		await recordSandboxEvent(db, {
			uid: String(row.uid ?? ""),
			sandboxId: String(row.sandboxId ?? ""),
			sessionId: sessionRef(row.sessionId),
			provider: providerName,
			event: "kill",
			state: "dead",
			reason,
		});
	}
	return true;
}

export async function hasLiveSandboxRun(db: Db, row: SandboxRow): Promise<boolean> {
	if (!row.sessionId) return false;
	return (
		(await db.collection("runs").countDocuments({ uid: row.uid, sessionId: row.sessionId, status: { $in: ["queued", "claimed", "running", "stopping"] } })) > 0 ||
		(await db.collection("sessions").countDocuments({ uid: row.uid, sessionId: row.sessionId, activeRunId: { $ne: null } })) > 0
	);
}

/** A row is attached only while it is the session's current sandbox. Rows in
 *  `session.sandboxIds` are history, not ownership. */
export async function owningSession(db: Db, row: SandboxRow): Promise<Record<string, any> | null> {
	if (!row.sandboxId) return null;
	return (await db.collection("sessions").findOne({ uid: row.uid, sandboxId: row.sandboxId }).catch(swallow("sandboxCleanup", "op", null))) as Record<string, any> | null;
}

export async function isOrphanedSandboxRow(db: Db, row: SandboxRow, nowMs = Date.now()): Promise<boolean> {
	const session = await owningSession(db, row);
	if (session?.sandboxId && session.sandboxId === row.sandboxId) return false;
	const at = dateMs(row.at) || dateMs(row.createdAt);
	if (at && at >= nowMs - ORPHAN_GRACE_MS) return false;
	// Forked slice VMs share the session id but are never the session's current
	// sandbox. They alone need live-run protection past the grace window; an
	// old main-VM row for the same session is history once another id becomes
	// current, even while the replacement run is active.
	if (typeof row.reason === "string" && row.reason.startsWith("slice-") && row.reason.endsWith("-fork") && (await hasLiveSandboxRun(db, row))) return false;
	return true;
}

/** Running VMs worth sacrificing for a genuine concurrency-quota failure.
 *  Order: running inaccessible VMs, running disconnected VMs, then the oldest
 *  idle attached running VMs as the explicit concurrency-pressure exception.
 *  Paused VMs are deliberately excluded because E2B paused sandboxes do not
 *  consume running concurrency; VMs with live work are never sacrificed. */
export interface QuotaCleanupCandidate extends SandboxRow {
	quotaClass: "inaccessible" | "disconnected" | "idle-attached";
	quotaAction: "kill" | "pause";
}

export async function runningQuotaCleanupCandidates(db: Db, uid: string, providerName: string, creds: ProviderCreds): Promise<QuotaCleanupCandidate[]> {
	const provider = getProvider(providerName);
	if (!provider.getInfoById) return [];
	const providerFilter = providerName === "e2b" ? { $or: [{ provider: providerName }, { provider: null }, { provider: { $exists: false } }] } : { provider: providerName };
	const stateFilter = { $or: [{ state: { $in: REAP_SCAN_STATES } }, { state: null }, { state: { $exists: false } }] };
	const rows = (await db
		.collection("sandboxes")
		.find({ uid, $and: [providerFilter, stateFilter] })
		.toArray()
		.catch(swallow("sandboxCleanup", "op", []))) as SandboxRow[];
	rows.sort((a, b) => rowActivityMs(a) - rowActivityMs(b));
	const inaccessible: SandboxRow[] = [];
	const disconnected: SandboxRow[] = [];
	const idleAttached: SandboxRow[] = [];
	for (const row of rows) {
		await normalizeLegacyInaccessible(db, row);
		const info = await provider.getInfoById(String(row.sandboxId), creds).catch(() => null);
		if (info?.state === "gone") {
			await markProviderGone(db, row);
			continue;
		}
		if (info?.state !== "running") continue;
		if (isInaccessibleSandboxState(row.state)) {
			inaccessible.push(row);
			continue;
		}
		if (await isOrphanedSandboxRow(db, row)) {
			disconnected.push(row);
			continue;
		}
		const session = await owningSession(db, row);
		if (session?.sandboxId === row.sandboxId && !(await hasLiveSandboxRun(db, row))) idleAttached.push(row);
	}
	const tag = (rows: SandboxRow[], quotaClass: QuotaCleanupCandidate["quotaClass"], quotaAction: QuotaCleanupCandidate["quotaAction"]): QuotaCleanupCandidate[] =>
		rows.map((row) => Object.assign(row, { quotaClass, quotaAction }));
	return [...tag(inaccessible, "inaccessible", "kill"), ...tag(disconnected, "disconnected", "kill"), ...tag(idleAttached, "idle-attached", "pause")];
}
