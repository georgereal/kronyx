"use client";

import type { User } from "firebase/auth";
import { Fragment, useEffect, useState } from "react";
import { marked } from "marked";
import { apiFetch } from "@/lib/api";
import { fmtTok } from "@/components/AreaChart";
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
	"run-stopping": "Stopping",
	"run-finished": "Summary",
	"run-completed": "Completed",
	"run-failed": "Failed",
};

const WRITE_TOOLS = new Set(["file_editor", "write_file", "edit_file", "append_file", "insert_lines"]);

type Item =
	| { kind: "stream"; streamKind: "reasoning" | "assistant"; text: string; done: boolean; key: string; runId?: string; at?: string; seq?: number; agentIndex?: number }
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
			seq?: number;
			agentIndex?: number;
	  }
	| { kind: "perm"; permId: string; tool: string; path: string; command: string; input: unknown; decision?: string; key: string; runId?: string; seq?: number; agentIndex?: number }
	| { kind: "event"; e: RunEvent; key: string };

/**
 * Fold token-delta events into one stream item each. A delta stream stays
 * "open" until its final event (reasoning / assistant-text) replaces it —
 * so replays show one Thinking card and one reply card, not 200 tokens.
 */
function fold(events: RunEvent[]): Item[] {
	const items: Item[] = [];
	type StreamItem = Extract<Item, { kind: "stream" }>;
	// Multi-agent runs interleave deltas from parallel agents — keep each
	// agent's open streams separate so they fold into per-agent cards.
	interface Lane {
		openReasoning: StreamItem | null;
		openAssistant: StreamItem | null;
		// assistant-text is the final copy of the last delta stream — merge it
		// in, never render it as a separate card (that's the visible duplicate).
		lastAssistant: (StreamItem & { absorbed?: boolean }) | null;
	}
	const lanes = new Map<number, Lane>();
	const lane = (ai: number): Lane => {
		let l = lanes.get(ai);
		if (!l) lanes.set(ai, (l = { openReasoning: null, openAssistant: null, lastAssistant: null }));
		return l;
	};
	for (const e of events) {
		const ai = e.event.agentIndex ?? 0;
		const l = lane(ai);
		const t = e.event.type;
		if (t === "reasoning-delta" || t === "assistant-delta") {
			const isR = t === "reasoning-delta";
			let s: StreamItem | null = isR ? l.openReasoning : l.openAssistant;
			if (!s || s.done || (!isR && l.lastAssistant?.absorbed)) {
				s = { kind: "stream", streamKind: isR ? "reasoning" : "assistant", text: "", done: false, key: `s${e.runId}-${e.seq}`, runId: e.runId, at: e.at, seq: e.seq, agentIndex: ai };
				items.push(s);
				if (isR) l.openReasoning = s;
				else {
					l.openAssistant = s;
					l.lastAssistant = s;
				}
			}
			s.text += String(e.event.text ?? "");
			continue;
		}
		if (t === "reasoning") {
			if (l.openReasoning && !l.openReasoning.done) {
				l.openReasoning.text = String(e.event.text ?? l.openReasoning.text);
				l.openReasoning.done = true;
				l.openReasoning = null;
				continue;
			}
		}
		if (t === "assistant-text") {
			// Merge into this iteration's stream regardless of intervening events
			// (usage/reasoning close the delta but shouldn't spawn a second card).
			if (l.lastAssistant && !l.lastAssistant.absorbed) {
				l.lastAssistant.text = String(e.event.text ?? l.lastAssistant.text);
				l.lastAssistant.done = true;
				l.lastAssistant.absorbed = true;
				continue;
			}
		}
		// Close any dangling streams on non-stream events (tools, finish, etc.).
		if (l.openReasoning && t !== "reasoning-delta") {
			l.openReasoning.done = true;
			l.openReasoning = null;
		}
		if (l.openAssistant && t !== "assistant-delta") {
			l.openAssistant.done = true;
			l.openAssistant = null;
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
		const ai = ev.agentIndex ?? 0;
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
				seq: item.e.seq,
				agentIndex: ai,
			};
			// Tool ids are per-runner — parallel agents reuse them, so key by lane.
			if (a.toolId) actions.set(`${ai}:${a.toolId}`, a);
			out.push(a);
			continue;
		}
		if (ev.type === "tool-finished") {
			const a = actions.get(`${ai}:${String(ev.id ?? "")}`);
			if (a) {
				a.output = String(ev.output ?? "");
				a.ok = ev.ok !== false;
				a.durationMs = Number(ev.durationMs ?? 0);
				continue;
			}
		}
		if (ev.type === "file-changed") {
			const path = String(ev.path ?? "");
			// Attach to the most recent edit action for the same path, same agent.
			const a = [...actions.values()].reverse().find((x) => x.agentIndex === ai && x.path === path && !x.diff);
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
			const a = [...actions.values()].reverse().find((x) => x.agentIndex === ai && x.name === "run_command" && x.output === undefined);
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
				seq: item.e.seq,
				agentIndex: ai,
			};
			perms.set(`${ai}:${p.permId}`, p);
			out.push(p);
			continue;
		}
		if (ev.type === "permission-resolved" || ev.type === "permission-response") {
			const p = perms.get(`${ai}:${String(ev.id ?? ev.permId ?? "")}`);
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

export function PlanCard({ user, sessionId, slug }: { user: User; sessionId: string; slug: string }) {
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
		// Sub-agent runs (agentIndex>0) get an agent task card, not a user
		// bubble — this is the agent's assigned slice, not something the user typed.
		const raw = String(ev.task ?? "");
		const split = raw.split(/\n\nAttached context:\n/);
		const task = split[0];
		const attCount = split.length > 1 ? (split[1].match(/--- attached file:/g) ?? []).length : 0;
		if ((ev.agentIndex ?? 0) > 0) {
			return (
				<div className="msg-row">
					<span className="avatar accent">A{(ev.agentIndex ?? 0)}</span>
					<div className="agent-task-card" style={{ flex: 1 }}>
						<div className="ev-kind">Agent {(ev.agentIndex ?? 0)} task</div>
						<span className="stream-text">{task}</span>
						{attCount > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>+{attCount} attached file{attCount > 1 ? "s" : ""}</div>}
					</div>
					<span className="msg-time">{fmtTime(e.at)}</span>
				</div>
			);
		}
		return (
			<div className="msg-row">
				<span className="avatar">{(user.email ?? "U")[0].toUpperCase()}</span>
				<div className="user-bubble" id={`msg-${e.runId}`} style={{ flex: 1 }}>
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
	// run-completed → the completion card (agent summary + outcome rollup).
	// run-finished is only the agent's report — once run-completed lands it's
	// folded into that card. Legacy runs lack the event: the run-finished card
	// is still the run's completion view for them.
	const hasRunCompleted = events.some((x) => x.runId === e.runId && x.event.type === "run-completed");
	if (ev.type === "run-finished" && hasRunCompleted) return null;
	if (ev.type === "run-completed" || ev.type === "run-finished") {
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
		const summary = String(ev.summary ?? ev.text ?? "");
		// Our rollup of the non-agent outcomes (the "other items") — the agent
		// summary above is its own report; this is what the job itself did.
		const rollup: string[] = [];
		if (ev.type === "run-completed") {
			if (ev.pushed) rollup.push("Changes pushed");
			if (ev.prUrl) rollup.push("PR opened");
			const cl = Array.isArray(ev.checks) ? (ev.checks as { ok: boolean }[]) : [];
			const ok = cl.filter((c) => c.ok).length;
			if (cl.length) rollup.push(`${ok}/${cl.length} checks passed`);
			const comp = ev.compaction as { estTokensBefore?: number; estTokensAfter?: number } | undefined;
			if (comp?.estTokensBefore && comp.estTokensAfter && comp.estTokensAfter < comp.estTokensBefore)
				rollup.push(`context trimmed ~${Math.round(comp.estTokensBefore / 1000)}k→~${Math.round(comp.estTokensAfter / 1000)}k`);
		}
		return (
			<div className={`result-card${issues ? " has-issues" : ""}`}>
				<div className="result-title">
					<span className="check-circle">✓</span>
					<span>{ev.type === "run-completed" || run?.status === "completed" ? "Task completed" : "Agent summary"}</span>
					{issues > 0 ? (
						<span className="status-pill warn" style={{ marginLeft: "auto" }}>{issues} issue{issues > 1 ? "s" : ""}</span>
					) : (
						<span className="status-pill completed" style={{ marginLeft: "auto" }}>{run?.status === "completed" ? "Completed" : "Summary"}</span>
					)}
				</div>
				{issues > 0 && (
					<div className="result-issues muted">
						{issues} command{issues > 1 ? "s" : ""} or check{issues > 1 ? "s" : ""} failed during this run — expand the cards above to inspect.
					</div>
				)}
				{summary && <div className="result-summary"><Md text={summary} /></div>}
				{rollup.length > 0 && <div className="result-summary muted" style={{ fontSize: 12 }}>{rollup.join(" · ")}</div>}
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

export function Timeline({
	user,
	sessionId,
	events,
	runs,
	githubUrl,
	active,
	lateAfter,
}: {
	user: User;
	sessionId: string;
	events: RunEvent[];
	runs: RunDoc[];
	githubUrl?: string;
	active?: boolean;
	/** Events in lateAfter.runId with seq > lateAfter.seq render demoted behind a "stopping" divider. */
	lateAfter?: { runId: string; seq: number; halted: boolean };
}) {
	const items = pair(fold(events));
	const seqOf = (item: Item): number => (item.kind === "event" ? item.e.seq : (item.seq ?? 0));
	const runIdOf = (item: Item): string | undefined => (item.kind === "event" ? item.e.runId : item.runId);
	const isLate = (item: Item): boolean =>
		!!lateAfter && runIdOf(item) === lateAfter.runId && seqOf(item) > lateAfter.seq;

	// Per-agent drill-down: click a fan-out/fan-in row → focused view shows only
	// that agent's stream + its usage/context/memory stats; back restores all.
	const [focus, setFocus] = useState<{ runId: string; ai: number } | null>(null);
	const [usageRuns, setUsageRuns] = useState<{ runId: string; contextWindow: number | null; points: { agentIndex: number; requestTokens: number; tokensOut: number; costUsd: number | null }[] }[] | null>(null);
	useEffect(() => {
		if (!focus || usageRuns !== null) return;
		void apiFetch(`/api/sessions/${sessionId}/usage`, user)
			.then((r) => (r.ok ? r.json() : null))
			.then((b: { contextWindow?: number | null; runs?: { runId: string; points: { agentIndex?: number; requestTokens?: number; tokensOut?: number; costUsd?: number | null }[] }[] } | null) => {
				if (!b?.runs) return;
				setUsageRuns(
					b.runs.map((r) => ({
						runId: r.runId,
						contextWindow: b.contextWindow ?? null,
						points: (r.points ?? []).map((p) => ({ agentIndex: p.agentIndex ?? 0, requestTokens: p.requestTokens ?? 0, tokensOut: p.tokensOut ?? 0, costUsd: p.costUsd ?? null })),
					})),
				);
			})
			.catch(() => {});
	}, [focus, usageRuns, sessionId, user]);

	const renderItem = (item: Item, frozen = false) => {
		if (item.kind === "stream") {
			const done = item.done || frozen;
			if (item.streamKind === "reasoning") {
				// Thought stream: grey surface while live, collapses once done.
				return done ? (
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
						{done ? <Md text={item.text} /> : (
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
			return <Terminal key={item.key} item={frozen && item.output === undefined ? { ...item, output: item.liveOutput ?? "" } : item} />;
		}
		if (item.kind === "perm") return <PermissionCard key={item.key} user={user} item={item} active={!!active && !lateAfter} />;
		// Multi-agent orchestration events → dedicated cards.
		const et = item.e.event.type;
		if (et === "slice-status") return null;
		if (et === "fanout") {
			const slices = (item.e.event.slices as { index: number; title: string; owns: string[] }[]) ?? [];
			const runId = item.e.runId ?? "";
			return (
				<div key={item.key} className="fanout-card">
					<div className="fanout-head">Fanned out into {slices.length} parallel agents <span className="muted" style={{ fontWeight: 400 }}>— click an agent for its run</span></div>
					<div className="agent-board">
						{slices.map((s) => {
							const v = agentVitals(s.index, runId);
							const st = sliceStatus(s.index, runId);
							return (
								<div key={s.index} className={`agent-card ${st}`} onClick={() => setFocus({ runId, ai: s.index })}>
									<div className="agent-card-head">
										<span className="fanout-idx">#{s.index}</span>
										<span className="fanout-title">{s.title}</span>
										<SlicePill i={s.index} runId={runId} />
									</div>
									<div className="muted last-act">{v.lastAct || s.owns.slice(0, 3).join(", ") || "queued"}</div>
									<div className="muted agent-vitals">
										{v.tin > 0 && <>{fmtTok(v.tin)} in · {fmtTok(v.tout)} out · </>}
										{v.ctxPct > 0 && <>ctx {v.ctxPct}% · </>}
										{v.files > 0 && <>{v.files} file{v.files === 1 ? "" : "s"} · </>}
										{v.dur}
									</div>
								</div>
							);
						})}
						{(() => {
							const v = agentVitals(0, runId);
							return (
								<div className="agent-card coordinator" onClick={() => setFocus({ runId, ai: 0 })}>
									<div className="agent-card-head">
										<span className="fanout-idx">#0</span>
										<span className="fanout-title">Coordinator</span>
									</div>
									<div className="muted last-act">{v.lastAct || "orchestration + merge"}</div>
									<div className="muted agent-vitals">
										{v.tin > 0 && <>{fmtTok(v.tin)} in · {fmtTok(v.tout)} out · </>}
										{v.dur}
									</div>
								</div>
							);
						})()}
					</div>
				</div>
			);
		}
		if (et === "fanin") {
			const results = (item.e.event.results as { index: number; title: string; status: string; detail?: string }[]) ?? [];
			const icon = (s: string) => (s === "merged" ? "✓" : s === "resolved" ? "⚠" : "✗");
			return (
				<div key={item.key} className="fanin-card">
					<div className="fanout-head">Merge results</div>
					{results.map((r) => (
						<div key={r.index} className="fanout-row clickable" onClick={() => setFocus({ runId: item.e.runId ?? "", ai: r.index })}>
							<span className={`fanin-icon ${r.status}`}>{icon(r.status)}</span>
							<span className="fanout-title">{r.title}</span>
							<span className="muted fanout-owns">{r.status}{r.detail ? ` — ${r.detail}` : ""}</span>
							<span className="fanout-go">›</span>
						</div>
					))}
				</div>
			);
		}
		if (et === "fanin-conflict") {
			const files = (item.e.event.files as string[]) ?? [];
			return (
				<div key={item.key} className="ev-line">
					<span className="dot amber" />
					<span>Merge conflict in slice {String(item.e.event.index)} — coordinator resolving ({files.slice(0, 3).join(", ")}{files.length > 3 ? ` +${files.length - 3}` : ""})</span>
				</div>
			);
		}
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
	// Multi-agent helpers: slice titles come from that run's fanout event; live
	// status from the run doc's slices[] (falling back to slice-status events).
	const fanoutEvFor = (runId?: string) =>
		seen.find((i) => i.kind === "event" && i.e.event.type === "fanout" && i.e.runId === runId) ??
		seen.find((i) => i.kind === "event" && i.e.event.type === "fanout");
	const sliceTitle = (i: number, runId?: string): string => {
		const fe = fanoutEvFor(runId);
		const s = (fe?.kind === "event" ? (fe.e.event.slices as { index: number; title: string }[] | undefined) : undefined)?.find(
			(x) => x.index === i,
		);
		return s?.title ?? `Slice ${i}`;
	};
	const sliceStatus = (i: number, runId?: string): string => {
		const fromRun = runs?.find((r) => r.runId === runId)?.slices?.find((s) => s.index === i)?.status;
		if (fromRun) return fromRun;
		for (let k = events.length - 1; k >= 0; k--) {
			const e = events[k];
			const ev = e.event;
			if (ev.type === "slice-status" && ev.index === i && (!runId || e.runId === runId)) return String(ev.status);
		}
		return "queued";
	};
	const SlicePill = ({ i, runId }: { i: number; runId?: string }) => <span className={`slice-pill ${sliceStatus(i, runId)}`}>{sliceStatus(i, runId)}</span>;

	/** Live vitals for one agent lane — all derived from the event stream. */
	const agentVitals = (ai: number, runId?: string) => {
		let lastAct = "";
		type UsageEv = { inputTokens?: number; outputTokens?: number; contextPct?: number; contextWindow?: number };
		let usage: UsageEv | null = null;
		let files = 0;
		let startedAt = 0;
		let endedAt = 0;
		for (const e of events) {
			if ((e.event.agentIndex ?? 0) !== ai || (runId && e.runId !== runId)) continue;
			const ev = e.event as Record<string, unknown> & { type: string };
			if (ev.type === "run-started") startedAt = Date.parse(e.at ?? "") || startedAt;
			if (ev.type === "run-finished" || ev.type === "run-failed") endedAt = Date.parse(e.at ?? "") || endedAt;
			if (ev.type === "usage") usage = ev as unknown as UsageEv;
			if (ev.type === "file-changed") {
				files++;
				lastAct = `edited ${String(ev.path ?? "")}`;
			}
			if (ev.type === "tool-started") {
				const inp = (ev.input ?? {}) as Record<string, unknown>;
				lastAct = `${String(ev.name)} ${String(inp.path ?? inp.file ?? inp.command ?? inp.url ?? inp.query ?? inp.slug ?? "")}`.trim();
			}
			if (ev.type === "assistant-text") lastAct = String(ev.text ?? "").split("\n")[0].slice(0, 100);
			if (ev.type === "run-finished") lastAct = "finished";
			if (ev.type === "run-failed") lastAct = `failed: ${String(ev.error ?? "").slice(0, 80)}`;
		}
		// Live activity prefers the in-flight tool over the last text.
		const secs = startedAt ? Math.round(((endedAt || Date.now()) - startedAt) / 1000) : 0;
		const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
		return { lastAct, tin: usage?.inputTokens ?? 0, tout: usage?.outputTokens ?? 0, ctxPct: usage?.contextPct ?? 0, files, dur: startedAt ? dur : "" };
	};

	const lateItems = lateAfter ? seen.filter(isLate) : [];
	const normalItems = lateAfter ? seen.filter((i) => !isLate(i)) : seen;
	// Multi-agent lanes: items tagged agentIndex>0 render grouped under the
	// fanout card instead of interleaved with coordinator/main-lane events.
	// Lanes keyed `${runId}:${agentIndex}` — a second multi run in the same
	// session must group under its own fanout card, not bleed into the first.
	const laneKeyOf = (item: Item): { runId: string; ai: number } => {
		if (item.kind === "event") return { runId: item.e.runId ?? "", ai: item.e.event.agentIndex ?? 0 };
		return { runId: item.runId ?? "", ai: item.agentIndex ?? 0 };
	};
	const laneItems = new Map<string, Item[]>();
	const mainItems: Item[] = [];
	for (const i of normalItems) {
		const { runId, ai } = laneKeyOf(i);
		if (ai > 0) {
			const k = `${runId}:${ai}`;
			const l = laneItems.get(k) ?? [];
			l.push(i);
			laneItems.set(k, l);
		} else {
			mainItems.push(i);
		}
	}
	// Lane open state: default by status, but a manual toggle sticks across re-renders.
	const [laneToggles, setLaneToggles] = useState<Map<string, boolean>>(new Map());
	const lanesBlock = (runId: string | undefined) =>
		laneItems.size > 0 && (
			<div className="slice-lanes">
				{[...laneItems.entries()]
					.filter(([k]) => k.startsWith(`${runId ?? ""}:`))
					.map(([k, litems]) => {
						const i = Number(k.split(":").pop());
						const st = sliceStatus(i, runId);
						const open = laneToggles.get(k) ?? (st === "running" || st === "queued");
						return (
							<details
								key={k}
								className={`slice-lane ${st}`}
								open={open}
								onToggle={(e) => {
									const el = e.currentTarget;
									if (el.open !== open)
										setLaneToggles((prev) => {
											const next = new Map(prev);
											next.set(k, el.open);
											return next;
										});
								}}
							>
								<summary>
									<span className="fanout-idx">#{i}</span> {sliceTitle(i, runId)} <SlicePill i={i} runId={runId} />
									<span className="muted" style={{ marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "50%" }}>
										{agentVitals(i, runId).lastAct ? `${agentVitals(i, runId).lastAct} · ` : ""}{litems.length} events
									</span>
								</summary>
								<div className="slice-lane-body">{litems.map((item) => renderItem(item, !!lateAfter))}</div>
							</details>
						);
					})}
			</div>
		);
	// Focused per-agent view — replaces the consolidated stream while set.
	if (focus) {
		const { runId, ai } = focus;
		const sliceMeta = runs?.find((r) => r.runId === runId)?.slices?.find((s) => s.index === ai);
		const statusEv = [...events].reverse().find((e) => e.runId === runId && e.event.type === "slice-status" && e.event.index === ai);
		const title = ai === 0 ? "Coordinator / merge lane" : sliceTitle(ai, runId);
		const status = ai === 0 ? "" : sliceStatus(ai, runId);
		const summary = sliceMeta?.summary ?? (statusEv ? String(statusEv.event.summary ?? "") : "");
		const focusItems =
			ai > 0 ? (laneItems.get(`${runId}:${ai}`) ?? []) : mainItems.filter((i) => laneKeyOf(i).runId === runId);
		// Per-agent stats: usage points (session usage endpoint), memory +
		// compaction events already in the stream.
		const pts = usageRuns?.find((r) => r.runId === runId)?.points.filter((p) => p.agentIndex === ai) ?? [];
		const tin = pts.reduce((s, p) => s + p.requestTokens, 0);
		const tout = pts.reduce((s, p) => s + p.tokensOut, 0);
		const cost = pts.reduce((s, p) => s + (p.costUsd ?? 0), 0);
		const ctxWin = usageRuns?.find((r) => r.runId === runId)?.contextWindow ?? 0;
		const maxCtx = ctxWin ? Math.round((Math.max(0, ...pts.map((p) => p.requestTokens)) / ctxWin) * 100) : 0;
		const memCount = events.filter((e) => e.runId === runId && (e.event.agentIndex ?? 0) === ai && e.event.type === "memory").length;
		const compactions = events.filter((e) => e.runId === runId && (e.event.agentIndex ?? 0) === ai && (e.event as { meta?: { kind?: string } }).meta?.kind === "context_compaction").length;
		const vitals = agentVitals(ai, runId);
		return (
			<div className="timeline">
				<div className="focus-bar">
					<button className="focus-back" onClick={() => setFocus(null)}>← All agents</button>
					<span className="fanout-idx">#{ai}</span>
					<span className="fanout-title">{title}</span>
					{status ? <span className={`slice-pill ${status}`}>{status}</span> : null}
					{vitals.lastAct && status === "running" ? <span className="muted focus-live">{vitals.lastAct}</span> : null}
					<span className="focus-stats muted">
						{tin > 0 && <>{fmtTok(tin)} in · {fmtTok(tout)} out{cost > 0 ? ` · $${cost.toFixed(4)}` : ""} · </>}
						{vitals.dur && <>{vitals.dur} · </>}
						{maxCtx > 0 && <>ctx {maxCtx}% peak · </>}
						{compactions > 0 && <>{compactions} compaction{compactions === 1 ? "" : "s"} · </>}
						{memCount} memory · {focusItems.length} events
					</span>
				</div>
				{summary ? <div className="focus-summary muted">{summary}</div> : null}
				{focusItems.length === 0 ? (
					<div className="muted" style={{ padding: 20 }}>No events yet for this agent.</div>
				) : (
					focusItems.map((item) => renderItem(item, !!lateAfter))
				)}
				{lateAfter && (
					<div className={`stop-banner${lateAfter.halted ? " halted" : ""}`}>
						{lateAfter.halted ? "⏸ Stopped" : "⏸ Stopping — waiting for the run to halt…"}
					</div>
				)}
			</div>
		);
	}
	return (
		<div className="timeline">
			{items.length === 0 && <div className="muted" style={{ padding: 20 }}>Waiting for events…</div>}
			{mainItems.map((item) => (
				<Fragment key={item.key}>
					{renderItem(item, !!lateAfter)}
					{item.kind === "event" && item.e.event.type === "fanout" ? lanesBlock(item.e.runId) : null}
				</Fragment>
			))}
			{/* Orphan lanes: agentIndex-tagged items whose run emitted no fanout
			    event (lost/failed fanout) must still be visible somewhere. */}
			{(() => {
				const fanoutRunIds = new Set(
					mainItems.filter((i) => i.kind === "event" && i.e.event.type === "fanout").map((i) => (i.kind === "event" ? i.e.runId : "")),
				);
				const orphans = [...laneItems.keys()].filter((k) => !fanoutRunIds.has(k.split(":")[0]));
				if (!orphans.length) return null;
				// One collapsed container — orphan lanes belong to runs whose fan-out
				// card isn't in this event window; stacking N sections at the bottom
				// is noise. Clickable rows still drill into the agent's stream.
				return (
					<details className="slice-lanes orphan-lanes">
						<summary className="muted">
							{orphans.length} agent lane{orphans.length === 1 ? "" : "s"} without a fan-out card — click an agent to view its run
						</summary>
						{orphans.map((k) => {
							const [rid, idx] = [k.split(":")[0], Number(k.split(":").pop())];
							const litems = laneItems.get(k)!;
							return (
								<details key={k} className="slice-lane">
									<summary onClick={(e) => { e.preventDefault(); setFocus({ runId: rid, ai: idx }); }}>
										<span className="fanout-idx">#{idx}</span> {sliceTitle(idx, rid)}
										<span className="muted" style={{ marginLeft: "auto" }}>{agentVitals(idx, rid).lastAct ? `${agentVitals(idx, rid).lastAct} · ` : ""}{litems.length} events</span>
									</summary>
									<div className="slice-lane-body">{litems.map((item) => renderItem(item, !!lateAfter))}</div>
								</details>
							);
						})}
					</details>
				);
			})()}
			{lateAfter && (
				<div className={`stop-banner${lateAfter.halted ? " halted" : ""}`}>
					{lateAfter.halted ? "⏸ Stopped" : "⏸ Stopping — waiting for the run to halt…"}
				</div>
			)}
			{lateItems.length > 0 && (
				<details className="late-events">
					<summary className="muted">
						{lateItems.length} late event{lateItems.length === 1 ? "" : "s"} — arrived {lateAfter?.halted ? "after stop" : "while stopping"}
					</summary>
					{lateItems.map((item) => (
						<div key={item.key} className="tl-late">{renderItem(item)}</div>
					))}
				</details>
			)}
		</div>
	);
}
