"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, useUser } from "@/lib/api";
import type { HarnessReport, ReportTask, ReportStep, PlanVersion } from "../HarnessReport";

const fmtDur = (ms?: number) => {
	if (ms === undefined || ms === null) return "—";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const fmtClock = (at?: number) => (at ? new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const fmtTok = (n = 0) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

const STATUS_COLOR: Record<string, string> = {
	done: "#89d185", in_progress: "#e5c07b", pending: "#888", blocked: "#f48771", failed: "#f48771", stale: "#888",
};
const KIND_LABEL: Record<string, string> = { "unplanned-work": "Unplanned work", "step-replaced": "Step replaced", "task-added": "Added scope" };
const KIND_COLOR: Record<string, string> = { "unplanned-work": "#e06c75", "step-replaced": "#e5c07b", "task-added": "#61afef" };
const EVO_COLOR: Record<string, string> = { retained: "#89d185", modified: "#e5c07b", added: "#61afef", discarded: "#e06c75" };

const chip = (label: string, color?: string) => (
	<span key={label} style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 8, border: `1px solid ${color ?? "#444"}`, color: color ?? "#aaa" }}>{label}</span>
);

function CorrGraph({ title, runs, turns, executions, plans }: {
	title: string;
	runs?: { callId: string; at: number; tool: string; target: string; ok: boolean; durationMs?: number; role?: string; seq?: number }[];
	turns?: { turn: number; seq: number; toolCalls: { callId: string; name: string }[] }[];
	executions?: { callId: string; ok: boolean; durationMs?: number; exitCode?: number }[];
	plans?: { id: string; status: string; taskCount: number; stepCount: number }[];
}) {
	const rows = (runs ?? []).slice(0, 12);
	const rowH = 52;
	const height = Math.max(150, rows.length * rowH + 96);
	const CX = { turn: 4, call: 110, exec: 216, step: 322 };
	const W = { turn: 98, call: 98, exec: 98, step: 92 };
	const stepY = Math.max(60, (rows.length * rowH) / 2 + 20);
	const activePlan = (plans ?? []).find((p) => p.status === "active") ?? (plans ?? [])[(plans ?? []).length - 1];
	const turnOf = (callId: string) => (turns ?? []).find((t) => t.toolCalls.some((c) => c.callId === callId));
	const execOf = (callId: string) => (executions ?? []).find((x) => x.callId === callId);
	const node = (x: number, y: number, w: number, color: string, fill: string, line1: string, line2: string, key: string) => (
		<g key={key}>
			<rect x={x} y={y} width={w} height={34} rx={5} fill={fill} stroke={`${color}66`} />
			<text x={x + 7} y={y + 14} fill={color} fontSize={8.5} fontFamily="monospace">{line1}</text>
			<text x={x + 7} y={y + 26} fill="#ccc" fontSize={8.5}>{line2}</text>
		</g>
	);
	return (
		<svg width="100%" height={height} viewBox={`0 0 420 ${height}`} style={{ display: "block" }}>
			{rows.map((r, i) => {
				const y = 24 + i * rowH + 17;
				const color = r.ok === false ? "#f4877155" : "#569cd644";
				return (
					<g key={`e${i}`}>
						<line x1={CX.turn + W.turn} y1={y} x2={CX.call} y2={y} stroke={color} strokeWidth={1.4} />
						<line x1={CX.call + W.call} y1={y} x2={CX.exec} y2={y} stroke={color} strokeWidth={1.4} />
						<line x1={CX.exec + W.exec} y1={y} x2={CX.step} y2={stepY} stroke={color} strokeWidth={1.4} />
					</g>
				);
			})}
			{rows.map((r, i) => {
				const y = 24 + i * rowH;
				const turn = turnOf(r.callId);
				const ex = execOf(r.callId);
				const fail = r.ok === false;
				const color = fail ? "#f48771" : r.role === "close" ? "#e5c07b" : "#89d185";
				const exLine2 = ex ? `${ex.ok ? "ok" : "fail"}${ex.durationMs !== undefined ? ` · ${(ex.durationMs / 1000).toFixed(1)}s` : ""}${ex.exitCode !== undefined ? ` · exit ${ex.exitCode}` : ""}` : fail ? "refused" : "ok";
				return (
					<g key={`n${i}`}>
						{node(CX.turn, y, W.turn, "#9cdcfe", "rgba(156,220,254,0.07)", turn ? `Turn ${turn.turn}` : "turn ?", turn ? `seq ${turn.seq}` : `seq ${r.seq ?? ""}`, `t${i}`)}
						{node(CX.call, y, W.call, "#61afef", "rgba(97,175,239,0.08)", r.tool, String(r.target ?? "").slice(-14) || r.callId.slice(0, 10), `c${i}`)}
						{node(CX.exec, y, W.exec, color, fail ? "rgba(244,135,113,0.10)" : "rgba(137,209,133,0.07)", "execution", exLine2, `x${i}`)}
					</g>
				);
			})}
			<rect x={CX.step} y={stepY - 20} width={W.step} height={40} rx={6} fill="rgba(197,134,192,0.12)" stroke="#c586c0" />
			<text x={CX.step + W.step / 2} y={stepY - 4} fill="#c586c0" fontSize={10} textAnchor="middle" fontWeight="bold">{title.split(" ")[0]}</text>
			<text x={CX.step + W.step / 2} y={stepY + 10} fill="#888" fontSize={8} textAnchor="middle">{rows.length} run{rows.length === 1 ? "" : "s"}</text>
			{activePlan && (
				<g>
					<line x1={CX.step + W.step / 2} y1={stepY + 20} x2={CX.step + W.step / 2} y2={height - 40} stroke="#c586c055" strokeWidth={1.4} strokeDasharray="3,3" />
					<rect x={CX.step} y={height - 40} width={W.step} height={28} rx={5} fill="rgba(78,201,176,0.08)" stroke="#4ec9b066" />
					<text x={CX.step + W.step / 2} y={height - 28} fill="#4ec9b0" fontSize={8.5} textAnchor="middle">Plan {activePlan.id.replace("p", "v")}</text>
					<text x={CX.step + W.step / 2} y={height - 18} fill="#888" fontSize={7.5} textAnchor="middle">{activePlan.taskCount}t · {activePlan.stepCount}s</text>
				</g>
			)}
			{rows.length === 0 && <text x={16} y={40} fill="#888" fontSize={10}>No correlated tool runs recorded for this step.</text>}
			<text x={8} y={height - 6} fill="#666" fontSize={8}>turn → tool call → execution → step{activePlan ? "   (dashed: plan membership)" : ""}</text>
		</svg>
	);
}

