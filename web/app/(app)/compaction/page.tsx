"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fmtTok } from "@/components/AreaChart";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { Stat } from "@/components/Stat";
import { apiFetch, useUser } from "@/lib/api";
import { RangePicker } from "@/lib/usage";

interface Item {
	at: string;
	runId: string;
	sessionId: string;
	agentIndex?: number;
	task?: string;
	model?: string;
	provider?: string;
	status?: string;
	forced?: boolean;
	soft?: boolean;
	contextBudget?: number;
	contextWindow?: number;
	actualInputTokens?: number;
	recap?: string;
	estTokensBefore?: number;
	estTokensAfter?: number;
	stubbed?: number;
	clamped?: number;
	superseded?: number;
	callsElided?: number;
	reasoningPruned?: number;
	attachmentsStubbed?: number;
	summarized?: boolean;
}

const fmt = (v?: string) => (v ? new Date(v).toLocaleString() : "—");

function tierOf(i: Item): string {
	if (i.forced) return "forced";
	if (i.soft) return "soft";
	return "hard";
}

function breakdown(i: Item): string {
	const parts: string[] = [];
	if (i.stubbed) parts.push(`${i.stubbed} stub`);
	if (i.superseded) parts.push(`${i.superseded} superseded`);
	if (i.clamped) parts.push(`${i.clamped} clamp`);
	if (i.callsElided) parts.push(`${i.callsElided} elided`);
	if (i.reasoningPruned) parts.push(`${i.reasoningPruned} reasoning`);
	if (i.attachmentsStubbed) parts.push(`${i.attachmentsStubbed} attach`);
	if (i.summarized) parts.push("recap");
	return parts.join(" · ") || "—";
}

export default function CompactionPage() {
	const user = useUser();
	const [range, setRange] = useState(86_400_000 * 7);
	const [items, setItems] = useState<Item[]>([]);
	const [loading, setLoading] = useState(true);
	const [expanded, setExpanded] = useState<number | null>(null);

	useEffect(() => {
		if (!user) return;
		setLoading(true);
		void (async () => {
			const since = range ? `&since=${Date.now() - range}` : "";
			const res = await apiFetch(`/api/compactions?limit=500${since}`, user);
			if (res.ok) {
				const body = (await res.json()) as { items?: Item[] };
				setItems(body.items ?? []);
			}
			setLoading(false);
		})();
	}, [user, range]);

	const totalBefore = items.reduce((s, i) => s + (i.estTokensBefore ?? 0), 0);
	const totalAfter = items.reduce((s, i) => s + (i.estTokensAfter ?? 0), 0);
	const avgReduction =
		items.length && totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;

	return (
		<>
			<div className="section-head" style={{ marginTop: 0 }}>
				<h1>Compaction</h1>
				<RangePicker value={range} onChange={setRange} />
			</div>

			<div className="stat-grid">
				<Stat label="Compactions" value={items.length.toLocaleString()} />
				<Stat label="Est. before" value={fmtTok(totalBefore)} />
				<Stat label="Est. after" value={fmtTok(totalAfter)} />
				<Stat label="Avg. reduction" value={items.length ? `${avgReduction}%` : "—"} />
			</div>

			<div className="card table-card" style={{ marginTop: 12 }}>
				{loading && items.length === 0 ? (
					<div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
						<Skeleton height={32} />
						<Skeleton height={32} />
						<Skeleton height={32} />
					</div>
				) : (
					<table>
						<thead>
							<tr>
								<th>Time</th>
								<th>Session</th>
								<th>Run</th>
								<th>Task</th>
								<th>Model</th>
								<th>Window</th>
								<th>Tier</th>
								<th>Budget</th>
								<th>Actual in</th>
								<th>Before → After</th>
								<th>Saved</th>
								<th>Breakdown</th>
							</tr>
						</thead>
						<tbody>
							{items.map((i, idx) => {
								const saved =
									i.estTokensBefore && i.estTokensAfter != null
										? Math.round((1 - (i.estTokensAfter ?? 0) / i.estTokensBefore) * 100)
										: null;
								return (
									<>
										<tr
											key={idx}
											onClick={() => setExpanded(expanded === idx ? null : idx)}
											style={{ cursor: "pointer" }}
											title={i.recap ? "click to view compaction brief" : undefined}
										>
											<td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(i.at)}</td>
											<td className="muted mono">
												<Link href={`/sessions/${i.sessionId}`} style={{ color: "inherit" }}>
													{(i.sessionId ?? "").slice(0, 8)}
												</Link>
											</td>
											<td className="muted mono">
												<Link href={`/runs/${i.runId}`} style={{ color: "inherit" }}>
													{(i.runId ?? "").slice(0, 12)}
												</Link>
												{(i.agentIndex ?? 0) > 0 && <span className="muted"> ·a{i.agentIndex}</span>}
											</td>
											<td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={i.task}>
												{i.task ?? "—"}
											</td>
											<td className="muted" style={{ fontSize: 11.5 }} title={i.provider}>
												{i.model ?? "—"}
											</td>
											<td className="muted num">{i.contextWindow ? fmtTok(i.contextWindow) : "—"}</td>
											<td>
												<span className={`sess-pill ${i.forced ? "failed" : i.soft ? "completed" : "running"}`}>
													{tierOf(i)}
												</span>
											</td>
											<td className="muted num">{i.contextBudget ? fmtTok(i.contextBudget) : "—"}</td>
											<td className="num">{i.actualInputTokens != null ? i.actualInputTokens.toLocaleString() : "—"}</td>
											<td className="num">
												{i.estTokensBefore != null ? fmtTok(i.estTokensBefore) : "?"} →{" "}
												{i.estTokensAfter != null ? fmtTok(i.estTokensAfter) : "?"}
											</td>
											<td className="muted num">{saved != null ? `${saved}%` : "—"}</td>
											<td className="muted" style={{ fontSize: 11.5 }}>{breakdown(i)}</td>
										</tr>
										{expanded === idx && (
											<tr key={`${idx}-detail`}>
												<td colSpan={12} style={{ background: "var(--bg)", padding: 12 }}>
													{i.recap ? (
														<pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12, fontFamily: "inherit" }}>
															{i.recap}
														</pre>
													) : (
														<span className="muted">
															No recap — this compaction used stubbing/clamping only (see Breakdown). Estimates are
															char-based; Actual in is the provider-counted input tokens of the previous request.
														</span>
													)}
												</td>
											</tr>
										)}
									</>
								);
							})}
						</tbody>
					</table>
				)}
				{items.length === 0 && !loading && (
					<Empty>
						No compactions yet — they appear here when a run&apos;s context crosses its effective budget
						(currently ~40% of the task&apos;s context budget for the soft tier).
					</Empty>
				)}
			</div>
		</>
	);
}
