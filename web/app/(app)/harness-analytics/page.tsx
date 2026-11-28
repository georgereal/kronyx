"use client";

import { useEffect, useState } from "react";
import { apiFetch, useUser } from "@/lib/api";

interface Analytics {
	runs: number;
	perRun: { session?: string; runId?: string; durationMs?: number; divergences: { total: number; harness: number; model: number }; failedCloses: number; planVersions: number; repeatReads: number }[];
	divergences: { total: number; harnessCaused: number; modelCaused: number; byKind: Record<string, number> };
	friction: { reason: string; count: number; example?: string }[];
	steering: { rule: string; count: number }[];
	loopVerdicts: Record<string, number>;
	repeatReads: { path: string; reads: number }[];
	churn: { avgVersions: number; runsWithReplacements: number; stepReplacements: number };
}

const fmtDur = (ms?: number) => {
	if (ms === undefined) return "—";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export default function HarnessAnalyticsPage() {
	const user = useUser();
	const [data, setData] = useState<Analytics | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		if (!user) return;
		void (async () => {
			const res = await apiFetch("/api/harness-analytics", user);
			if (!res.ok) return setErr(`failed: ${res.status}`);
			const body = (await res.json()) as { analytics: Analytics };
			setData(body.analytics);
		})();
	}, [user]);

	if (err) return <div style={{ padding: 24 }}>Error: {err}</div>;
	if (!data) return <div style={{ padding: 24 }}>Loading…</div>;

	const card = (title: string, children: React.ReactNode) => (
		<div className="card" style={{ padding: 14, marginBottom: 12 }}>
			<div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{title}</div>
			{children}
		</div>
	);
	const bar = (count: number, max: number, color: string) => (
		<div style={{ height: 5, borderRadius: 3, background: "#333", flex: 1, minWidth: 60 }}>
			<div style={{ height: 5, borderRadius: 3, background: color, width: `${Math.round((count / Math.max(1, max)) * 100)}%` }} />
		</div>
	);

	return (
		<div style={{ padding: "16px 20px", maxWidth: 1000 }}>
			<h1 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 4px" }}>Harness analytics</h1>
			<div className="muted" style={{ fontSize: 11, marginBottom: 14 }}>
				Cross-run harness health from {data.runs} uploaded report{data.runs === 1 ? "" : "s"} — the harness-improvement backlog, ranked. Runs without uploads don&apos;t appear here.
			</div>

			<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
				{[
					[data.runs, "runs"],
					[data.divergences.total, "divergences"],
					[data.divergences.harnessCaused, "harness-caused"],
					[data.divergences.modelCaused, "model-caused"],
					[data.churn.avgVersions.toFixed(1), "avg plan versions"],
					[data.churn.stepReplacements, "step replacements"],
				].map(([n, l]) => (
					<div key={String(l)} className="card" style={{ padding: "10px 12px", flex: 1, minWidth: 100 }}>
						<div style={{ fontSize: 18, fontWeight: 700 }}>{n}</div>
						<div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.65 }}>{l}</div>
					</div>
				))}
			</div>

			{card("Harness friction — why the model couldn't close steps (ranked)", (
				<div>
					{data.friction.length === 0 && <div className="muted" style={{ fontSize: 11 }}>No failed close attempts — clean runs.</div>}
					{data.friction.slice(0, 8).map((f) => (
						<div key={f.reason} style={{ display: "flex", gap: 10, alignItems: "center", padding: "4px 0", fontSize: 12 }}>
							<span style={{ fontWeight: 700, width: 30, textAlign: "right" }}>{f.count}×</span>
							{bar(f.count, data.friction[0]?.count ?? 1, "#e06c75")}
							<span style={{ flex: 2 }}>{f.reason}</span>
						</div>
					))}
				</div>
			))}

			{card("Steering rules fired — where the harness had to correct the model", (
				<div>
					{data.steering.length === 0 && <div className="muted" style={{ fontSize: 11 }}>No steering interventions.</div>}
					{data.steering.slice(0, 8).map((s) => (
						<div key={s.rule} style={{ display: "flex", gap: 10, alignItems: "center", padding: "3px 0", fontSize: 12 }}>
							<span style={{ fontWeight: 700, width: 30, textAlign: "right" }}>{s.count}×</span>
							{bar(s.count, data.steering[0]?.count ?? 1, "#c586c0")}
							<span style={{ flex: 2, fontFamily: "monospace", fontSize: 11 }}>{s.rule}</span>
						</div>
					))}
				</div>
			))}

			{card("Divergences by kind", (
				<div style={{ display: "flex", gap: 14, fontSize: 12, flexWrap: "wrap" }}>
					{Object.entries(data.divergences.byKind).map(([k, n]) => (
						<span key={k}><b>{n}</b> {k}</span>
					))}
					{Object.keys(data.divergences.byKind).length === 0 && <span className="muted">none</span>}
				</div>
			))}

			{card("Repeat reads — file thrash across runs (≥6 reads)", (
				<div>
					{data.repeatReads.length === 0 && <div className="muted" style={{ fontSize: 11 }}>No significant thrash.</div>}
					{data.repeatReads.map((r) => (
						<div key={r.path} style={{ display: "flex", gap: 10, alignItems: "center", padding: "2px 0", fontSize: 12 }}>
							<span style={{ fontWeight: 700, width: 36, textAlign: "right" }}>{r.reads}×</span>
							{bar(r.reads, data.repeatReads[0]?.reads ?? 1, "#e5c07b")}
							<span style={{ flex: 2, fontFamily: "monospace", fontSize: 11 }}>{r.path}</span>
						</div>
					))}
				</div>
			))}

			{card("Per-run breakdown", (
				<table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
					<thead>
						<tr style={{ textAlign: "left", opacity: 0.6, fontSize: 9, textTransform: "uppercase" }}>
							<th style={{ padding: 4 }}>Session</th><th>Duration</th><th>Divergences</th><th>Harness / model</th><th>Failed closes</th><th>Plan versions</th><th>Repeat reads</th>
						</tr>
					</thead>
					<tbody>
						{data.perRun.map((r, i) => (
							<tr key={i} style={{ borderTop: "1px solid #333" }}>
								<td style={{ padding: "4px" }}>{r.session ?? r.runId?.slice(0, 8) ?? "—"}</td>
								<td>{fmtDur(r.durationMs)}</td>
								<td>{r.divergences.total}</td>
								<td>{r.divergences.harness} / {r.divergences.model}</td>
								<td style={{ color: r.failedCloses ? "#e06c75" : undefined }}>{r.failedCloses}</td>
								<td>{r.planVersions}</td>
								<td>{r.repeatReads}</td>
							</tr>
						))}
					</tbody>
				</table>
			))}
		</div>
	);
}