function InfoPanel({ title, meta, actions, runs, startedAt, endedAt, durationMs, onClose, onOpenExec, turns, executions, plans }: {
	title: string; meta?: string; actions?: { at: number; actor: string; label: string; detail?: string }[];
	runs?: { callId: string; at: number; tool: string; target: string; ok: boolean; durationMs?: number; role?: string; error?: string; input?: string; output?: string; seq?: number }[];
	startedAt?: number; endedAt?: number; durationMs?: number; onClose: () => void;
	onOpenExec?: (callId: string) => void;
	turns?: { turn: number; seq: number; toolCalls: { callId: string; name: string }[] }[];
	executions?: { callId: string; ok: boolean; durationMs?: number; exitCode?: number }[];
	plans?: { id: string; status: string; taskCount: number; stepCount: number }[];
}) {
	const ROLE_LABEL: Record<string, [string, string]> = { evidence: ["proof", "#89d185"], close: ["close attempt", "#e5c07b"], task: ["task", "#888"] };
	const ACTOR_COLOR: Record<string, string> = { model: "#61afef", harness: "#c586c0", verifier: "#89d185" };
	const [tab, setTab] = useState("overview");
	const runList = runs ?? [];
	const proofRuns = runList.filter((r) => r.role === "evidence");
	const closeRuns = runList.filter((r) => r.role === "close");

	const runRow = (r: NonNullable<typeof runs>[number], i: number) => (
		<div key={i} onClick={onOpenExec && r.role !== "close" ? () => onOpenExec(r.callId) : undefined} style={{ display: "flex", gap: 6, alignItems: "baseline", padding: "2px 0", fontSize: 11, flexWrap: "wrap", cursor: onOpenExec && r.role !== "close" ? "pointer" : undefined }}>
			{r.role && <span style={{ fontSize: 8, fontWeight: 700, textTransform: "uppercase", border: `1px solid ${(ROLE_LABEL[r.role] ?? [])[1] ?? "#888"}`, color: (ROLE_LABEL[r.role] ?? [])[1] ?? "#888", borderRadius: 6, padding: "0 4px" }}>{(ROLE_LABEL[r.role] ?? [])[0] ?? r.role}</span>}
			<span style={{ fontFamily: "monospace", fontSize: 10, color: r.ok ? "#61afef" : "#e06c75" }}>{r.tool}</span>
			<span style={{ flex: 1, minWidth: 100, fontFamily: "monospace", fontSize: 10, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.target}</span>
			<span style={{ fontSize: 9, opacity: 0.5 }}>{fmtClock(r.at)}{r.durationMs !== undefined ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ""}</span>
			<span title={`${r.callId} — click to copy`} onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(r.callId); }} style={{ fontFamily: "monospace", fontSize: 8, opacity: 0.4, cursor: "copy" }}>{r.callId.slice(0, 8)}</span>
			{r.error && <div style={{ width: "100%", fontSize: 10, color: "#e06c75", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{r.error}</div>}
			{(r.input !== undefined || r.output !== undefined) && (
				<details style={{ width: "100%", marginTop: 2 }}>
					<summary style={{ fontSize: 9, opacity: 0.5, cursor: "pointer", userSelect: "none" }}>input / output</summary>
					{r.input !== undefined && (
						<div>
							<div style={{ fontSize: 8, fontWeight: 700, textTransform: "uppercase", opacity: 0.5, marginTop: 4 }}>input</div>
							<pre style={{ fontSize: 10, fontFamily: "monospace", background: "rgba(0,0,0,0.25)", border: "1px solid #333", borderRadius: 4, padding: "5px 7px", margin: "2px 0 4px", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 180, overflowY: "auto", userSelect: "text" }}>{r.input}</pre>
						</div>
					)}
					{r.output !== undefined && (
						<div>
							<div style={{ fontSize: 8, fontWeight: 700, textTransform: "uppercase", opacity: 0.5, marginTop: 4 }}>output</div>
							<pre style={{ fontSize: 10, fontFamily: "monospace", background: "rgba(0,0,0,0.25)", border: "1px solid #333", borderRadius: 4, padding: "5px 7px", margin: "2px 0 4px", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 180, overflowY: "auto", userSelect: "text" }}>{r.output || "(empty)"}</pre>
						</div>
					)}
				</details>
			)}
		</div>
	);

	const sectionHead = (text: string) => (
		<div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", opacity: 0.55, margin: "12px 0 5px", letterSpacing: "0.06em" }}>{text}</div>
	);

	const tabs: [string, string][] = [["overview", "Overview"]];
	if (runList.length) tabs.push(["execution", `Execution (${runList.length})`]);
	if (proofRuns.length || closeRuns.length) tabs.push(["evidence", "Evidence"]);
	tabs.push(["links", "Links"]);

	const tabBtn = (id: string, label: string) => (
		<button key={id} onClick={() => setTab(id)} style={{ background: "none", border: "none", borderBottom: tab === id ? "2px solid #569cd6" : "2px solid transparent", color: tab === id ? "#9cdcfe" : "#ccc", opacity: tab === id ? 1 : 0.6, fontSize: 11, padding: "6px 10px", cursor: "pointer" }}>{label}</button>
	);

	return (
		<div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 460, maxWidth: "92vw", zIndex: 50, background: "#1f1f1f", borderLeft: "1px solid #333", boxShadow: "-8px 0 24px rgba(0,0,0,0.45)", display: "flex", flexDirection: "column" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "12px 14px 8px", borderBottom: "1px solid #333", flexShrink: 0 }}>
				<div>
					<div style={{ fontWeight: 700 }}>{title}</div>
					{meta && <div style={{ fontSize: 11, opacity: 0.65, fontFamily: "monospace" }}>{meta}</div>}
				</div>
				<button onClick={onClose} style={{ background: "none", border: "none", color: "#888", fontSize: 14, cursor: "pointer", padding: "2px 6px" }} title="close">✕</button>
			</div>
			<div style={{ display: "flex", gap: 2, padding: "0 10px", borderBottom: "1px solid #333", flexShrink: 0 }}>
				{tabs.map(([id, label]) => tabBtn(id, label))}
			</div>
			<div style={{ flex: 1, overflowY: "auto", padding: "10px 14px" }}>
				{tab === "overview" && (
					<div>
						{sectionHead("Lifecycle")}
						<div style={{ display: "flex", gap: 12, fontSize: 11, opacity: 0.85, flexWrap: "wrap" }}>
							<span>started <b>{fmtClock(startedAt)}</b></span>
							<span>ended <b>{fmtClock(endedAt)}</b></span>
							<span>duration <b>{fmtDur(durationMs)}</b></span>
						</div>
						{sectionHead("Actor actions")}
						{(actions ?? []).length === 0 && <div className="muted" style={{ fontSize: 11 }}>No recorded actions.</div>}
						{(actions ?? []).map((a, i) => (
							<div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0", fontSize: 12, flexWrap: "wrap" }}>
								<span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", padding: "0 5px", borderRadius: 7, background: `${ACTOR_COLOR[a.actor] ?? "#888"}33`, color: ACTOR_COLOR[a.actor] ?? "#888" }}>{a.actor}</span>
								<span style={{ flex: 1, minWidth: 150 }}>{a.label}</span>
								<span style={{ fontSize: 10, opacity: 0.5 }}>{fmtClock(a.at)}</span>
								{a.detail && <div style={{ width: "100%", fontSize: 10, opacity: 0.6, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{a.detail}</div>}
							</div>
						))}
					</div>
				)}
				{tab === "execution" && <div>{runList.map(runRow)}</div>}
				{tab === "evidence" && (
					<div>
						{proofRuns.length > 0 && <div>{sectionHead(`Proof — counted toward closing (${proofRuns.length})`)}{proofRuns.map(runRow)}</div>}
						{closeRuns.length > 0 && <div>{sectionHead(`Close attempts (${closeRuns.length})`)}{closeRuns.map(runRow)}</div>}
					</div>
				)}
				{tab === "links" && <CorrGraph title={title} runs={runs} turns={turns} executions={executions} plans={plans} />}
			</div>
		</div>
	);
}

function Modal({ title, children, onClose, width = 560 }: { title: string; children: React.ReactNode; onClose: () => void; width?: number }) {
	return (
		<div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 50 }} onClick={onClose}>
			<div style={{ position: "absolute", top: "12%", left: "50%", transform: "translateX(-50%)", width, maxWidth: "94vw", maxHeight: "72vh", overflowY: "auto", background: "#252526", border: "1px solid #007fd4", borderRadius: 8, padding: 16 }} onClick={(e) => e.stopPropagation()}>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
					<div style={{ fontWeight: 700 }}>{title}</div>
					<button onClick={onClose} style={{ background: "none", border: "none", color: "#888", fontSize: 14, cursor: "pointer" }} title="close">✕</button>
				</div>
				{children}
			</div>
		</div>
	);
}

