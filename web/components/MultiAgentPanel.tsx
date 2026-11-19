"use client";

import type { RunDoc, RunEvent } from "@/lib/types";
import { agentVitals, fanoutEventFor, sliceIcon, sliceStatus, type AgentFocus } from "@/lib/agentLanes";
import { fmtTok } from "@/components/AreaChart";

/**
 * Persistent right-side "Multi-agent Execution" panel: n/N progress plus one
 * live row per slice (status, elapsed, last action). Click a row to drill into
 * that agent's stream — same focus state as the timeline's fan-out cards.
 */
export function MultiAgentPanel({
	events,
	runs,
	focus,
	onSelect,
}: {
	events: RunEvent[];
	runs?: RunDoc[];
	focus?: AgentFocus | null;
	onSelect: (f: AgentFocus | null) => void;
}) {
	const fe = fanoutEventFor(events);
	if (!fe) return null;
	const runId = fe.runId ?? "";
	const slices = (fe.event.slices as { index: number; title: string }[]) ?? [];
	const stOf = (i: number) => sliceStatus(events, runs, i, runId);
	const done = slices.filter((s) => ["done", "failed", "stopped"].includes(stOf(s.index))).length;
	const running = slices.filter((s) => stOf(s.index) === "running").length;
	const pct = slices.length ? Math.round((done / slices.length) * 100) : 0;
	const active = focus && focus.runId === runId;
	// Wall-clock: fanout emit → fanin emit (or now while still running).
	const startAt = Date.parse(fe.at ?? "") || 0;
	const endAt = Date.parse([...events].reverse().find((e) => e.runId === runId && e.event.type === "fanin")?.at ?? "") || Date.now();
	const elapsedSecs = startAt ? Math.max(0, Math.round((endAt - startAt) / 1000)) : 0;
	const elapsed = elapsedSecs >= 60 ? `${Math.floor(elapsedSecs / 60)}m ${elapsedSecs % 60}s` : `${elapsedSecs}s`;

	const row = (i: number, title: string, coord = false) => {
		const st = coord ? "" : stOf(i);
		const v = agentVitals(events, i, runId);
		const on = !!active && focus?.ai === i;
		return (
			<button
				key={i}
				className={`ma-row${on ? " on" : ""}`}
				onClick={() => onSelect(on ? null : { runId, ai: i })}
				title={`${coord ? "Coordinator" : `#${i} ${title}`} — ${st || "orchestration + merge"}`}
			>
				<span className="ma-row-icon">{coord ? "⛁" : sliceIcon(title)}</span>
				<span className="ma-row-main">
					<span className="ma-row-title">
						{coord ? "Coordinator" : `#${i} ${title}`}
						{st ? <span className={`slice-pill ${st}`}>{st}</span> : null}
					</span>
					<span className="ma-row-act muted">{v.lastAct || (st === "queued" ? "queued" : coord ? "orchestration + merge" : "")}</span>
				</span>
				<span className="ma-row-meta muted">
					{v.dur}
					{v.tin > 0 && <span className="ma-row-tok">{fmtTok(v.tin + v.tout)} tok</span>}
				</span>
			</button>
		);
	};

	return (
		<aside className="ma-panel">
			<div className="ma-panel-head">
				Multi-agent Execution
				{running > 0 && <span className="ma-run-chip">Running ({running}/{slices.length})</span>}
				<span className="muted ma-panel-sub">
					{slices.length} sub-agent{slices.length === 1 ? "" : "s"} · Parallel
				</span>
			</div>
			<div className="ma-progress">
				<span className="muted">
					{done}/{slices.length} completed
				</span>
				<div className="ma-progress-bar">
					<div className="ma-progress-fill" style={{ width: `${pct}%` }} />
				</div>
			</div>
			<div className="ma-rows">{slices.map((s) => row(s.index, s.title))}</div>
			<div className="ma-rows ma-coord">{row(0, "", true)}</div>
			{startAt > 0 && <div className="ma-elapsed muted">Elapsed: {elapsed}</div>}
		</aside>
	);
}
