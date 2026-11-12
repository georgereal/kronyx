"use client";

import type { User } from "firebase/auth";
import { useEffect, useState } from "react";
import { marked } from "marked";
import { apiFetch } from "@/lib/api";
import type { RunDoc, RunEvent } from "@/lib/types";

const KIND: Record<string, string> = {
	"run-started": "Task",
	"assistant-text": "Kronyx",
	reasoning: "Thought process",
	"tool-started": "Tool",
	"tool-finished": "Result",
	"file-changed": "File",
	check: "Check",
	"cloud-status": "Cloud",
	info: "Info",
	setup: "Setup",
	"plan-ready": "Plan",
	"ui-screenshot": "Screenshot",
	"mode-blocked": "Mode",
	"loop-detected": "Stopped",
	"run-finished": "Done",
	"run-failed": "Failed",
};

const WRITE_TOOLS = new Set(["file_editor", "write_file", "edit_file", "append_file", "insert_lines"]);

type Item =
	| { kind: "stream"; streamKind: "reasoning" | "assistant"; text: string; done: boolean; key: string; runId?: string; at?: string }
	| {
			kind: "action";
			name: string;
			input: unknown;
			output?: string;
			ok?: boolean;
			durationMs?: number;
			toolId?: string;
			path?: string;
			diff?: string;
			added?: number;
			removed?: number;
			liveOutput?: string;
			key: string;
			runId?: string;
	  }
	| { kind: "perm"; permId: string; tool: string; path: string; command: string; input: unknown; decision?: string; key: string; runId?: string }
	| { kind: "event"; e: RunEvent; key: string };

/**
 * Fold token-delta events into one stream item each. A delta stream stays
 * "open" until its final event (reasoning / assistant-text) replaces it —
 * so replays show one Thinking card and one reply card, not 200 tokens.
 */
function fold(events: RunEvent[]): Item[] {
	const items: Item[] = [];
	let openReasoning: Extract<Item, { kind: "stream" }> | null = null;
	let openAssistant: Extract<Item, { kind: "stream" }> | null = null;
	// assistant-text is the final copy of the last delta stream — merge it in,
	// never render it as a separate card (that's the visible duplicate).
	let lastAssistant: (Extract<Item, { kind: "stream" }> & { absorbed?: boolean }) | null = null;
	for (const e of events) {
		const t = e.event.type;
		if (t === "reasoning-delta" || t === "assistant-delta") {
			const isR = t === "reasoning-delta";
			let s: Extract<Item, { kind: "stream" }> | null = isR ? openReasoning : openAssistant;
			if (!s || s.done || (!isR && lastAssistant?.absorbed)) {
				s = { kind: "stream", streamKind: isR ? "reasoning" : "assistant", text: "", done: false, key: `s${e.runId}-${e.seq}`, runId: e.runId, at: e.at };
				items.push(s);
				if (isR) openReasoning = s;
				else {
					openAssistant = s;
					lastAssistant = s;
				}
			}
			s.text += String(e.event.text ?? "");
			continue;
		}
		if (t === "reasoning") {
			if (openReasoning && !openReasoning.done) {
				openReasoning.text = String(e.event.text ?? openReasoning.text);
				openReasoning.done = true;
				openReasoning = null;
				continue;
			}
		}
		if (t === "assistant-text") {
			// Merge into this iteration's stream regardless of intervening events
			// (usage/reasoning close the delta but shouldn't spawn a second card).
			if (lastAssistant && !lastAssistant.absorbed) {
				lastAssistant.text = String(e.event.text ?? lastAssistant.text);
				lastAssistant.done = true;
				lastAssistant.absorbed = true;
				continue;
			}
		}
		// Close any dangling streams on non-stream events (tools, finish, etc.).
		if (openReasoning && t !== "reasoning-delta") {
			openReasoning.done = true;
			openReasoning = null;
		}
		if (openAssistant && t !== "assistant-delta") {
			openAssistant.done = true;
			openAssistant = null;
		}
		items.push({ kind: "event", e, key: `e${e.runId}-${e.seq}` });
	}
	return items;
}

