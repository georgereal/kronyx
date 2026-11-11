import * as vscode from "vscode";
import { apiKey, webAppUrl } from "./auth";
import { listUnsyncedApiCalls, listUnsyncedPrs, listUnsyncedRunEvents, listUnsyncedRuns, listUnsyncedSandboxEvents, markApiCallsSynced, markPrsSynced, markRunEventsSynced, markRunsSynced, markSandboxEventsSynced, type Store } from "./store";
import { log } from "./log";

const BATCH_SIZE = 200;
const FLUSH_INTERVAL_MS = 60_000;
const KICK_DEBOUNCE_MS = 2_000;
const MAX_BACKOFF_MS = 10 * 60_000;

/**
 * Local-first burst uploader: api_calls rows are written to SQLite immediately
 * (synced=0); this worker flushes them to the web app's ingest API in batches.
 * Offline/failure just leaves rows queued for the next burst — never blocks runs.
 */
export class UsageSync implements vscode.Disposable {
	private readonly timer: ReturnType<typeof setInterval>;
	private kickTimer: ReturnType<typeof setTimeout> | undefined;
	private flushing = false;
	private backoffMs = 0;
	private nextAttemptAt = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly getStore: () => Promise<Store | undefined>,
	) {
		this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
	}

	/** New rows landed — flush shortly after, coalescing bursts of usage events. */
	kick(): void {
		clearTimeout(this.kickTimer);
		this.kickTimer = setTimeout(() => void this.flush(), KICK_DEBOUNCE_MS);
	}

	/** Clear a 401-imposed pause — call after a fresh API key is stored. */
	resume(): void {
		this.nextAttemptAt = 0;
		this.kick();
	}

	enabled(): boolean {
		return vscode.workspace.getConfiguration("kronyx").get<boolean>("sync.enabled", false);
	}

	async flush(): Promise<void> {
		if (this.flushing || !this.enabled()) return;
		if (Date.now() < this.nextAttemptAt) return;
		const endpoint = webAppUrl();
		if (!endpoint) return;
		const key = await apiKey(this.context);
		if (!key) return;
		this.flushing = true;
		try {
			const d = await this.getStore();
			const rows = listUnsyncedApiCalls(d, BATCH_SIZE);
			const runs = listUnsyncedRuns(d, 100);
			const events = listUnsyncedRunEvents(d, 500);
			const prs = listUnsyncedPrs(d, 100);
			const sandboxes = listUnsyncedSandboxEvents(d, 200);
			if (rows.length + runs.length + events.length + prs.length + sandboxes.length === 0) return;
			const res = await fetch(`${endpoint}/api/ingest`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body: JSON.stringify({
					calls: rows.map(toWire),
					runs: runs.map((r) => ({ runId: r.run_id, task: r.task, session: r.session, status: r.status, durationMs: r.duration_ms, at: r.at, tokensIn: r.tokens_in, tokensOut: r.tokens_out, workspace: r.root || undefined })),
					events: events.map((r) => ({ runId: r.run_id, seq: r.id, session: r.session, event: safeJson(r.event), workspace: r.root || undefined })),
					prs: prs.map((r) => ({ runId: r.run_id, session: r.session, task: r.task, repo: r.repo, branch: r.branch, url: r.url, title: r.title, status: r.status, at: r.at, workspace: r.root || undefined })),
					sandboxes: sandboxes.map((r) => ({ sandboxId: r.sandbox_id, device: r.device, deviceId: r.device_id, template: r.template, repo: r.repo, runId: r.run_id, event: r.event, at: r.at, workspace: r.root || undefined })),
				}),
				signal: AbortSignal.timeout(15_000),
			});
			if (res.status === 401 || res.status === 403) {
				// Key revoked or invalid — stop retrying until the key changes.
				this.nextAttemptAt = Number.MAX_SAFE_INTEGER;
				log("sync", "API key rejected (401) — sync paused until you sign in again");
				void vscode.window
					.showWarningMessage("Kronyx: API key rejected — usage sync paused.", "Sign in")
					.then((pick) => pick === "Sign in" && vscode.commands.executeCommand("kronyx.signIn"));
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			markApiCallsSynced(d, rows.map((r) => Number(r.id)));
			markRunsSynced(d, runs.map((r) => Number(r.id)));
			markRunEventsSynced(d, events.map((r) => Number(r.id)));
			markPrsSynced(d, prs.map((r) => Number(r.id)));
			markSandboxEventsSynced(d, sandboxes.map((r) => Number(r.id)));
			this.backoffMs = 0;
			log("sync", `uploaded ${rows.length} call(s), ${runs.length} run(s), ${events.length} event(s), ${prs.length} pr(s)`);
		} catch (error) {
			this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(15_000, this.backoffMs * 2));
			this.nextAttemptAt = Date.now() + this.backoffMs;
			log("sync", `flush failed (${error instanceof Error ? error.message : error}) — retry in ${this.backoffMs / 1000}s`);
		} finally {
			this.flushing = false;
		}
	}

	dispose(): void {
		clearInterval(this.timer);
		clearTimeout(this.kickTimer);
	}
}

function safeJson(v: unknown): unknown {
	try {
		return JSON.parse(String(v));
	} catch {
		return v;
	}
}

/** sql.js row → ingest wire shape (camelCase, includes local id for dedupe). */
function toWire(r: Record<string, unknown>): Record<string, unknown> {
	return {
		clientRowId: r.id,
		at: r.at,
		status: r.status,
		provider: r.provider || undefined,
		baseUrl: r.base_url || undefined,
		model: r.model || undefined,
		profile: r.profile || undefined,
		keyLabel: r.key_label || undefined,
		device: r.device || undefined,
		deviceId: r.device_id || undefined,
		tokensIn: r.tokens_in,
		tokensOut: r.tokens_out,
		cacheRead: r.cache_read,
		cacheWrite: r.cache_write,
		reasoningTokens: r.reasoning_tokens ?? undefined,
		billedCostUsd: r.billed_cost_usd ?? undefined,
		iteration: r.iteration ?? undefined,
		contextMsgs: r.context_msgs ?? undefined,
		kind: r.kind || undefined,
		op: r.op || undefined,
		costUsd: r.cost_usd ?? undefined,
		durationMs: r.duration_ms,
		session: r.session || undefined,
		task: r.task || undefined,
		workspace: r.root || undefined,
	};
}
