"use client";

import type { User } from "firebase/auth";
import { Fragment, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { apiFetch } from "@/lib/api";
import { CopyButton } from "@/components/CopyButton";
import { fmtTok } from "@/components/AreaChart";
import type { RunDoc, RunEvent } from "@/lib/types";
import {
	buildTimeline,
	group,
	groupWorked,
	toolDetail,
	toolMeta,
	toolPath,
	toolTarget,
	workedStats,
	type ActionItem,
	type Item,
	type StreamItem,
	type TurnItem,
	type WorkedItem,
} from "@/lib/timelineModel";
import { agentVitals, sliceIcon, sliceStatus, sliceSummary, sliceTitle, type AgentFocus } from "@/lib/agentLanes";

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

/** Two-pane diff: del/add runs paired positionally, ctx on both sides. */
function SplitDiffBody({ diff }: { diff: string }) {
	const { rows, truncated } = diffLines(diff);
	const pairs: { l?: DiffLine; r?: DiffLine; hunk?: string }[] = [];
	const pendDel: DiffLine[] = [];
	const pendAdd: DiffLine[] = [];
	const flush = () => {
		const n = Math.max(pendDel.length, pendAdd.length);
		for (let i = 0; i < n; i++) pairs.push({ l: pendDel[i], r: pendAdd[i] });
		pendDel.length = 0;
		pendAdd.length = 0;
	};
	for (const row of rows) {
		if (row.cls === "fd-l-hunk") {
			flush();
			pairs.push({ hunk: row.text });
			continue;
		}
		if (row.cls === "fd-l-del") {
			pendDel.push(row);
			continue;
		}
		if (row.cls === "fd-l-add") {
			pendAdd.push(row);
			continue;
		}
		flush();
		pairs.push({ l: row, r: row });
	}
	flush();
	return (
		<div className="fd-body fd-split">
			{pairs.map((p, i) =>
				p.hunk !== undefined ? (
					<div key={i} className="fd-srow fd-s-hunk">
						<span className="fd-code">{p.hunk}</span>
					</div>
				) : (
					<div key={i} className="fd-srow">
						<div className={`fd-scol ${p.l?.cls ?? "fd-empty"}`}>
							<span className="fd-num">{p.l?.num ?? ""}</span>
							<span className="fd-code">{p.l?.text ?? ""}</span>
						</div>
						<div className={`fd-scol ${p.r?.cls ?? "fd-empty"}`}>
							<span className="fd-num">{p.r?.num ?? ""}</span>
							<span className="fd-code">{p.r?.text ?? ""}</span>
						</div>
					</div>
				),
			)}
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

/** Per-iteration group — "Worked for Ns" header, collapsible body of member cards. */
function TurnCard({
	turn,
	settled,
	toggled,
	onToggle,
	id,
	children,
}: {
	turn: TurnItem;
	settled: boolean;
	toggled?: boolean;
	onToggle: (open: boolean) => void;
	id?: string;
	children: React.ReactNode;
}) {
	const done = settled || turn.done;
	const durMs = (() => {
		const s = Date.parse(turn.at ?? "");
		const e = Date.parse(turn.endAt ?? "");
		if (!Number.isNaN(s) && !Number.isNaN(e) && e > s) return e - s;
		return turn.fallbackMs ?? 0;
	})();
	const actions = turn.items.filter((i): i is ActionItem => i.kind === "action");
	const cmds = actions.filter((a) => a.name === "run_command").length;
	const edits = actions.filter((a) => a.path);
	const added = edits.reduce((a, i) => a + (i.added ?? 0), 0);
	const removed = edits.reduce((a, i) => a + (i.removed ?? 0), 0);
	const fails = actions.filter((a) => a.ok === false).length;
	const open = toggled ?? !done;
	// Achieved rollup: short per-action labels with outcome marks — what this
	// iteration actually did, shown under the collapsed header.
	const actionLabel = (a: ActionItem): string => {
		const inp = (a.input ?? {}) as Record<string, unknown>;
		const trunc = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);
		if (a.name === "run_command") return `$ ${trunc(String(inp.command ?? inp.cmd ?? ""))}`;
		if (a.path) return `edit ${a.path.split("/").pop()}`;
		const target = String(inp.path ?? inp.file ?? inp.query ?? inp.url ?? inp.slug ?? "");
		return trunc(target ? `${a.name} ${target}` : a.name);
	};
	const achieved = actions.map((a) => ({ ok: a.ok !== false, label: actionLabel(a) }));
	const MAX_ACHIEVED = 3;
	// Next step: the turn's last narration, kept visible under a collapsed
	// header so scanning the feed reads as "Worked → what it did → what's next".
	const note = [...turn.items]
		.reverse()
		.find((i): i is StreamItem => i.kind === "stream" && i.streamKind === "assistant" && !!i.text.trim());
	// Card header: the achieved rollup, falling back to the narration's first
	// line (or "Working…" live) when the step produced no tool actions.
	const headline = achieved.length ? null : note?.text.split("\n")[0];
	return (
		<div className="step" id={id}>
			<div className="step-rail">
				<span className="step-num">{turn.num ?? "•"}</span>
			</div>
			<div className="step-card">
				{!open && <div className="step-achieved">
					{achieved.length > 0 ? (
						<>
							{achieved.slice(0, MAX_ACHIEVED).map((a, i) => (
								<span key={i} className="worked-done-item">
									<span style={{ color: a.ok ? "var(--ok)" : "var(--err)" }}>{a.ok ? "✓" : "✗"}</span>{" "}
									<span className="mono">{a.label}</span>
								</span>
							))}
							{achieved.length > MAX_ACHIEVED && <span className="muted">+{achieved.length - MAX_ACHIEVED} more</span>}
						</>
					) : (
						<span className={done ? "muted" : ""}>{done ? headline || "Done" : headline || "Working…"}</span>
					)}
				</div>}
				<details
					className={`worked${done ? "" : " live"}`}
					open={open}
					onToggle={(e) => {
						const el = e.currentTarget;
						if (el.open !== open) onToggle(el.open);
					}}
				>
					<summary className="worked-head">
						<span className="caret">{open ? "▾" : "▸"}</span>
						{done ? (
							<span>Worked{durMs >= 1000 ? ` for ${fmtDur(durMs)}` : ""}</span>
						) : (
							<Elapsed />
						)}
						{fails > 0 && <span className="act-pill err">{fails} failed</span>}
						<span className="worked-stats muted">
							{cmds > 0 && <span>{cmds} cmd{cmds === 1 ? "" : "s"}</span>}
							{edits.length > 0 && (
								<span>
									{edits.length} file{edits.length === 1 ? "" : "s"}
									{(added > 0 || removed > 0) && (
										<>
											{" "}<span className="fd-add">+{added}</span> <span className="fd-del">−{removed}</span>
										</>
									)}
								</span>
							)}
						</span>
					</summary>
					<div className="worked-body">{children}</div>
				</details>
				{!open && note && (
					<div className="step-note worked-note">
						<Md text={note.text} />
					</div>
				)}
			</div>
		</div>
	);
}

/** Merged "Worked" block — one collapsible section for consecutive done turns. */
function WorkedBlock({
	turns,
	settled,
	frozen,
	renderItem,
}: {
	turns: TurnItem[];
	settled: boolean;
	frozen?: boolean;
	renderItem: (item: Item | WorkedItem, frozen?: boolean) => React.ReactNode;
}) {
	const stats = workedStats(turns);
	const done = settled || turns.every((t) => t.done);
	const [open, setOpen] = useState(!done);
	useEffect(() => setOpen(!done), [done]);
	return (
		<details className={`worked${done ? "" : " live"}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary className="worked-head">
				<span className="caret">{open ? "▾" : "▸"}</span>
				{done ? (
					<span>Worked{stats.secs >= 1 ? ` for ${fmtDur(stats.secs * 1000)}` : ""}</span>
				) : (
					<span>Working…</span>
				)}
				{(stats.added > 0 || stats.removed > 0) && (
					<span className="worked-diff">
						<span className="fd-add">+{stats.added}</span> <span className="fd-del">−{stats.removed}</span>
					</span>
				)}
				<span className="worked-stats muted">
					<span>{stats.actions} action{stats.actions === 1 ? "" : "s"}</span>
					{stats.files > 0 && <span>{stats.files} file{stats.files === 1 ? "" : "s"}</span>}
				</span>
			</summary>
			<div className="worked-body">
				{turns.flatMap((t) => t.items).map((ch) => (
					<Fragment key={ch.key}>{renderItem(ch, frozen)}</Fragment>
				))}
			</div>
		</details>
	);
}

/** Terminal card — `$ cmd` chrome, streamed output live, collapses on finish. */
function TermCard({ item, frozen }: { item: ActionItem; frozen?: boolean }) {
	const inp = item.input as Record<string, unknown> | undefined;
	const cmd = String(inp?.command ?? inp?.cmd ?? item.name);
	const done = frozen || item.output !== undefined;
	const failed = done && item.ok === false;
	const [open, setOpen] = useState(!done || failed);
	useEffect(() => setOpen(!done || failed), [done, failed]);
	const outRef = useRef<HTMLPreElement | null>(null);
	const out = prettyOut(item.output ?? item.liveOutput ?? "").slice(0, 4000);
	// Follow the tail while streaming.
	useEffect(() => {
		if (outRef.current && open) outRef.current.scrollTop = outRef.current.scrollHeight;
	}, [out, open]);
	return (
		<div className={`term${failed ? " failed" : ""}`}>
			<button className="term-head" onClick={() => setOpen((v) => !v)}>
				<span className="caret">{open ? "▾" : "▸"}</span>
				<span className="term-label muted">Run command</span>
				<span className="term-cmd">$ {cmd.length > 140 ? `${cmd.slice(0, 140)}…` : cmd}</span>
				<span className="term-meta">
					{done ? (
						<>
							{item.durationMs !== undefined && <span className="muted">{fmtDur(item.durationMs)}</span>}
							{failed ? <span className="term-err">✗ failed</span> : <span className="term-ok">✓</span>}
						</>
					) : (
						<>
							<Elapsed />
							<span className="act-pill run">In progress…</span>
						</>
					)}
				</span>
			</button>
			{open && (
				<div className="term-out-wrap">
					<div className="term-out-label muted">Output{done ? "" : " (streaming)"}</div>
					<pre ref={outRef} className="term-out">{out || "…"}</pre>
					{done && !!out && <CopyButton text={out} label="" />}
				</div>
			)}
		</div>
	);
}

/** File-change card — ⚙ path + +/− chips, expandable numbered diff body. */
function DiffCard({
	path,
	added,
	removed,
	diff,
	preview,
	live,
	failed,
}: {
	path?: string;
	added?: number;
	removed?: number;
	diff?: string;
	/** Fallback body when no diff was captured (e.g. edit still in flight). */
	preview?: string;
	live?: boolean;
	failed?: boolean;
}) {
	const done = !live;
	const [open, setOpen] = useState(!done || !!failed);
	const [split, setSplit] = useState(false);
	useEffect(() => setOpen(!done || !!failed), [done, failed]);
	return (
		<div className={`filediff${failed ? " failed" : ""}`}>
			<div className="filediff-head" onClick={() => setOpen((v) => !v)}>
				<span className="caret">{open ? "▾" : "▸"}</span>
				<span className="act-icon">⚙</span>
				<span className="mono fd-path">{path ?? "file"}</span>
				{diff && open && (
					<span className="fd-seg" onClick={(e) => e.stopPropagation()}>
						<span className={`fd-seg-btn${split ? "" : " on"}`} onClick={() => setSplit(false)}>Unified</span>
						<span className={`fd-seg-btn${split ? " on" : ""}`} onClick={() => setSplit(true)}>Split</span>
					</span>
				)}
				{(added != null || removed != null) && (
					<span className="fd-stats">
						{added != null && <span className="fd-add">+{added}</span>}
						{removed != null && <span className="fd-del">−{removed}</span>}
					</span>
				)}
				{failed ? <span className="act-pill err">Failed</span> : live ? <span className="act-pill run">Editing</span> : null}
			</div>
			{open && (diff ? (split ? <SplitDiffBody diff={diff} /> : <DiffBody diff={diff} />) : preview ? <pre className="act-out">{preview}</pre> : null)}
		</div>
	);
}

/** Edit tool action → DiffCard. */
function EditCard({ item }: { item: ActionItem }) {
	return (
		<DiffCard
			path={item.path}
			added={item.added}
			removed={item.removed}
			diff={item.diff}
			preview={toolInput(item.input)}
			live={item.output === undefined}
			failed={item.output !== undefined && item.ok === false}
		/>
	);
}

/** Concise tool row — icon + verb + target, status pill, expandable I/O. */
function ToolRow({ item, frozen }: { item: ActionItem; frozen?: boolean }) {
	const meta = toolMeta(item.name);
	const target = toolTarget(item);
	const path = toolPath(item);
	const detail = toolDetail(item);
	const done = frozen || item.output !== undefined;
	const failed = done && item.ok === false;
	return (
		<ActionCard
			icon={<span className="tl-tool-ico">{meta.icon}</span>}
			title={
				<span>
					{meta.verb}
					{path ? <> <span className="mono">{path}</span></> : target && <> <span className="mono muted">{target}</span></>}
					{detail && <span className="muted"> · {detail}</span>}
				</span>
			}
			stats={
				item.output !== undefined
					? item.durationMs !== undefined && <span className="muted act-stat">{fmtDur(item.durationMs)}</span>
					: <Elapsed />
			}
			status={
				item.output !== undefined ? (
					item.ok === false ? <span className="act-pill err">Failed</span> : <span className="act-pill ok">Done</span>
				) : (
					<span className="act-pill run">Running</span>
				)
			}
			done={done}
			failed={failed}
		>
			{toolInput(item.input) && <pre className="act-out" style={{ maxHeight: 120 }}>{toolInput(item.input)}</pre>}
			<pre className="act-out">{prettyOut(item.output ?? item.liveOutput ?? "").slice(0, 4000) || "…"}</pre>
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

function Event({ user, sessionId, e, events, runs, githubUrl, onShowFailures }: { user: User; sessionId: string; e: RunEvent; events: RunEvent[]; runs: RunDoc[]; githubUrl?: string; onShowFailures?: (runId: string) => void }) {
	const ev = e.event;
	const kind = KIND[ev.type] ?? ev.type;
	const cls =
		ev.type === "run-failed" ? "failed"
		: ev.type === "cloud-status" || ev.type === "info" || ev.type === "setup" ? "status"
		: "";

	// Durable transcript records — replay/resume only, never display.
	if (ev.type === "agent-message" || ev.type === "agent-message-chunk") return null;

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
			<div className="msg-row user-msg-row">
				<span className="msg-time">{fmtTime(e.at)}</span>
				<div className="user-bubble" id={`msg-${e.runId}`}>
					<span className="stream-text">{task}</span>
					{attCount > 0 && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>+{attCount} attached file{attCount > 1 ? "s" : ""}</div>}
				</div>
				<span className="avatar">{(user.email ?? "U")[0].toUpperCase()}</span>
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
		// Orphan finish (no matching tool-started in the window) — one muted line.
		const ok = ev.ok !== false;
		return (
			<div className="ev-line muted">
				<span className="dot" style={{ background: ok ? "var(--ok)" : "var(--err)" }} />
				<span>Result {ok ? "✓" : "✗"} {String(ev.name ?? "tool")}</span>
			</div>
		);
	}
	if (ev.type === "memory") {
		const n = Array.isArray(ev.items) ? ev.items.length : Number(ev.hits ?? 0);
		return (
			<div className="ev-line muted">
				<span className="dot" />
				<span>Memory recalled{n ? ` · ${n} item${n === 1 ? "" : "s"}` : ""}</span>
			</div>
		);
	}
	if (ev.type === "file-changed") {
		// Standalone file change (e.g. shell writes) — compact diff card.
		return (
			<DiffCard
				path={String(ev.path)}
				added={ev.added != null ? Number(ev.added) : undefined}
				removed={ev.removed != null ? Number(ev.removed) : undefined}
				diff={String(ev.diff ?? "")}
			/>
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
						{issues} command{issues > 1 ? "s" : ""} or check{issues > 1 ? "s" : ""} failed during this run —{" "}
						{onShowFailures && e.runId ? (
							<button className="btn ghost sm" style={{ padding: "1px 8px", fontSize: 11 }} onClick={() => onShowFailures(e.runId!)}>
								view failures ↓
							</button>
						) : (
							"expand the cards above to inspect."
						)}
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
	focus: focusProp,
	onFocusChange,
}: {
	user: User;
	sessionId: string;
	events: RunEvent[];
	runs: RunDoc[];
	githubUrl?: string;
	active?: boolean;
	/** Events in lateAfter.runId with seq > lateAfter.seq render demoted behind a "stopping" divider. */
	lateAfter?: { runId: string; seq: number; halted: boolean };
	/** Controlled focus: when onFocusChange is set, `focus` is owned by the parent (session page also drives it from the multi-agent panel). */
	focus?: AgentFocus | null;
	onFocusChange?: (f: AgentFocus | null) => void;
}) {
	const items = buildTimeline(events);
	const seqOf = (item: Item | WorkedItem): number =>
		item.kind === "event" ? item.e.seq : item.kind === "worked" ? (item.turns[0]?.seq ?? 0) : (item.seq ?? 0);
	const runIdOf = (item: Item | WorkedItem): string | undefined =>
		item.kind === "event" ? item.e.runId : item.kind === "worked" ? item.turns[0]?.runId : item.runId;
	const isLate = (item: Item | WorkedItem): boolean =>
		!!lateAfter && runIdOf(item) === lateAfter.runId && seqOf(item) > lateAfter.seq;

	// Per-agent drill-down: click a fan-out/fan-in row → focused view shows only
	// that agent's stream + its usage/context/memory stats; back restores all.
	const [innerFocus, setInnerFocus] = useState<AgentFocus | null>(null);
	const focus = onFocusChange ? (focusProp ?? null) : innerFocus;
	const setFocus = (f: AgentFocus | null) => {
		if (!onFocusChange) setInnerFocus(f);
		else onFocusChange(f);
	};
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

	// Turn expand/collapse: default by done-ness, manual toggles stick.
	const [turnToggles, setTurnToggles] = useState<Map<string, boolean>>(new Map());

	const renderItem = (item: Item | WorkedItem, frozen = false): React.ReactNode => {
		if (item.kind === "worked") {
			return (
				<WorkedBlock
					key={item.key}
					turns={item.turns}
					settled={frozen || !active}
					frozen={frozen}
					renderItem={renderItem}
				/>
			);
		}
		if (item.kind === "turn") {
			return (
				<TurnCard
					key={item.key}
					turn={item}
					settled={frozen || !active}
					id={`tl-${item.key}`}
					toggled={turnToggles.get(item.key)}
					onToggle={(o) =>
						setTurnToggles((prev) => {
							const next = new Map(prev);
							next.set(item.key, o);
							return next;
						})
					}
				>
					{item.items.map((ch) => renderItem(ch, frozen))}
				</TurnCard>
			);
		}
		if (item.kind === "stream") {
			const done = item.done || frozen;
			if (item.streamKind === "reasoning") {
				// Thoughts row: collapsed once done, live stream while running.
				if (done) {
					const firstLine = item.text.split("\n").find((l) => l.trim()) ?? "";
					return (
						<details key={item.key} className="ev thinking tl-thought">
							<summary>
								Thoughts{firstLine ? <span className="tl-thought-preview"> — {firstLine.slice(0, 80)}</span> : ""}
							</summary>
							<Md text={item.text} />
						</details>
					);
				}
				return (
					<div key={item.key} className="ev thinking streaming">
						<div className="ev-kind">Thinking…</div>
						<span className="stream-text">{item.text}</span>
						<span className="stream-cursor" />
					</div>
				);
			}
			// Mid-run narration — a later action follows, so this isn't the
			// reply: small muted note instead of a full K bubble.
			if (done && !item.final) {
				return (
					<div key={item.key} className="step-note">
						<Md text={item.text} />
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
			// Write tools and anything carrying a captured diff → file card;
			// run_command → terminal card; everything else → concise tool row.
			const isWrite = WRITE_TOOLS.has(item.name) || (!!item.path && !!item.diff);
			if (isWrite) return <EditCard key={item.key} item={item} />;
			if (item.name === "run_command") return <TermCard key={item.key} item={item} frozen={frozen} />;
			return <ToolRow key={item.key} item={item} frozen={frozen} />;
		}
		if (item.kind === "perm") return <PermissionCard key={item.key} user={user} item={item} active={!!active && !lateAfter} />;
		if (item.kind === "preflight") return null;
		// Multi-agent orchestration events → dedicated cards.
		const et = item.e.event.type;
		if (et === "slice-status") return null;
		if (et === "multi-plan") {
			const steps = (item.e.event.steps as { index: number; title: string; task: string }[]) ?? [];
			return (
				<div key={item.key} className="fanout-card">
					<div className="fanout-head">Here's my plan</div>
					{steps.map((s) => (
						<div key={s.index} className="plan-step">
							<span className="plan-step-n">{s.index}.</span>
							<span className="fanout-title">{s.title}</span>
							<span className="muted plan-step-task">{String(s.task ?? "").split("\n")[0].slice(0, 140)}</span>
						</div>
					))}
				</div>
			);
		}
		if (et === "fanout") {
			const slices = (item.e.event.slices as { index: number; title: string; owns: string[] }[]) ?? [];
			const runId = item.e.runId ?? "";
			return (
				<div key={item.key} className="fanout-card">
					<div className="fanout-head">Fanned out into {slices.length} parallel agents <span className="muted" style={{ fontWeight: 400 }}>— click an agent for its run</span></div>
					<div className="agent-board">
						{slices.map((s) => {
							const v = vitalsOf(s.index, runId);
							const st = stOf(s.index, runId);
							return (
								<div key={s.index} className={`agent-card ${st}`} onClick={() => setFocus({ runId, ai: s.index })}>
									<div className="agent-card-head">
										<span className="fanout-ico">{sliceIcon(s.title)}</span>
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
							const v = vitalsOf(0, runId);
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
			const runId = item.e.runId ?? "";
			const ok = results.filter((r) => r.status !== "failed").length;
			// Wall-clock of the parallel phase ≈ the longest slice lane.
			const totalSecs = Math.max(0, ...results.map((r) => vitalsOf(r.index, runId).secs));
			const total = totalSecs >= 60 ? `${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s` : `${totalSecs}s`;
			const cd = [...events].reverse().find((e) => e.runId === runId && e.event.type === "combined-diff");
			return (
				<div key={item.key} className="fanin-card">
					<div className="fanout-head">
						Merge results{" "}
						<span className="muted" style={{ fontWeight: 400 }}>
							· {ok}/{results.length} completed{totalSecs > 0 ? ` · Total: ${total}` : ""}
						</span>
					</div>
					{results.map((r) => {
						const sum = sliceSummary(events, runs, r.index, runId);
						return (
							<div key={r.index} className="fanout-row clickable" onClick={() => setFocus({ runId, ai: r.index })}>
								<span className={`fanin-icon ${r.status}`}>{icon(r.status)}</span>
								<span className="fanout-title">
									{r.title}
									{sum ? <span className="muted fanin-sum">{sum.slice(0, 140)}</span> : null}
								</span>
								<span className="muted fanout-owns">{r.status}{r.detail ? ` — ${r.detail}` : ""}</span>
								<span className="fanout-go">›</span>
							</div>
						);
					})}
					{cd ? (
						<details className="ma-diff">
							<summary>View combined diff</summary>
							<DiffBody diff={String(cd.event.diff ?? "")} />
						</details>
					) : null}
					<details className="ma-diff">
						<summary>View detailed report</summary>
						<div className="changes-files">
							{results.map((r) => {
								const v = vitalsOf(r.index, runId);
								const sum = sliceSummary(events, runs, r.index, runId);
								const fileCount = new Set(
									events
										.filter((e) => e.runId === runId && (e.event.agentIndex ?? 0) === r.index && e.event.type === "file-changed")
										.map((e) => String(e.event.path ?? ""))
										.filter(Boolean),
								).size;
								return (
									<div key={r.index} className="fanin-report">
										<div className="fanin-report-head">
											<span className={`fanin-icon ${r.status}`}>{icon(r.status)}</span>
											<span className="fanout-title">{r.title}</span>
											<span className="muted fanin-report-meta">
												{r.status}
												{v.dur ? ` · ${v.dur}` : ""}
												{v.tin + v.tout > 0 ? ` · ${fmtTok(v.tin + v.tout)} tok` : ""}
												{fileCount > 0 ? ` · ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}
											</span>
										</div>
										{sum ? <div className="muted fanin-report-sum">{sum}</div> : null}
									</div>
								);
							})}
						</div>
					</details>
				</div>
			);
		}
		if (et === "combined-diff") {
			const files = (item.e.event.files as { path: string; status: string; added: number; removed: number }[]) ?? [];
			const diff = String(item.e.event.diff ?? "");
			const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.|test_.*\.py$|_test\.(go|rs)$|Tests?\.(cs|fs|vb)$/i.test(p);
			const isDoc = (p: string) => /\.(md|mdx|rst|adoc)$|^docs?\//i.test(p);
			const tests = files.filter((f) => isTest(f.path)).length;
			const docs = files.filter((f) => !isTest(f.path) && isDoc(f.path)).length;
			const rest = files.filter((f) => !isTest(f.path) && !isDoc(f.path));
			const modified = rest.filter((f) => f.status === "M").length;
			const added = rest.filter((f) => f.status === "A").length;
			const deleted = files.filter((f) => f.status === "D").length;
			return (
				<div key={item.key} className="changes-card">
					<div className="fanout-head">Changes applied</div>
					<div className="changes-chips">
						{modified > 0 && <span className="changes-chip">{modified} file{modified === 1 ? "" : "s"} modified</span>}
						{added > 0 && <span className="changes-chip">{added} file{added === 1 ? "" : "s"} added</span>}
						{deleted > 0 && <span className="changes-chip">{deleted} file{deleted === 1 ? "" : "s"} deleted</span>}
						{tests > 0 && <span className="changes-chip">🧪 {tests} test file{tests === 1 ? "" : "s"}</span>}
						{docs > 0 && <span className="changes-chip">📄 {docs} doc{docs === 1 ? "" : "s"}</span>}
						{files.length === 0 && <span className="muted">No file changes detected.</span>}
					</div>
					{item.e.event.stat ? <div className="muted changes-stat">{String(item.e.event.stat)}{item.e.event.truncated ? " · diff truncated" : ""}</div> : null}
					{files.length > 0 && (
						<details className="ma-diff">
							<summary>View changes ({files.length} file{files.length === 1 ? "" : "s"})</summary>
							<div className="changes-files">
								{files.map((f) => (
									<div key={f.path} className="changes-file mono">
										<span className={`changes-st st-${f.status}`}>{f.status}</span> {f.path}
										<span className="muted"> +{f.added}/−{f.removed}</span>
									</div>
								))}
							</div>
							{diff && <DiffBody diff={diff} />}
						</details>
					)}
					{(() => {
						const steps = (item.e.event.nextSteps as string[] | undefined) ?? [];
						return steps.length > 0 ? (
							<details className="ma-diff">
								<summary>Next steps ({steps.length})</summary>
								<ul className="next-steps">
									{steps.map((s, i) => (
										<li key={i}>{s}</li>
									))}
								</ul>
							</details>
						) : null;
					})()}
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
		return <Event key={item.key} user={user} sessionId={sessionId} e={item.e} events={events} runs={runs} githubUrl={githubUrl} onShowFailures={jumpToFailures} />;
	};

	// Multi-agent helpers (shared with MultiAgentPanel): titles from the
	// fanout event; live status from runs.slices[] / slice-status events.
	const stOf = (i: number, runId?: string) => sliceStatus(events, runs, i, runId);
	const vitalsOf = (ai: number, runId?: string) => agentVitals(events, ai, runId);
	const titleOf = (i: number, runId?: string) => sliceTitle(events, i, runId);
	const SlicePill = ({ i, runId }: { i: number; runId?: string }) => <span className={`slice-pill ${stOf(i, runId)}`}>{stOf(i, runId)}</span>;

	// Lane split: items tagged agentIndex>0 render grouped under the fanout
	// card instead of interleaved with coordinator/main-lane events. Lanes
	// keyed `${runId}:${agentIndex}` — a second multi run must group under
	// its own fanout card, not bleed into the first.
	const laneKeyOf = (item: Item): { runId: string; ai: number } => {
		if (item.kind === "event") return { runId: item.e.runId ?? "", ai: item.e.event.agentIndex ?? 0 };
		return { runId: item.runId ?? "", ai: item.agentIndex ?? 0 };
	};
	const laneItems = new Map<string, Item[]>();
	const mainItems: Item[] = [];
	for (const i of items) {
		if (isLate(i as Item)) continue;
		const { runId, ai } = laneKeyOf(i as Item);
		if (ai > 0) {
			const k = `${runId}:${ai}`;
			const l = laneItems.get(k) ?? [];
			l.push(i as Item);
			laneItems.set(k, l);
		} else {
			mainItems.push(i as Item);
		}
	}
	const lateItems = lateAfter ? items.filter((i) => isLate(i)) : [];
	// Lane open state: default by status, but a manual toggle sticks across re-renders.
	const [laneToggles, setLaneToggles] = useState<Map<string, boolean>>(new Map());
	// "view failures" jump from the run-completed card: open every turn/lane
	// containing a failed action or check, then scroll to the first one.
	const isFailItem = (i: Item): boolean =>
		(i.kind === "action" && i.ok === false) ||
		(i.kind === "event" && (i.e.event.type === "tool-finished" || i.e.event.type === "check") && i.e.event.ok === false);
	const jumpToFailures = (runId: string) => {
		const failedTurns: string[] = [];
		const failedLanes = new Set<string>();
		const scan = (list: Item[], laneKey?: string) => {
			for (const i of group(list)) {
				if (i.kind === "turn") {
					if (i.items.some((x) => isFailItem(x) && laneKeyOf(x).runId === runId)) {
						failedTurns.push(i.key);
						if (laneKey) failedLanes.add(laneKey);
					}
				} else if (isFailItem(i) && laneKeyOf(i).runId === runId && laneKey) {
					failedLanes.add(laneKey);
				}
			}
		};
		scan(mainItems);
		for (const [k, l] of laneItems) if (k.startsWith(`${runId}:`)) scan(l, k);
		if (failedTurns.length)
			setTurnToggles((prev) => {
				const next = new Map(prev);
				for (const k of failedTurns) next.set(k, true);
				return next;
			});
		if (failedLanes.size)
			setLaneToggles((prev) => {
				const next = new Map(prev);
				for (const k of failedLanes) next.set(k, true);
				return next;
			});
		if (failedTurns[0])
			setTimeout(() => document.getElementById(`tl-${failedTurns[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
	};
	const lanesBlock = (runId: string | undefined) =>
		laneItems.size > 0 && (
			<div className="slice-lanes">
				{[...laneItems.entries()]
					.filter(([k]) => k.startsWith(`${runId ?? ""}:`))
					.map(([k, litems]) => {
						const i = Number(k.split(":").pop());
						const st = stOf(i, runId);
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
									<span className="fanout-idx">#{i}</span> {titleOf(i, runId)} <SlicePill i={i} runId={runId} />
									<span className="muted" style={{ marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "50%" }}>
										{vitalsOf(i, runId).lastAct ? `${vitalsOf(i, runId).lastAct} · ` : ""}{litems.length} events
									</span>
								</summary>
								<div className="slice-lane-body">{groupWorked(group(litems)).map((item) => renderItem(item, !!lateAfter))}</div>
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
		const title = ai === 0 ? "Coordinator / merge lane" : titleOf(ai, runId);
		const status = ai === 0 ? "" : stOf(ai, runId);
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
		const vitals = vitalsOf(ai, runId);
		// Outputs: this agent's changed files, deduped by path (latest wins).
		const outMap = new Map<string, { path: string; added: number; removed: number; kind: string; diff: string }>();
		for (const e of events) {
			if (e.runId !== runId || (e.event.agentIndex ?? 0) !== ai || e.event.type !== "file-changed") continue;
			const p = String(e.event.path ?? "");
			if (!p) continue;
			outMap.set(p, { path: p, added: Number(e.event.added ?? 0), removed: Number(e.event.removed ?? 0), kind: String(e.event.kind ?? "modified"), diff: String(e.event.diff ?? "") });
		}
		const outputs = [...outMap.values()].filter((o) => o.added + o.removed > 0);
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
				{outputs.length > 0 && (
					<details className="focus-outputs" open={outputs.length <= 6}>
						<summary>Outputs ({outputs.length})</summary>
						{outputs.map((o) => (
							<details key={o.path} className="focus-out">
								<summary className="mono">
									<span className={`changes-st st-${o.kind === "created" ? "A" : "M"}`}>{o.kind === "created" ? "A" : "M"}</span> {o.path}
									<span className="muted"> +{o.added}/−{o.removed}</span>
								</summary>
								{o.diff && <DiffBody diff={o.diff} />}
							</details>
						))}
					</details>
				)}
				{focusItems.length === 0 ? (
					<div className="muted" style={{ padding: 20 }}>No events yet for this agent.</div>
				) : (
					groupWorked(group(focusItems)).map((item) => renderItem(item, !!lateAfter))
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
			{groupWorked(group(mainItems)).map((item) => (
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
										<span className="fanout-idx">#{idx}</span> {titleOf(idx, rid)}
										<span className="muted" style={{ marginLeft: "auto" }}>{vitalsOf(idx, rid).lastAct ? `${vitalsOf(idx, rid).lastAct} · ` : ""}{litems.length} events</span>
									</summary>
									<div className="slice-lane-body">{groupWorked(group(litems)).map((item) => renderItem(item, !!lateAfter))}</div>
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