/**
 * Pair raw events into action items: tool-started + tool-finished → one
 * action card; file-changed attaches to the matching edit action by path;
 * permission-request + permission-resolved → one approval card.
 */
function pair(items: Item[]): Item[] {
	const out: Item[] = [];
	const actions = new Map<string, Extract<Item, { kind: "action" }>>();
	const perms = new Map<string, Extract<Item, { kind: "perm" }>>();
	for (const item of items) {
		if (item.kind !== "event") {
			out.push(item);
			continue;
		}
		const ev = item.e.event;
		if (ev.type === "tool-started") {
			const inp = (ev.input ?? {}) as Record<string, unknown>;
			const a: Extract<Item, { kind: "action" }> = {
				kind: "action",
				name: String(ev.name),
				input: ev.input,
				toolId: String(ev.id ?? ""),
				path: inp.path ? String(inp.path) : inp.file ? String(inp.file) : undefined,
				key: item.key,
				runId: item.e.runId,
			};
			if (a.toolId) actions.set(a.toolId, a);
			out.push(a);
			continue;
		}
		if (ev.type === "tool-finished") {
			const a = actions.get(String(ev.id ?? ""));
			if (a) {
				a.output = String(ev.output ?? "");
				a.ok = ev.ok !== false;
				a.durationMs = Number(ev.durationMs ?? 0);
				continue;
			}
		}
		if (ev.type === "file-changed") {
			const path = String(ev.path ?? "");
			// Attach to the most recent edit action for the same path.
			const a = [...actions.values()].reverse().find((x) => x.path === path && !x.diff);
			if (a) {
				a.diff = String(ev.diff ?? "");
				a.added = Number(ev.added ?? 0);
				a.removed = Number(ev.removed ?? 0);
				continue;
			}
			// Zero-diff churn (binary/.pyc artifacts) — no signal, drop the card.
			if (Number(ev.added ?? 0) + Number(ev.removed ?? 0) === 0) continue;
		}
		if (ev.type === "tool-output-delta") {
			// Attach live output to the open run_command card (only one streams
			// at a time); orphan deltas are dropped.
			const a = [...actions.values()].reverse().find((x) => x.name === "run_command" && x.output === undefined);
			if (a) a.liveOutput = (a.liveOutput ?? "") + String(ev.text ?? "");
			continue;
		}
		if (ev.type === "permission-request") {
			const p: Extract<Item, { kind: "perm" }> = {
				kind: "perm",
				permId: String(ev.id ?? ev.permId ?? ""),
				tool: String(ev.tool ?? ""),
				path: String(ev.path ?? ""),
				command: String(ev.command ?? ""),
				input: ev.input,
				key: item.key,
				runId: item.e.runId,
			};
			perms.set(p.permId, p);
			out.push(p);
			continue;
		}
		if (ev.type === "permission-resolved" || ev.type === "permission-response") {
			const p = perms.get(String(ev.id ?? ev.permId ?? ""));
			if (p) {
				p.decision = String(ev.decision ?? "");
				continue;
			}
		}
		out.push(item);
	}
	return out;
}

function Md({ text }: { text: string }) {
	return <div className="md" dangerouslySetInnerHTML={{ __html: marked.parse(text) as string }} />;
}