const detailTabBtn = (active: boolean): React.CSSProperties => ({
	background: "none",
	border: "none",
	borderBottom: active ? "2px solid #569cd6" : "2px solid transparent",
	color: active ? "#9cdcfe" : "#ccc",
	opacity: active ? 1 : 0.6,
	fontSize: 11,
	padding: "6px 10px",
	cursor: "pointer",
});

const preStyle: React.CSSProperties = {
	fontSize: 11,
	fontFamily: "monospace",
	background: "rgba(0,0,0,0.25)",
	border: "1px solid #333",
	borderRadius: 4,
	padding: "7px 9px",
	whiteSpace: "pre-wrap",
	wordBreak: "break-all",
	maxHeight: 300,
	overflowY: "auto",
	userSelect: "text",
};

function TurnDetail({ turn, executions, onClose, onOpenExec }: {
	turn: NonNullable<HarnessReport["turns"]>[number];
	executions: NonNullable<HarnessReport["executions"]>;
	onClose: () => void;
	onOpenExec: (callId: string) => void;
}) {
	const [tab, setTab] = useState("response");
	const kv = (k: string, v?: string | number) => v !== undefined ? <span style={{ marginRight: 14 }}>{k} <b style={{ fontFamily: "monospace", fontSize: 10 }}>{v}</b></span> : null;
	return (
		<Modal title={`Model Response — Turn ${turn.turn} (Seq ${turn.seq})`} onClose={onClose} width={680}>
			<div style={{ fontSize: 11, opacity: 0.8, marginBottom: 10 }}>
				{kv("provider", turn.providerId)}{kv("model", turn.modelId)}{kv("message id", turn.messageId)}{kv("reasoning id", turn.reasoningId)}{kv("time", fmtClock(turn.at))}
			</div>
			<div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
				{[["response", "Response"], ["reasoning", "Reasoning"], ["calls", `Tool Calls (${turn.toolCalls.length})`], ["usage", "Usage"]].map(([k, l]) => (
					<button key={k} style={detailTabBtn(tab === k)} onClick={() => setTab(k)}>{l}</button>
				))}
			</div>
			{tab === "response" && (turn.text ? <pre style={preStyle}>{turn.text}</pre> : <div className="muted" style={{ fontSize: 11 }}>No visible reply — tool-calling turn.</div>)}
			{tab === "reasoning" && (turn.reasoning ? <pre style={{ ...preStyle, color: "#c586c0" }}>{turn.reasoning}</pre> : <div className="muted" style={{ fontSize: 11 }}>No reasoning recorded for this turn.</div>)}
			{tab === "calls" && (
				<div>
					{turn.toolCalls.length === 0 && <div className="muted" style={{ fontSize: 11 }}>No tool calls.</div>}
					{turn.toolCalls.map((c) => {
						const ex = executions.find((x) => x.callId === c.callId);
						return (
							<div key={c.callId} onClick={() => ex && onOpenExec(c.callId)} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 6px", fontSize: 11, borderBottom: "1px solid #2a2a2a", cursor: ex ? "pointer" : undefined }}>
								<span style={{ fontFamily: "monospace", color: ex ? (ex.ok ? "#61afef" : "#e06c75") : "#888" }}>{c.name}</span>
								<span style={{ flex: 1, fontFamily: "monospace", fontSize: 10, opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.target}</span>
								{ex && <span style={{ fontSize: 9, opacity: 0.6 }}>{(ex.durationMs / 1000).toFixed(1)}s · {ex.ok ? "ok" : "failed"}</span>}
								<span title={`${c.callId} — click to copy`} onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(c.callId); }} style={{ fontFamily: "monospace", fontSize: 8, opacity: 0.4, cursor: "copy" }}>{c.callId.slice(0, 8)}</span>
							</div>
						);
					})}
				</div>
			)}
			{tab === "usage" && turn.usage && (
				<div style={{ fontSize: 12 }}>
					<div>input tokens: <b>{turn.usage.input.toLocaleString()}</b></div>
					<div>output tokens: <b>{turn.usage.output.toLocaleString()}</b></div>
					<div>cached: <b>{turn.usage.cached.toLocaleString()}</b></div>
				</div>
			)}
		</Modal>
	);
}

function ExecDetail({ ex, onClose }: { ex: NonNullable<HarnessReport["executions"]>[number]; onClose: () => void }) {
	const [tab, setTab] = useState("overview");
	const kv = (k: string, v: string | number | undefined) => (
		<div key={k} style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 12 }}>
			<span style={{ width: 110, opacity: 0.6, fontSize: 11 }}>{k}</span><span style={{ fontFamily: "monospace", fontSize: 11, wordBreak: "break-all" }}>{v ?? "—"}</span>
		</div>
	);
	return (
		<Modal title={`${ex.tool} — exec_${ex.callId.slice(5, 11)}`} onClose={onClose} width={680}>
			<div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
				{[["overview", "Overview"], ["input", "Input"], ["output", "Output"]].map(([k, l]) => (
					<button key={k} style={detailTabBtn(tab === k)} onClick={() => setTab(k)}>{l}</button>
				))}
				<span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: ex.ok ? "#89d185" : "#e06c75" }}>{ex.ok ? "succeeded" : "failed"}</span>
			</div>
			{tab === "overview" && (
				<div>
					{kv("tool", ex.tool)}
					{kv("target", ex.target)}
					{kv("cwd", ex.cwd)}
					{kv("exit code", ex.exitCode !== undefined ? String(ex.exitCode) : undefined)}
					{kv("duration", `${(ex.durationMs / 1000).toFixed(1)}s`)}
					{kv("started", fmtClock(ex.startedAt))}
					{kv("completed", fmtClock(ex.endedAt))}
					{kv("seq", String(ex.seq))}
					{kv("callId", ex.callId)}
				</div>
			)}
			{tab === "input" && <pre style={preStyle}>{ex.input}</pre>}
			{tab === "output" && <pre style={preStyle}>{ex.output || "(empty)"}</pre>}
		</Modal>
	);
}

