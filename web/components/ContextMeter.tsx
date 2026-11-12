"use client";

import type { User } from "firebase/auth";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { RunEvent } from "@/lib/types";
import { AreaChart, fmtTok } from "@/components/AreaChart";
import { Modal } from "@/components/Modal";

interface UsagePoint {
	iteration: number | null;
	requestTokens: number;
	tokensOut: number;
	contextMsgs: number | null;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	costUsd: number | null;
	at: string;
}

interface UsageResponse {
	contextWindow: number | null;
	runs: { runId: string; task: string; model: string; points: UsagePoint[] }[];
	compactions: { runId: string; text: string; meta: Record<string, unknown>; at: string }[];
	handoffs: { runId: string; text: string; at: string }[];
	totals: { tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; reasoningTokens: number; costUsd: number };
}

const usd = (n: number | null | undefined) => (n == null ? "—" : n < 0.01 ? "<$0.01" : `$${n.toFixed(3)}`);

/**
 * Context meter pill — "41% (108K / 262K) context used" above the composer.
 * Live: latest `usage` event carries requestTokens/contextWindow stamped by
 * the worker. Click opens the history modal (per-request series, compaction
 * and handoff markers, session totals).
 */
export function ContextMeter({ user, sessionId, events }: { user: User; sessionId: string; events: RunEvent[] }) {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState<UsageResponse | null>(null);

	// Latest stamped usage event → live context fill.
	const live = useMemo(() => {
		for (let i = events.length - 1; i >= 0; i--) {
			const ev = events[i].event;
			if (ev.type === "usage" && Number(ev.requestTokens) > 0) {
				return {
					requestTokens: Number(ev.requestTokens),
					contextWindow: Number(ev.contextWindow) || 0,
					pct: Number(ev.contextPct) || 0,
				};
			}
		}
		return null;
	}, [events]);

	useEffect(() => {
		if (!open) return;
		void apiFetch(`/api/sessions/${sessionId}/usage`, user)
			.then(async (r) => (r.ok ? setData((await r.json()) as UsageResponse) : undefined))
			.catch(() => {});
	}, [open, user, sessionId]);

	const win = live?.contextWindow || data?.contextWindow || 0;
	const req = live?.requestTokens ?? data?.runs.flatMap((r) => r.points).at(-1)?.requestTokens ?? 0;
	const pct = win ? Math.min(100, Math.round((req / win) * 100)) : live?.pct ?? 0;
	if (!win && !req && !data) return null;

	const allPoints = (data?.runs ?? []).flatMap((r) => r.points.map((p) => ({ ...p, runId: r.runId, model: r.model })));
	const buckets = allPoints.map((p) => ({ t: new Date(p.at).getTime(), value: p.requestTokens }));

	return (
		<>
			<button className="ctx-pill" onClick={() => setOpen(true)} title="Context window usage — click for history">
				<span className="ctx-bar"><span style={{ width: `${pct}%` }} /></span>
				<span className="muted">{pct}%</span>
				<span>{win ? `(${fmtTok(req)} / ${fmtTok(win)})` : fmtTok(req)} context used</span>
			</button>
			{open && (
				<Modal title="Context usage" onClose={() => setOpen(false)}>
					{!data ? (
						<div className="muted">Loading…</div>
					) : (
						<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
							<div>
								<div className="ev-kind">Now</div>
								<div className="ctx-bar lg"><span style={{ width: `${pct}%` }} /></div>
								<div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
									{fmtTok(req)} / {fmtTok(win)} ({pct}%) ·{" "}
									{data.runs.at(-1)?.model ?? "model"}
								</div>
								<div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
									Σ in {fmtTok(data.totals.tokensIn)} · out {fmtTok(data.totals.tokensOut)} · cache R {fmtTok(data.totals.cacheRead)} / W {fmtTok(data.totals.cacheWrite)}
									{data.totals.reasoningTokens ? ` · reasoning ${fmtTok(data.totals.reasoningTokens)}` : ""} · {usd(data.totals.costUsd)}
								</div>
							</div>
							{(data.compactions.length > 0 || data.handoffs.length > 0) && (
								<div>
									<div className="ev-kind">Pruning history</div>
									<div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
										{data.compactions.map((c, i) => {
											const m = c.meta as { estTokensBefore?: number; estTokensAfter?: number; soft?: boolean; forced?: boolean; summarized?: boolean };
											return (
												<div key={i} className="muted">
													◈ {m.estTokensBefore ? `${fmtTok(m.estTokensBefore)} → ${fmtTok(m.estTokensAfter ?? 0)}` : c.text}
													{m.forced ? " (forced)" : m.soft ? " (soft)" : " (hard)"}
													{m.summarized ? " + summary" : ""}
												</div>
											);
										})}
										{data.handoffs.map((h, i) => (
											<div key={`h${i}`} className="muted">⇄ {h.text}</div>
										))}
									</div>
								</div>
							)}
							{buckets.length > 0 && (
								<div>
									<div className="ev-kind">Request size over time</div>
									<AreaChart buckets={buckets} height={140} />
									<div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
										per-request input tokens{win ? ` · window ${fmtTok(win)}` : ""}
									</div>
								</div>
							)}
							{data.runs.length > 0 && (
								<div>
									<div className="ev-kind">Runs</div>
									<div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
										{data.runs.map((r) => {
											const rin = r.points.reduce((a, p) => a + p.requestTokens, 0);
											const rout = r.points.reduce((a, p) => a + p.tokensOut, 0);
											const cost = r.points.reduce((a, p) => a + (p.costUsd ?? 0), 0);
											return (
												<div key={r.runId} className="muted" style={{ display: "flex", gap: 8 }}>
													<span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
														{r.task.slice(0, 60) || r.runId.slice(0, 12)}
													</span>
													<span className="mono">{fmtTok(rin)}/{fmtTok(rout)}{cost ? ` · ${usd(cost)}` : ""}</span>
												</div>
											);
										})}
									</div>
								</div>
							)}
						</div>
					)}
				</Modal>
			)}
		</>
	);
}