function toolInput(input: unknown): string {
	if (input == null) return "";
	const s = typeof input === "string" ? input : JSON.stringify(input);
	return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

function fmtDur(ms: number): string {
	const s = Math.max(1, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTime(at?: string): string {
	return at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

/** Live elapsed ticker for running action cards ("Working for 38s"). */
function Elapsed() {
	const [s, setS] = useState(0);
	useEffect(() => {
		const t = setInterval(() => setS((v) => v + 1), 1000);
		return () => clearInterval(t);
	}, []);
	return <span className="muted act-stat">Working for {fmtDur(s * 1000)}</span>;
}

interface DiffLine { num?: number; cls: string; text: string }

/** Numbered unified-diff lines: new-file numbers for +/ctx, old for −. */
function diffLines(diff: string, cap = 300): { rows: DiffLine[]; truncated: boolean } {
	const rows: DiffLine[] = [];
	let oldN = 0, newN = 0, truncated = false;
	for (const l of diff.split("\n")) {
		const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
		const hOld = /^@@ -(\d+)/.exec(l);
		if (h) {
			newN = Number(h[1]);
			oldN = hOld ? Number(hOld[1]) : newN;
			rows.push({ cls: "fd-l-hunk", text: l });
			continue;
		}
		if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) continue;
		if (rows.length >= cap) { truncated = true; break; }
		if (l.startsWith("+")) rows.push({ num: newN++, cls: "fd-l-add", text: l });
		else if (l.startsWith("-")) rows.push({ num: oldN++, cls: "fd-l-del", text: l });
		else rows.push({ num: newN++, cls: "fd-l-ctx", text: l });
	}
	return { rows, truncated };
}

function DiffBody({ diff }: { diff: string }) {
	const { rows, truncated } = diffLines(diff);
	return (
		<div className="fd-body">
			{rows.map((r, i) => (
				<div key={i} className={`fd-row ${r.cls}`}>
					<span className="fd-num">{r.num ?? ""}</span>
					<span className="fd-code">{r.text}</span>
				</div>
			))}
			{truncated && <div className="muted act-stat">…truncated…</div>}
		</div>
	);
}

/** Shared single-line collapsed row + expandable body for action cards. */
function ActionCard({
	icon,
	title,
	stats,
	status,
	children,
	done,
	failed,
	keepOpen,
}: {
	icon: React.ReactNode;
	title: React.ReactNode;
	stats?: React.ReactNode;
	status?: React.ReactNode;
	children?: React.ReactNode;
	done: boolean;
	failed?: boolean;
	keepOpen?: boolean;
}) {
	const live = !done;
	const [open, setOpen] = useState(live || !!failed);
	useEffect(() => setOpen(live || !!failed || !!keepOpen), [live, failed, keepOpen]);
	return (
		<div className={`act ${failed ? "failed" : ""}`}>
			<button className="act-head" onClick={() => setOpen((v) => !v)}>
				<span className="caret">{open ? "▾" : "▸"}</span>
				<span className="act-icon">{icon}</span>
				<span className="act-title">{title}</span>
				{stats}
				{status}
			</button>
			{open && children && <div className="act-body">{children}</div>}
		</div>
	);
}

/** Unwrap JSON error envelopes ({"error": "…"}) so failures read as text. */
function prettyOut(raw: string): string {
	const t = raw.trim();
	if (t.startsWith("{")) {
		try {
			const j = JSON.parse(t) as { error?: unknown; message?: unknown };
			const msg = j.error ?? j.message;
			if (typeof msg === "string") return msg;
		} catch { /* not JSON */ }
	}
	return raw;
}

/** Terminal execution card — command header, streamed/final output, status. */
function Terminal({ item }: { item: Extract<Item, { kind: "action" }> }) {
	const inp = item.input as Record<string, unknown> | undefined;
	const cmd = item.name === "run_command" ? String(inp?.command ?? "") : `${item.name} ${toolInput(item.input)}`;
	const done = item.output !== undefined;
	const failed = done && item.ok === false;
	return (
		<ActionCard
			icon="▶"
			title={<span className="mono">{item.name === "run_command" ? "Running" : item.name} <span className="muted">{cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd}</span></span>}
			stats={
				done
					? item.durationMs !== undefined && <span className="muted act-stat">{fmtDur(item.durationMs)}</span>
					: <Elapsed />
			}
			status={
				done ? (
					failed ? <span className="act-pill err">Failed</span> : <span className="act-pill ok">Completed</span>
				) : (
					<span className="act-pill run">Running</span>
				)
			}
			done={done}
			failed={failed}
		>
			<pre className="act-out">{prettyOut(item.output ?? item.liveOutput ?? "").slice(0, 4000) || "…"}</pre>
		</ActionCard>
	);
}

/** Code edit card — ⚙ filename + stat chip header, numbered colored diff. */
function EditCard({ item }: { item: Extract<Item, { kind: "action" }> }) {
	const diff = item.diff ?? "";
	const done = item.output !== undefined;
	const file = item.path ? item.path.split("/").pop() : "file";
	const stats =
		item.added != null || item.removed != null ? (
			<span className="act-stat fd-chip">
				{item.added != null && <span className="fd-add">+{item.added}</span>}
				{item.removed != null && <span className="fd-del"> −{item.removed}</span>}
			</span>
		) : null;
	return (
		<ActionCard
			icon="⚙"
			title={<span className="mono">{file}</span>}
			stats={stats}
			status={done ? null : <span className="act-pill run">Editing</span>}
			done={done}
		>
			{diff ? <DiffBody diff={diff} /> : <pre className="act-out">{toolInput(item.input)}</pre>}
		</ActionCard>
	);
}

/** Inline approval card — exact action + Allow/Deny; posts decision to the run. */
function PermissionCard({ user, item, active }: { user: User; item: Extract<Item, { kind: "perm" }>; active: boolean }) {
	const [decision, setDecision] = useState(item.decision ?? "");
	const [busy, setBusy] = useState(false);
	useEffect(() => setDecision(item.decision ?? ""), [item.decision]);
	const decided = !!decision || !active;
	const detail = item.command || item.path || toolInput(item.input);
	const decide = async (d: "allow" | "deny") => {
		if (!item.runId || busy) return;
		setBusy(true);
		const res = await apiFetch(`/api/runs/${item.runId}/permissions/${item.permId}`, user, {
			method: "POST",
			body: JSON.stringify({ decision: d }),
		});
		setBusy(false);
		setDecision(res.ok ? d : "error");
	};
	return (
		<div className="perm-card">
			<div className="perm-head">
				<span className="perm-shield">🛡</span>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div className="perm-title">Permission required</div>
					<div className="muted" style={{ fontSize: 12 }}>
						Allow Kronyx to run <span className="mono">{item.tool}</span>?
					</div>
					{detail && <div className="perm-cmd mono">{detail.length > 160 ? `${detail.slice(0, 160)}…` : detail}</div>}
				</div>
				{decided ? (
					<span className={`act-pill ${decision === "allow" ? "ok" : "err"}`} style={{ alignSelf: "center" }}>
						{decision === "allow" ? "Allowed" : decision ? `Denied${decision === "deny" ? "" : ` (${decision})`}` : "Expired"}
					</span>
				) : (
					<div className="perm-actions">
						<button className="btn sm ghost" disabled={busy} onClick={() => void decide("deny")}>Deny</button>
						<button className="btn sm" disabled={busy} onClick={() => void decide("allow")}>Allow</button>
					</div>
				)}
			</div>
		</div>
	);
}

function PlanCard({ user, sessionId, slug }: { user: User; sessionId: string; slug: string }) {
	const [plan, setPlan] = useState<{ markdown: string; slug: string } | null>(null);
	const [msg, setMsg] = useState("");

	useEffect(() => {
		void (async () => {
			const res = await apiFetch(`/api/plans/_?session=${sessionId}&slug=${encodeURIComponent(slug)}`, user);
			if (res.ok) setPlan((await res.json()).plan);
		})();
	}, [user, sessionId, slug]);

	const implement = async () => {
		setMsg("Queued…");
		const res = await apiFetch(`/api/sessions/${sessionId}/messages`, user, {
			method: "POST",
			body: JSON.stringify({ task: `Implement the plan "${slug}"`, mode: "agent", planSlug: slug }),
		});
		setMsg(res.ok ? "Implementation queued" : "Failed to queue");
		if (res.ok) window.dispatchEvent(new CustomEvent("kronyx:refresh-session"));
	};
	const push = async () => {
		setMsg("Pushing…");
		const res = await apiFetch(`/api/sessions/${sessionId}/plans/${encodeURIComponent(slug)}/push`, user, { method: "POST" });
		setMsg(res.ok ? "Plan push queued" : "Push failed");
		if (res.ok) window.dispatchEvent(new CustomEvent("kronyx:refresh-session"));
	};

	return (
		<div className="plan-card">
			<div className="ev-kind">Plan · {slug}</div>
			{plan ? <Md text={plan.markdown} /> : <div className="muted">Loading plan…</div>}
			<div className="actions">
				<button className="btn sm" onClick={implement}>Implement</button>
				<button className="btn sm ghost" onClick={push}>Push plan to branch</button>
				{msg && <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>{msg}</span>}
			</div>
		</div>
	);
}

/** Small check row — `✓ pytest` collapsed, expandable to output. */
function CheckRow({ e }: { e: RunEvent }) {
	const ev = e.event;
	const ok = ev.ok !== false;
	return (
		<ActionCard
			icon={<span style={{ color: ok ? "var(--ok)" : "var(--err)" }}>{ok ? "✓" : "✗"}</span>}
			title={<span className="mono muted">{String(ev.command ?? "check")}</span>}
			status={<span className={`act-pill ${ok ? "ok" : "err"}`}>{ok ? "Passed" : "Failed"}</span>}
			done
			failed={!ok}
		>
			{ev.output ? <pre className="act-out">{String(ev.output)}</pre> : null}
		</ActionCard>
	);
}

function Event({ user, sessionId, e, events, runs, githubUrl }: { user: User; sessionId: string; e: RunEvent; events: RunEvent[]; runs: RunDoc[]; githubUrl?: string }) {
	const ev = e.event;
	const kind = KIND[ev.type] ?? ev.type;
	const cls =
		ev.type === "run-failed" ? "failed"
		: ev.type === "cloud-status" || ev.type === "info" || ev.type === "setup" ? "status"
		: "";

	if (ev.type === "run-started") {
		// User message bubble: task text up front, inlined attachment context
		// summarized as a chip instead of dumped into the bubble.
		const raw = String(ev.task ?? "");
		const split = raw.split(/\n\nAttached context:\n/);
		const task = split[0];
		const attCount = split.length > 1 ? (split[1].match(/--- attached file:/g) ?? []).length : 0;
		return (
			<div className="msg-row">
				<span className="avatar">{(user.email ?? "U")[0].toUpperCase()}</span>
				<div className="user-bubble" style={{ flex: 1 }}>
					<span className="stream-text">{task}</span>
					{attCount > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>+{attCount} attached file{attCount > 1 ? "s" : ""}</div>}
				</div>
				<span className="msg-time">{fmtTime(e.at)}</span>
			</div>
		);
	}
	if (ev.type === "run-failed") {
		const err = String(ev.error ?? ev.text ?? "");
		const iterLimit = /maxIterations|exceeded.*iterations/i.test(err);
		return (
			<div className="ev failed">
				<div className="ev-kind">Failed</div>
				<span>{err || "Run failed"}</span>
				{iterLimit && (
					<button
						className="btn sm"
						style={{ marginTop: 8 }}
						onClick={async () => {
							const res = await apiFetch(`/api/sessions/${sessionId}/messages`, user, {
								method: "POST",
								body: JSON.stringify({ task: "Continue where you left off and finish the task.", mode: "agent" }),
							});
							if (res.ok) window.dispatchEvent(new CustomEvent("kronyx:refresh-session"));
						}}
					>
						Continue run
					</button>
				)}
			</div>
		);
	}
	if (ev.type === "ui-screenshot") {
		const dataUrl = String(ev.dataUrl ?? "");
		if (!dataUrl) return null;
		return (
			<div className="ev">
				<div className="ev-kind">Screenshot · {String(ev.url ?? "")}</div>
				<img src={dataUrl} alt="App screenshot" style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--border)" }} />
			</div>
		);
	}
	if (ev.type === "plan-ready") {
		const path = String(ev.path ?? "");
		const slug = path.split("/").pop()?.replace(/\.md$/, "") ?? "plan";
		return <PlanCard user={user} sessionId={sessionId} slug={slug} />;
	}
	if (ev.type === "check") return <CheckRow e={e} />;
	if (ev.type === "tool-finished") {
		const out = String(ev.output ?? "");
		if (!out.trim()) return null;
		return (
			<div className="ev">
				<details>
					<summary>Result {ev.ok === false && <span style={{ color: "var(--err)" }}>(error)</span>}</summary>
					<pre className="tool-out">{out.slice(0, 4000)}</pre>
				</details>
			</div>
		);
	}
	if (ev.type === "file-changed") {
		// Standalone file change (e.g. shell writes) — compact diff card.
		const diff = String(ev.diff ?? "");
		return (
			<ActionCard
				icon="⚙"
				title={<span className="mono">{String(ev.path).split("/").pop()}</span>}
				stats={
					ev.added != null && (
						<span className="act-stat"><span className="fd-add">+{String(ev.added)}</span> <span className="fd-del">−{String(ev.removed ?? 0)}</span></span>
					)
				}
				done
			>
				{diff ? <DiffBody diff={diff} /> : null}
			</ActionCard>
		);
	}
	const text =
		(ev.text as string) || (ev.error as string) || (ev.detail as string) || (ev.command as string) ||
		(ev.status as string) || "";
	// run-finished → "Task completed" summary card: stats + GitHub link.
	if (ev.type === "run-finished") {
		// Skip zero-diff churn (binary/.pyc artifacts) — not meaningful changes.
		const files = events.filter(
			(x) => x.runId === e.runId && x.event.type === "file-changed" && Number(x.event.added ?? 0) + Number(x.event.removed ?? 0) > 0,
		);
		const checks = events.filter((x) => x.runId === e.runId && x.event.type === "check" && x.event.ok === true);
		// Bubble up problems: failed tool calls + failed checks shouldn't hide
		// behind a "Task completed" banner.
		const issues =
			events.filter((x) => x.runId === e.runId && x.event.type === "tool-finished" && x.event.ok === false).length +
			events.filter((x) => x.runId === e.runId && x.event.type === "check" && x.event.ok === false).length;
		const added = files.reduce((a, x) => a + Number(x.event.added ?? 0), 0);
		const removed = files.reduce((a, x) => a + Number(x.event.removed ?? 0), 0);
		const run = runs.find((r) => r.runId === e.runId);
		const dur = run?.durationMs ? fmtDur(run.durationMs) : "";
		const ts = fmtTime(e.at);
		const summary = String(ev.text ?? ev.summary ?? "");
		return (
			<div className={`result-card${issues ? " has-issues" : ""}`}>
				<div className="result-title">
					<span className="check-circle">✓</span>
					<span>Task completed</span>
					{issues > 0 ? (
						<span className="status-pill warn" style={{ marginLeft: "auto" }}>{issues} issue{issues > 1 ? "s" : ""}</span>
					) : (
						<span className="status-pill completed" style={{ marginLeft: "auto" }}>Completed</span>
					)}
				</div>
				{issues > 0 && (
					<div className="result-issues muted">
						{issues} command{issues > 1 ? "s" : ""} or check{issues > 1 ? "s" : ""} failed during this run — expand the cards above to inspect.
					</div>
				)}
				{summary && <div className="result-summary"><Md text={summary} /></div>}
				<div className="result-stats">
					{files.length > 0 && <div className="result-stat"><b>{files.length}</b><span className="muted">Files changed</span></div>}
					<div className="result-stat"><b className="fd-add">+{added}</b><span className="muted">Lines added</span></div>
					<div className="result-stat"><b className="fd-del">−{removed}</b><span className="muted">Lines removed</span></div>
					{checks.length > 0 && <div className="result-stat"><b>{checks.length}</b><span className="muted">Checks passed</span></div>}
					{issues > 0 && <div className="result-stat"><b className="fd-del">{issues}</b><span className="muted">Failed</span></div>}
				</div>
				<div className="result-foot">
					<span className="muted">☁ Executed in cloud{dur ? ` · ${dur}` : ""}{ts ? ` · ${ts}` : ""}</span>
					{githubUrl && (
						<a href={githubUrl} target="_blank" rel="noreferrer" className="btn sm" style={{ marginLeft: "auto" }}>
							View on GitHub ↗
						</a>
					)}
				</div>
			</div>
		);
	}
	if (!text && !ev.type.startsWith("run-")) return null;
	// Context compaction — distinct marker, not a generic info line.
	if (ev.type === "info" && (ev.meta as { kind?: string } | undefined)?.kind === "context_compaction") {
		return (
			<div className="ev-line muted">
				<span className="dot" style={{ background: "var(--amber, #facc15)" }} />
				<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>◈ {text}</span>
			</div>
		);
	}
	// Lifecycle / status events — quiet single-line muted rows.
	return (
		<div className={`ev-line muted ${cls}`}>
			<span className="dot" style={{ background: ev.type === "run-failed" ? "var(--err)" : "var(--accent)" }} />
			<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{text || kind}</span>
		</div>
	);
}

export function Timeline({ user, sessionId, events, runs, githubUrl, active }: { user: User; sessionId: string; events: RunEvent[]; runs: RunDoc[]; githubUrl?: string; active?: boolean }) {
	const items = pair(fold(events));
	const renderItem = (item: Item) => {
		if (item.kind === "stream") {
			if (item.streamKind === "reasoning") {
				// Thought stream: grey surface while live, collapses once done.
				return item.done ? (
					<details key={item.key} className="ev thinking">
						<summary>Thinking</summary>
						<Md text={item.text} />
					</details>
				) : (
					<div key={item.key} className="ev thinking streaming">
						<div className="ev-kind">Thinking…</div>
						<span className="stream-text">{item.text}</span>
						<span className="stream-cursor" />
					</div>
				);
			}
			// Conversational agent update — K avatar + plain bubble, no card.
			return (
				<div key={item.key} className="msg-row">
					<span className="avatar accent">K</span>
					<div className="k-bubble" style={{ flex: 1 }}>
						{item.done ? <Md text={item.text} /> : (
							<>
								<span className="stream-text">{item.text}</span>
								<span className="stream-cursor" />
							</>
						)}
					</div>
					<span className="msg-time">{fmtTime(item.at)}</span>
				</div>
			);
		}
		if (item.kind === "action") {
			const isWrite = WRITE_TOOLS.has(item.name) || !!item.path;
			if (isWrite) return <EditCard key={item.key} item={item} />;
			return <Terminal key={item.key} item={item} />;
		}
		if (item.kind === "perm") return <PermissionCard key={item.key} user={user} item={item} active={!!active} />;
		return <Event key={item.key} user={user} sessionId={sessionId} e={item.e} events={events} runs={runs} githubUrl={githubUrl} />;
	};

	// Dedupe display-level repeats: retry runs often replay identical replies —
	// collapse identical non-event items anywhere in the feed.
	const seen: Item[] = [];
	const seenSigs = new Set<string>();
	for (const b of items) {
		const sig =
			b.kind === "stream"
				? `s:${b.streamKind}:${b.text.slice(0, 120)}`
				: b.kind === "event"
					? `e:${b.e.runId}:${b.e.seq}`
					: `${b.kind}:${b.key}`;
		if (b.kind !== "event" && seenSigs.has(sig)) continue;
		seenSigs.add(sig);
		seen.push(b);
	}
	return (
		<div className="timeline">
			{items.length === 0 && <div className="muted" style={{ padding: 20 }}>Waiting for events…</div>}
			{seen.map(renderItem)}
		</div>
	);
}