export default function HarnessDashboardPage() {
	const user = useUser();
	const loading = user === undefined;
	const params = useParams();
	const id = String(params.id);
	const [report, setReport] = useState<HarnessReport | null>(null);
	const [missing, setMissing] = useState(false);
	const [tab, setTab] = useState("plan");
	const [info, setInfo] = useState<null | { title: string; meta?: string; actions?: { at: number; actor: string; label: string; detail?: string }[]; runs?: { callId: string; at: number; tool: string; target: string; ok: boolean; durationMs?: number; role?: string; error?: string; input?: string; output?: string }[]; startedAt?: number; endedAt?: number; durationMs?: number }>(null);
	const [divSel, setDivSel] = useState<string | null>(null);
	const [traceFilter, setTraceFilter] = useState("all");
	const [traceSearch, setTraceSearch] = useState("");
	const [turnSel, setTurnSel] = useState<number | null>(null);
	const [execSel, setExecSel] = useState<string | null>(null);
	const [rawFilter, setRawFilter] = useState("all");
	const [rawSearch, setRawSearch] = useState("");
	const [taskSearch, setTaskSearch] = useState("");

	useEffect(() => {
		if (!user) return;
		void (async () => {
			const res = await apiFetch(`/api/runs/${id}`, user);
			if (!res.ok) return setMissing(true);
			const body = (await res.json()) as { harnessReport?: HarnessReport | null };
			if (!body.harnessReport) return setMissing(true);
			setReport(body.harnessReport);
		})();
	}, [user, id]);

	if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
	if (missing) return <div style={{ padding: 24 }}><Link href={`/runs/${id}`}>← run</Link><div className="muted" style={{ marginTop: 12 }}>No harness report for this run — older runs predate the report upload, or the run used the cloud engine.</div></div>;
	if (!report) return <div style={{ padding: 24 }}>Loading report…</div>;

	const s = report.summary;
	const plans = report.plans ?? [];
	const divergences = report.divergence ?? [];
	const tabs: [string, string][] = [
		["plan", "Plan & Tasks"],
		["timeline", "Execution Timeline"],
		["divergence", `Divergences (${s?.divergences?.total ?? 0})`],
		["comparison", "Plan Comparison"],
		["artifacts", "Artifacts"],
		["context", "Context & Execution"],
		["raw", "Run Data"],
	];

	const ACCENT: Record<string, string> = { teal: "#4ec9b0", green: "#89d185", purple: "#c586c0", blue: "#569cd6", amber: "#e5c07b", slate: "#9cdcfe" };
	const tile = (num: string | number, lbl: string, sub?: string, accent?: keyof typeof ACCENT) => (
		<div key={lbl} className="card" style={{ padding: "10px 12px", flex: 1, minWidth: 110, borderLeft: accent ? `2px solid ${ACCENT[accent]}` : undefined }}>
			<div style={{ fontSize: 18, fontWeight: 700, color: accent ? ACCENT[accent] : undefined }}>{num}</div>
			<div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.65 }}>{lbl}</div>
			{sub && <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3 }}>{sub}</div>}
		</div>
	);

	const stepRow = (t: ReportTask, st: ReportStep) => (
		<div key={st.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0", fontSize: 12 }}>
			<span style={{ color: STATUS_COLOR[st.status] ?? "#888", width: 14, textAlign: "center" }}>{st.status === "done" ? "✓" : st.status === "in_progress" ? "◐" : st.status === "pending" ? "○" : "✕"}</span>
			<span style={{ flex: 1 }}>
				{st.text}
				{st.signal && <span style={{ fontSize: 9, color: "#569cd6", border: "1px solid #569cd655", borderRadius: 8, padding: "0 5px", marginLeft: 6 }}>on {st.signal.tool}</span>}
				{st.replacedFrom && <span title={`was: ${st.replacedFrom.text}`} style={{ fontSize: 9, fontWeight: 700, color: "#e5c07b", border: "1px solid #e5c07b", borderRadius: 8, padding: "0 5px", marginLeft: 6, cursor: "help" }}>replaced</span>}
				{st.closedBy && st.closedBy !== "manual" && <span style={{ fontSize: 9, color: "#c586c0", border: "1px solid #c586c0", borderRadius: 8, padding: "0 5px", marginLeft: 6 }}>{st.closedBy}</span>}
			</span>
			<span style={{ fontSize: 10, opacity: 0.55 }}>{st.toolRuns ? `${st.toolRuns} runs` : ""}</span>
			<span style={{ fontSize: 10, opacity: 0.55, width: 52, textAlign: "right" }}>{fmtDur(st.durationMs)}</span>
			<button style={{ background: "none", border: "none", opacity: 0.4, cursor: "pointer", fontSize: 11 }} title="lifecycle & actions"
				onClick={() => setInfo({ title: `${t.id}/${st.id}`, meta: st.text, actions: st.actions, runs: st.runs, startedAt: st.startedAt, endedAt: st.endedAt, durationMs: st.durationMs })}>ⓘ</button>
		</div>
	);

	const planTab = (
		<div>
			<h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.7, margin: "16px 0 8px" }}>Plan Evolution & Divergence</h3>
			<div style={{ display: "flex", gap: 6, alignItems: "stretch", overflowX: "auto", paddingBottom: 4 }}>
				{plans.map((p: PlanVersion, i: number) => (
					<div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
						{i > 0 && <span style={{ opacity: 0.5 }}>→</span>}
						<div className="card" style={{ padding: "8px 12px", minWidth: 130, borderColor: p.status === "active" ? "#89d185" : undefined, opacity: p.status === "active" ? 1 : 0.75 }}>
							<div style={{ fontWeight: 700, fontSize: 12 }}>{plans.length === 1 ? "Plan (Final)" : `Plan ${p.id.replace("p", "v")}${p.status === "active" ? " (Final)" : ""}`}</div>
							<div style={{ fontSize: 10, opacity: 0.55 }}>{fmtClock(p.createdAt)}</div>
							<div style={{ fontSize: 10, opacity: 0.7, margin: "4px 0", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</div>
							<div style={{ fontSize: 10 }}>{p.taskCount} tasks · {p.stepCount} steps</div>
							<div style={{ fontSize: 9, textTransform: "uppercase", opacity: 0.6, marginTop: 3, color: p.status === "active" ? "#89d185" : undefined }}>{p.status}</div>
						</div>
					</div>
				))}
			</div>
			{(report.evolution?.transitions.length ?? 0) > 0 && (() => {
				const last = report.evolution!.transitions[report.evolution!.transitions.length - 1];
				return (
					<div style={{ display: "flex", gap: 6, marginTop: 10, fontSize: 11, alignItems: "center", flexWrap: "wrap" }}>
						<b>Evolution summary</b>
						{chip(`retained ${last.retained}`, EVO_COLOR.retained)}
						{chip(`modified ${last.modified}`, EVO_COLOR.modified)}
						{chip(`added ${last.added}`, EVO_COLOR.added)}
						{chip(`discarded ${last.discarded}`, EVO_COLOR.discarded)}
						{chip(`divergences ${s?.divergences?.total ?? 0}`)}
					</div>
				);
			})()}
			<div style={{ display: "flex", alignItems: "center", margin: "16px 0 8px" }}>
				<h3 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.7, margin: 0 }}>Tasks & Steps</h3>
				<input value={taskSearch} onChange={(e) => setTaskSearch(e.target.value)} placeholder="Search tasks, steps…" style={{ marginLeft: "auto", fontSize: 11, background: "rgba(0,0,0,0.25)", border: "1px solid #444", borderRadius: 5, color: "inherit", padding: "3px 8px", width: 180 }} />
			</div>
			{report.board.tasks.filter((t) => t.origin !== "divergence").filter((t) => {
				if (!taskSearch) return true;
				const q = taskSearch.toLowerCase();
				return t.title.toLowerCase().includes(q) || t.id.includes(q) || t.steps.some((st) => st.text.toLowerCase().includes(q));
			}).map((t) => (
				<div key={t.id} className="card" style={{ padding: 12, marginBottom: 8, opacity: t.status === "stale" ? 0.6 : 1 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
						<span style={{ fontWeight: 600, flex: 1, minWidth: 200 }}>{t.id} · {t.title}</span>
						{t.evolutionClass && chip(t.evolutionClass, EVO_COLOR[t.evolutionClass])}
						<span style={{ fontSize: 10, opacity: 0.6 }}>{fmtDur(t.durationMs)}</span>
						<span style={{ fontSize: 10, fontWeight: 600, color: STATUS_COLOR[t.status] ?? "#888", border: `1px solid ${STATUS_COLOR[t.status] ?? "#888"}`, borderRadius: 8, padding: "1px 7px" }}>{t.status}</span>
						<button style={{ background: "none", border: "none", opacity: 0.4, cursor: "pointer", fontSize: 11 }} title="lifecycle & actions"
							onClick={() => setInfo({ title: `${t.id} · ${t.title}`, meta: t.acceptance?.kind === "command" ? `acceptance: ${t.acceptance.command}` : `acceptance: ${t.acceptance?.kind}`, actions: t.actions, startedAt: t.startedAt, endedAt: t.endedAt, durationMs: t.durationMs })}>ⓘ</button>
					</div>
					<div style={{ fontSize: 10, opacity: 0.6, margin: "4px 0 6px", fontFamily: "monospace" }}>acceptance: {t.acceptance?.kind === "command" ? t.acceptance.command : t.acceptance?.kind}</div>
					{t.steps.map((st) => stepRow(t, st))}
					{t.dependsOn.length > 0 && <div style={{ fontSize: 10, opacity: 0.5, marginTop: 6 }}>depends on {t.dependsOn.join(", ")}</div>}
				</div>
			))}
		</div>
	);

	const TRACE_KINDS: [string, string][] = [["all", "All"], ["turn", "Turns"], ["tool", "Tools"], ["step", "Steps"], ["lifecycle", "Lifecycle"], ["intervention", "Interventions"], ["user", "User"], ["run", "Run"]];
	const filteredTrace = (report.timeline ?? []).filter((row) => {
		if (traceFilter !== "all" && row.kind !== traceFilter) return false;
		if (traceSearch) {
			const q = traceSearch.toLowerCase();
			if (!(row.label.toLowerCase().includes(q) || (row.detail ?? "").toLowerCase().includes(q))) return false;
		}
		return true;
	});
	const timelineTab = (
		<div>
			<div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
				{TRACE_KINDS.map(([k, label]) => (
					<button key={k} onClick={() => setTraceFilter(k)} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 8, border: `1px solid ${traceFilter === k ? "#007fd4" : "#444"}`, background: traceFilter === k ? "rgba(0,127,212,0.15)" : "none", color: "inherit", cursor: "pointer", opacity: traceFilter === k ? 1 : 0.7 }}>{label}</button>
				))}
				<input value={traceSearch} onChange={(e) => setTraceSearch(e.target.value)} placeholder="Search events…" style={{ marginLeft: "auto", fontSize: 11, background: "rgba(0,0,0,0.25)", border: "1px solid #444", borderRadius: 5, color: "inherit", padding: "3px 8px", width: 180 }} />
			</div>
			<div className="muted" style={{ fontSize: 10, marginBottom: 6 }}>{filteredTrace.length} of {(report.timeline ?? []).length} events</div>
			{filteredTrace.map((row, i) => {
				const KIND_BORDER: Record<string, string> = { turn: "#61afef", step: "#89d185", user: "#e5c07b", verifier: "#89d185", run: "#ccc" };
				const pre: React.CSSProperties = { fontSize: 10, fontFamily: "monospace", background: "rgba(0,0,0,0.25)", border: "1px solid #333", borderRadius: 4, padding: "5px 7px", margin: "2px 0 4px", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 180, overflowY: "auto", userSelect: "text" };
				const clickable = (row.kind === "turn" && (report.turns ?? []).some((t) => t.seq === row.seq)) || (row.kind === "tool" && row.callId);
				const openDetail = () => {
					if (row.kind === "turn") {
						const t = (report.turns ?? []).find((x) => x.seq === row.seq);
						if (t) setTurnSel(t.turn);
					} else if (row.kind === "tool" && row.callId) setExecSel(row.callId);
				};
				return (
					<div key={i} onClick={clickable ? openDetail : undefined} style={{ padding: "4px 6px", fontSize: 12, cursor: clickable ? "pointer" : undefined, borderLeft: `2px solid ${KIND_BORDER[row.kind] ?? "transparent"}`, background: row.ok === false ? "rgba(224,108,117,0.08)" : i % 2 ? "transparent" : "rgba(255,255,255,0.02)", borderRadius: 4 }}>
						<div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
							<span style={{ fontSize: 10, opacity: 0.5, width: 75, flexShrink: 0 }}>{fmtClock(row.at)}</span>
							<span style={{ fontSize: 8, opacity: 0.35, fontFamily: "monospace", width: 30, textAlign: "right", flexShrink: 0 }}>{row.seq}</span>
							<span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", opacity: 0.7, width: 80, flexShrink: 0 }}>{row.kind}</span>
							<span style={{ flexShrink: 0 }}>{row.label}</span>
							{row.detail && <span style={{ fontSize: 10, opacity: 0.55, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.detail.slice(0, 90)}</span>}
							{row.callId && <span title={`${row.callId} — click to copy`} onClick={() => void navigator.clipboard?.writeText(row.callId!)} style={{ fontFamily: "monospace", fontSize: 8, opacity: 0.4, cursor: "copy" }}>{row.callId.slice(0, 8)}</span>}
						</div>
						{row.reasoning && (
							<details style={{ marginLeft: 130 }}>
								<summary style={{ fontSize: 9, opacity: 0.5, cursor: "pointer", userSelect: "none" }}>reasoning</summary>
								<pre style={{ ...pre, color: "#c586c0" }}>{row.reasoning}</pre>
							</details>
						)}
						{row.text && (
							<details style={{ marginLeft: 130 }}>
								<summary style={{ fontSize: 9, opacity: 0.5, cursor: "pointer", userSelect: "none" }}>reply text</summary>
								<pre style={pre}>{row.text}</pre>
							</details>
						)}
						{(row.input !== undefined || row.output !== undefined) && (
							<details style={{ marginLeft: 130 }}>
								<summary style={{ fontSize: 9, opacity: 0.5, cursor: "pointer", userSelect: "none" }}>input / output</summary>
								{row.input !== undefined && <div><div style={{ fontSize: 8, fontWeight: 700, textTransform: "uppercase", opacity: 0.5, marginTop: 4 }}>input</div><pre style={pre}>{row.input}</pre></div>}
								{row.output !== undefined && <div><div style={{ fontSize: 8, fontWeight: 700, textTransform: "uppercase", opacity: 0.5, marginTop: 4 }}>output</div><pre style={pre}>{row.output || "(empty)"}</pre></div>}
							</details>
						)}
					</div>
				);
			})}
			{(report.timelineOmitted ?? 0) > 0 && <div className="muted" style={{ fontSize: 10, padding: 6 }}>…{report.timelineOmitted} later rows omitted.</div>}
		</div>
	);

	const selDiv = divergences.find((d) => d.id === divSel) ?? divergences[divergences.length - 1];
	const divergenceTab = divergences.length === 0 ? (
		<div className="card muted" style={{ padding: 12 }}>No divergences — the model stayed on the original plan.</div>
	) : (
		<div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 320px) 1fr", gap: 12 }}>
			<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
				{divergences.map((d) => (
					<div key={d.id} onClick={() => setDivSel(d.id)} className="card" style={{ padding: "6px 8px", cursor: "pointer", fontSize: 12, display: "flex", gap: 8, alignItems: "center", borderColor: selDiv?.id === d.id ? "#007fd4" : undefined }}>
						<span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: `${KIND_COLOR[d.kind] ?? "#888"}26`, color: KIND_COLOR[d.kind] ?? "#888", whiteSpace: "nowrap" }}>{KIND_LABEL[d.kind] ?? d.kind}</span>
						<span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title.slice(0, 60)}</span>
						<span style={{ fontSize: 9, opacity: 0.5 }}>{fmtClock(d.startedAt)}</span>
					</div>
				))}
			</div>
			{selDiv && (
				<div className="card" style={{ padding: 12 }}>
					<div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
						<span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: `${KIND_COLOR[selDiv.kind] ?? "#888"}26`, color: KIND_COLOR[selDiv.kind] ?? "#888" }}>{KIND_LABEL[selDiv.kind] ?? selDiv.kind}</span>
						<span style={{ fontSize: 10, fontWeight: 600, color: STATUS_COLOR[selDiv.status] ?? "#888" }}>{selDiv.status}</span>
					</div>
					<div style={{ fontWeight: 600, marginBottom: 8 }}>{selDiv.title}</div>
					{selDiv.replacement && (
						<div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
							<div style={{ flex: 1, border: "1px solid rgba(224,108,117,0.4)", background: "rgba(224,108,117,0.05)", borderRadius: 5, padding: "6px 8px", fontSize: 12 }}>
								<div style={{ fontSize: 9, textTransform: "uppercase", opacity: 0.55 }}>before</div>
								{selDiv.replacement.wasText}
								{selDiv.replacement.wasSignal && <div style={{ fontSize: 10, opacity: 0.6, fontFamily: "monospace", marginTop: 3 }}>{selDiv.replacement.wasSignal}</div>}
							</div>
							<span style={{ opacity: 0.5 }}>→</span>
							<div style={{ flex: 1, border: "1px solid rgba(137,209,133,0.4)", background: "rgba(137,209,133,0.05)", borderRadius: 5, padding: "6px 8px", fontSize: 12 }}>
								<div style={{ fontSize: 9, textTransform: "uppercase", opacity: 0.55 }}>after</div>
								{selDiv.replacement.newText}
								{selDiv.replacement.newSignal && <div style={{ fontSize: 10, opacity: 0.6, fontFamily: "monospace", marginTop: 3 }}>{selDiv.replacement.newSignal}</div>}
							</div>
						</div>
					)}
					{selDiv.cause && (
						<div title={selDiv.causeDetail} style={{ display: "inline-block", fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 8, marginBottom: 8, cursor: "help", background: selDiv.cause === "harness" ? "rgba(197,134,192,0.2)" : "rgba(224,108,117,0.2)", color: selDiv.cause === "harness" ? "#c586c0" : "#e06c75" }}>
							{selDiv.cause === "harness" ? "harness-triggered" : "model-initiated"}
						</div>
					)}
					{selDiv.calls.length > 0 && (
						<div style={{ display: "flex", gap: 4, flexWrap: "wrap", margin: "4px 0 8px" }}>
							{selDiv.calls.map((c, i) => (
								<span key={i} style={{ fontSize: 10, fontFamily: "monospace", padding: "1px 6px", borderRadius: 6, border: "1px solid #444", opacity: c.ok ? 1 : 0.6, textDecoration: c.ok ? "none" : "line-through" }}>{c.name}{c.target ? ` ${c.target}` : ""}</span>
							))}
						</div>
					)}
					<div style={{ fontSize: 12 }}>
						<b>Lifecycle</b>
						{(selDiv.lifecycle ?? []).map((l, i) => (
							<div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0 2px 4px" }}>
								<span style={{ width: 5, height: 5, borderRadius: "50%", background: "#007fd4", alignSelf: "center", flexShrink: 0 }}></span>
								<span style={{ flex: 1 }}>{l.label}</span>
								<span style={{ fontSize: 9, opacity: 0.5 }}>{fmtClock(l.at)}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);

	const comparisonTab = plans.length < 2 ? (
		<div className="card muted" style={{ padding: 12 }}>Only one plan version — no replacements to compare.</div>
	) : (
		<div>
			{(report.evolution?.transitions ?? []).map((tr, i) => {
				const CLASS_COLOR: Record<string, string> = { retained: "#89d185", modified: "#e5c07b", added: "#61afef", discarded: "#e06c75" };
				return (
					<div key={i} className="card" style={{ padding: 12, marginBottom: 10 }}>
						<div style={{ fontWeight: 700, marginBottom: 6 }}>Plan {tr.from.replace("p", "v")} → Plan {tr.to.replace("p", "v")}</div>
						<div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
							{chip(`retained ${tr.retained}`, EVO_COLOR.retained)}
							{chip(`modified ${tr.modified}`, EVO_COLOR.modified)}
							{chip(`added ${tr.added}`, EVO_COLOR.added)}
							{chip(`discarded ${tr.discarded}`, EVO_COLOR.discarded)}
						</div>
						{(tr.pairs ?? []).length > 0 && (
							<div style={{ display: "grid", gridTemplateColumns: "1fr 24px 1fr", gap: "4px 8px", fontSize: 11 }}>
								<div style={{ fontSize: 9, textTransform: "uppercase", opacity: 0.5 }}>Plan {tr.from.replace("p", "v")}</div><div></div>
								<div style={{ fontSize: 9, textTransform: "uppercase", opacity: 0.5 }}>Plan {tr.to.replace("p", "v")}</div>
								{(tr.pairs ?? []).map((p, j) => (
									<div key={j} style={{ display: "contents" }}>
										<div style={{ padding: "4px 8px", borderRadius: 5, border: `1px solid ${CLASS_COLOR[p.class] ?? "#444"}44`, background: `${CLASS_COLOR[p.class] ?? "#444"}11` }}>
											<span style={{ fontSize: 9, fontWeight: 700, color: CLASS_COLOR[p.class], marginRight: 6 }}>{p.class}</span>
											{p.oldTitle}
										</div>
										<div style={{ alignSelf: "center", textAlign: "center", opacity: 0.4 }}>→</div>
										<div style={{ padding: "4px 8px", borderRadius: 5, border: `1px solid ${CLASS_COLOR[p.class] ?? "#444"}44`, background: p.newId ? `${CLASS_COLOR[p.class] ?? "#444"}11` : "transparent", opacity: p.newId ? 1 : 0.4 }}>
											{p.newTitle ?? "(not carried over)"}
										</div>
									</div>
								))}
								{(tr.addedTasks ?? []).map((t, j) => (
									<div key={`a${j}`} style={{ display: "contents" }}>
										<div></div><div></div>
										<div style={{ padding: "4px 8px", borderRadius: 5, border: "1px solid #61afef44", background: "#61afef11" }}>
											<span style={{ fontSize: 9, fontWeight: 700, color: "#61afef", marginRight: 6 }}>added</span>
											{t.title}
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				);
			})}
			{(report.evolution?.stepReplacements ?? []).length > 0 && (
				<div className="card" style={{ padding: 12 }}>
					<div style={{ fontWeight: 700, marginBottom: 6 }}>Step replacements across all versions</div>
					{(report.evolution?.stepReplacements ?? []).map((x, j) => (
						<div key={j} style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0" }}>
							<span style={{ fontSize: 10, fontFamily: "monospace", opacity: 0.7, width: 60 }}>{x.taskId}/{x.stepId}</span>
							<div style={{ flex: 1, border: "1px solid rgba(224,108,117,0.4)", borderRadius: 5, padding: "4px 8px", fontSize: 11 }}>{x.wasText}</div>
							<span style={{ opacity: 0.5 }}>→</span>
							<div style={{ flex: 1, border: "1px solid rgba(137,209,133,0.4)", borderRadius: 5, padding: "4px 8px", fontSize: 11 }}>{x.newText}</div>
						</div>
					))}
				</div>
			)}
		</div>
	);

	const artifactsTab = (report.artifacts ?? []).length === 0 ? (
		<div className="card muted" style={{ padding: 12 }}>No files written in this run.</div>
	) : (
		<table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
			<thead><tr style={{ textAlign: "left", opacity: 0.6, fontSize: 10, textTransform: "uppercase" }}><th style={{ padding: 4 }}>File</th><th>Tools</th><th>Writes</th><th>First</th><th>Last</th></tr></thead>
			<tbody>
				{(report.artifacts ?? []).map((a) => (
					<tr key={a.path} style={{ borderTop: "1px solid #333" }}>
						<td style={{ padding: "5px 4px", fontFamily: "monospace" }}>{a.path}</td>
						<td>{a.tools.join(", ")}</td>
						<td>{a.writes}</td>
						<td>{fmtClock(a.firstAt)}</td>
						<td>{fmtClock(a.lastAt)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);

	const c = report.context;
	const srcv = c.bySource;
	const contextTab = (
		<div>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
				{tile(c.turns, "model turns")}{tile(c.toolCalls, "tool calls")}{tile(c.toolFailures, "failures")}
				{tile(fmtTok(c.tokens.input), "tokens in")}{tile(fmtTok(c.tokens.output), "tokens out")}{tile(fmtTok(c.tokens.cached), "cached")}
			</div>
			<h3 style={{ fontSize: 12, textTransform: "uppercase", opacity: 0.7, margin: "12px 0 6px" }}>Input attribution</h3>
			<div style={{ fontSize: 11, opacity: 0.8 }}>
				model {fmtTok(srcv.model)} · planner {fmtTok(srcv.planner)} · tools {fmtTok(srcv.tools)} · recap {fmtTok(srcv.recap)}
			</div>
			<div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>recaps {c.recaps} · context clears {c.clears} · budget warnings {c.budgetWarnings} · finish refusals {c.refusals}</div>
			<div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>manifests {c.manifests ?? 0} · structured compactions {c.compactions ?? 0} · closeouts {c.closeouts ?? 0}</div>
			{c.latestManifest && (
				<div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>
					latest invocation {c.latestManifest.invocationId}: {c.latestManifest.purpose} / {c.latestManifest.payloadMode}, {fmtTok(c.latestManifest.inputTokenCount)} input tokens
					{c.latestManifest.compactionApplied ? `, compacted (${c.latestManifest.compactionAuthority})` : ""}{c.latestManifest.truncationApplied ? `, ${c.latestManifest.omittedContent} omitted refs` : ""}
				</div>
			)}
			{(c.closeoutSummaries ?? []).length > 0 && (
				<>
					<h3 style={{ fontSize: 12, textTransform: "uppercase", opacity: 0.7, margin: "12px 0 6px" }}>Closeouts</h3>
					{(c.closeoutSummaries ?? []).map((x) => (
						<div key={x.closeoutId} style={{ fontSize: 11, padding: "4px 0", borderBottom: "1px solid #2a2a2a" }}>
							<strong>{x.outcome}</strong> · {x.objective || "objective unavailable"} · validation {x.validation} · files {x.filesModified} · issues {x.unresolvedIssues} · v{x.version}
						</div>
					))}
				</>
			)}
			{(c.compactionRecords ?? []).length > 0 && (
				<>
					<h3 style={{ fontSize: 12, textTransform: "uppercase", opacity: 0.7, margin: "12px 0 6px" }}>Compaction records</h3>
					{(c.compactionRecords ?? []).map((x) => (
						<div key={x.compactionId} style={{ fontSize: 11, padding: "3px 0", borderBottom: "1px solid #2a2a2a", opacity: 0.85 }}>
							{x.scope} v{x.version} · seq {x.from}-{x.to} · {x.preservedReferences} evidence refs preserved
						</div>
					))}
				</>
			)}
			<h3 style={{ fontSize: 12, textTransform: "uppercase", opacity: 0.7, margin: "12px 0 6px" }}>Execution stats</h3>
			<table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
				<thead><tr style={{ textAlign: "left", opacity: 0.6, fontSize: 10, textTransform: "uppercase" }}><th style={{ padding: 4 }}>Tool</th><th>Calls</th><th>Failed</th></tr></thead>
				<tbody>
					{report.execution.tools.map((x) => (
						<tr key={x.name} style={{ borderTop: "1px solid #333" }}><td style={{ padding: "4px", fontFamily: "monospace" }}>{x.name}</td><td>{x.calls}</td><td>{x.failures || ""}</td></tr>
					))}
				</tbody>
			</table>
			<h3 style={{ fontSize: 12, textTransform: "uppercase", opacity: 0.7, margin: "12px 0 6px" }}>Harness interventions</h3>
			{report.interventions.length === 0 ? <div className="card muted" style={{ padding: 12 }}>The harness never had to intervene.</div> : report.interventions.map((iv) => (
				<div key={iv.seq} style={{ padding: "4px 0", fontSize: 12, borderBottom: "1px solid #2a2a2a" }}>
					<span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", opacity: 0.7, marginRight: 8 }}>{iv.kind}</span>
					<span style={{ marginRight: 8 }}>{iv.label}</span>
					<span style={{ fontSize: 10, opacity: 0.5 }}>{new Date(iv.at).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
					{iv.detail && <div style={{ fontSize: 11, opacity: 0.6, whiteSpace: "pre-wrap", marginTop: 2 }}>{iv.detail.slice(0, 400)}</div>}
				</div>
			))}
		</div>
	);

	const rawEvents = (report.events ?? []).filter((ev) => {
		if (rawFilter !== "all" && ev.type !== rawFilter) return false;
		if (rawSearch && !JSON.stringify(ev).toLowerCase().includes(rawSearch.toLowerCase())) return false;
		return true;
	});
	const rawTypes = [...new Set((report.events ?? []).map((ev) => String(ev.type)))].sort();
	const rawTab = (report.events ?? []).length === 0 ? (
		<div className="card muted" style={{ padding: 12 }}>No raw events in this report — it predates raw embedding.</div>
	) : (
		<div>
			<div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
				<select value={rawFilter} onChange={(e) => setRawFilter(e.target.value)} style={{ fontSize: 11, background: "#252526", border: "1px solid #444", borderRadius: 5, color: "inherit", padding: "3px 8px" }}>
					<option value="all">All types ({(report.events ?? []).length})</option>
					{rawTypes.map((t) => <option key={t} value={t}>{t}</option>)}
				</select>
				<input value={rawSearch} onChange={(e) => setRawSearch(e.target.value)} placeholder="Search event JSON…" style={{ fontSize: 11, background: "rgba(0,0,0,0.25)", border: "1px solid #444", borderRadius: 5, color: "inherit", padding: "3px 8px", width: 200 }} />
				<button onClick={() => {
					const blob = new Blob([(report.events ?? []).map((ev) => JSON.stringify(ev)).join("\n")], { type: "application/jsonl" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url; a.download = `harness-events-${id}.jsonl`; a.click();
					URL.revokeObjectURL(url);
				}} style={{ marginLeft: "auto", fontSize: 11, background: "none", border: "1px solid #444", borderRadius: 5, color: "inherit", padding: "3px 10px", cursor: "pointer", opacity: 0.8 }}>JSONL ⬇</button>
			</div>
			<div className="muted" style={{ fontSize: 10, marginBottom: 6 }}>{rawEvents.length} events{(report.eventsOmitted ?? 0) > 0 ? ` (${report.eventsOmitted} omitted — size cap)` : ""}</div>
			{rawEvents.map((ev, i) => (
				<details key={i} style={{ borderBottom: "1px solid #222", padding: "3px 0" }}>
					<summary style={{ fontSize: 11, cursor: "pointer", userSelect: "none", display: "flex", gap: 8, alignItems: "baseline", listStyle: "none" }}>
						<span style={{ fontSize: 8, opacity: 0.35, fontFamily: "monospace", width: 32, textAlign: "right", flexShrink: 0 }}>{String(ev.seq ?? "")}</span>
						<span style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace", color: "#61afef", flexShrink: 0 }}>{String(ev.type)}</span>
						<span style={{ fontSize: 10, opacity: 0.55, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{
							ev.type === "model.response" ? `turn ${String(ev.turn)}` :
							ev.type === "tool.finished" || ev.type === "tool.requested" ? `${String(ev.name)} ${String((ev as { callId?: string }).callId ?? "").slice(0, 12)}` :
							ev.type === "task.created" ? String((ev as { task?: { title?: string } }).task?.title ?? "").slice(0, 60) :
							""
						}</span>
						<span style={{ fontSize: 9, opacity: 0.4, marginLeft: "auto", flexShrink: 0 }}>{fmtClock(Number(ev.at))}</span>
					</summary>
					<pre style={{ fontSize: 10, fontFamily: "monospace", background: "rgba(0,0,0,0.25)", border: "1px solid #333", borderRadius: 4, padding: "6px 8px", margin: "4px 0 6px 40px", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 300, overflowY: "auto", userSelect: "text" }}>{JSON.stringify(ev, null, 2)}</pre>
				</details>
			))}
		</div>
	);

	const bodies: Record<string, React.ReactNode> = { plan: planTab, timeline: timelineTab, divergence: divergenceTab, comparison: comparisonTab, artifacts: artifactsTab, context: contextTab, raw: rawTab };

	return (
		<div style={{ padding: "16px 20px", maxWidth: 1100 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
				<Link href={`/runs/${id}`} style={{ fontSize: 12, opacity: 0.7 }}>← run</Link>
				<h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Harness report</h1>
				<button
					onClick={() => {
						const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
						const url = URL.createObjectURL(blob);
						const a = document.createElement("a");
						a.href = url;
						a.download = `harness-report-${id}.json`;
						a.click();
						URL.revokeObjectURL(url);
					}}
					style={{ marginLeft: "auto", fontSize: 11, background: "none", border: "1px solid #444", borderRadius: 5, color: "inherit", padding: "3px 10px", cursor: "pointer", opacity: 0.8 }}
					title="Download the full report JSON — includes per-run inputs/outputs"
				>report JSON ⬇</button>
			</div>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
				{tile(s?.planVersions ?? 1, "Plan versions", undefined, "teal")}
				{tile(s?.tasks?.total ?? 0, "Tasks", `${s?.tasks?.completed ?? 0} completed · ${s?.tasks?.changed ?? 0} changed`, "green")}
				{tile(s?.steps?.total ?? 0, "Steps", `${s?.steps?.completed ?? 0} completed · ${s?.steps?.skipped ?? 0} skipped · ${s?.steps?.replaced ?? 0} replaced`, "purple")}
				{tile(s?.toolRuns?.total ?? 0, "Tool runs", `${s?.toolRuns?.succeeded ?? 0} succeeded · ${s?.toolRuns?.retried ?? 0} retried`, "blue")}
				{tile(s?.divergences?.total ?? 0, "Divergences", `${s?.divergences?.taskAdded ?? 0} new · ${s?.divergences?.stepReplaced ?? 0} replaced · ${s?.divergences?.unplanned ?? 0} unplanned`, "amber")}
				{tile(fmtDur(s?.durationMs), "Total duration", undefined, "slate")}
			</div>
			<div style={{ display: "flex", gap: 2, borderBottom: "1px solid #333", marginBottom: 12, flexWrap: "wrap" }}>
				{tabs.map(([name, label]) => (
					<button key={name} onClick={() => setTab(name)} style={{ background: "none", border: "none", borderBottom: tab === name ? "2px solid #007fd4" : "2px solid transparent", color: "inherit", opacity: tab === name ? 1 : 0.65, fontWeight: tab === name ? 600 : 400, fontSize: 12, padding: "6px 12px", cursor: "pointer" }}>{label}</button>
				))}
			</div>
			{bodies[tab]}
			{info && <InfoPanel {...info} turns={report.turns} executions={report.executions} plans={report.plans} onClose={() => setInfo(null)} onOpenExec={(cid) => { setInfo(null); setExecSel(cid); }} />}
			{turnSel !== null && (() => {
				const t = (report.turns ?? []).find((x) => x.turn === turnSel);
				return t ? <TurnDetail turn={t} executions={report.executions ?? []} onClose={() => setTurnSel(null)} onOpenExec={(cid) => { setTurnSel(null); setExecSel(cid); }} /> : null;
			})()}
			{execSel !== null && (() => {
				const ex = (report.executions ?? []).find((x) => x.callId === execSel);
				return ex ? <ExecDetail ex={ex} onClose={() => setExecSel(null)} /> : null;
			})()}
		</div>
	);
}
