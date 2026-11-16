"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { bucketizeSeries, fmtTok, MultiLineChart } from "@/components/AreaChart";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { Stat } from "@/components/Stat";
import { apiFetch, useUser } from "@/lib/api";
import { RangePicker } from "@/lib/usage";

interface ContextLine { role: string; kind: string; chars: number; preview: string }

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
	contextPreview?: { before?: ContextLine[]; after?: ContextLine[] };
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
const tierOf = (i: Item) => (i.forced ? "forced" : i.soft ? "soft" : "hard");
const savedPct = (i: Item) =>
	i.estTokensBefore && i.estTokensAfter != null ? Math.round((1 - (i.estTokensAfter ?? 0) / i.estTokensBefore) * 100) : null;

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

const kindColor = (k: string) =>
	k === "tool-result" ? "var(--ok)" : k === "tool-call" ? "var(--accent)" : k === "reasoning" ? "#a78bfa" : k === "attachment" ? "var(--warn)" : "var(--muted)";

function ContextPanel({ title, tokens, lines, fallback }: { title: string; tokens?: number; lines?: ContextLine[]; fallback?: React.ReactNode }) {
	return (
		<div className="cmp-panel">
			<div className="cmp-panel-head">
				<span>{title}</span>
				{tokens != null && <span className="sess-pill completed">{tokens.toLocaleString()} tokens</span>}
			</div>
			<div className="cmp-lines">
				{lines?.length
					? lines.map((l, i) => (
							<div key={i} className="cmp-line">
								<span className="ln">{i + 1}</span>
								<span className="kind" style={{ color: kindColor(l.kind) }}>{l.role}·{l.kind}</span>
								<span className="txt">{l.preview || "…"}</span>
							</div>
						))
					: fallback ?? <div className="muted" style={{ fontSize: 11, padding: 8 }}>No context preview stored for this compaction.</div>}
			</div>
		</div>
	);
}

export default function CompactionPage() {
	const user = useUser();
	const [range, setRange] = useState(86_400_000 * 7);
	const [items, setItems] = useState<Item[]>([]);
	const [loading, setLoading] = useState(true);
	const [expanded, setExpanded] = useState<number | null>(null);
	const [groupBy, setGroupBy] = useState<"model" | "tier">("model");
	const [f, setF] = useState({ q: "", model: "", tier: "", trigger: "", result: "" });
	const [copied, setCopied] = useState(false);

	const load = async () => {
		if (!user) return;
		setLoading(true);
		const since = range ? `&since=${Date.now() - range}` : "";
		const res = await apiFetch(`/api/compactions?limit=500${since}`, user);
		if (res.ok) {
			const body = (await res.json()) as { items?: Item[] };
			setItems(body.items ?? []);
		}
		setLoading(false);
	};
	useEffect(() => { void load(); }, [user, range]);

	const filtered = items.filter((i) => {
		if (f.q && !`${i.task ?? ""} ${i.runId} ${i.sessionId}`.toLowerCase().includes(f.q.toLowerCase())) return false;
		if (f.model && i.model !== f.model) return false;
		if (f.tier && tierOf(i) !== f.tier) return false;
		if (f.trigger && (i.forced ? "threshold" : "budget") !== f.trigger) return false;
		if (f.result && ((savedPct(i) ?? 0) > 0 ? "reduced" : "none") !== f.result) return false;
		return true;
	});

	const totalBefore = filtered.reduce((s, i) => s + (i.estTokensBefore ?? 0), 0);
	const totalAfter = filtered.reduce((s, i) => s + (i.estTokensAfter ?? 0), 0);
	const avgReduction = filtered.length && totalBefore > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;
	const succeeded = filtered.filter((i) => (savedPct(i) ?? 0) > 0).length;

	const [bB, aB] = bucketizeSeries(filtered, (i) => new Date(i.at).getTime(), [(i) => i.estTokensBefore ?? 0, (i) => i.estTokensAfter ?? 0], 24);
	const chartSeries = [
		{ label: `Before (${fmtTok(totalBefore)})`, color: "#a78bfa", buckets: bB },
		{ label: `After (${fmtTok(totalAfter)})`, color: "#3ecf8e", buckets: aB },
	];

	const groups = new Map<string, { saved: number; before: number; n: number }>();
	for (const i of filtered) {
		const key = groupBy === "model" ? (i.model ?? "unknown") : tierOf(i);
		const g = groups.get(key) ?? { saved: 0, before: 0, n: 0 };
		g.saved += Math.max(0, (i.estTokensBefore ?? 0) - (i.estTokensAfter ?? 0));
		g.before += i.estTokensBefore ?? 0;
		g.n++;
		groups.set(key, g);
	}
	const groupRows = [...groups.entries()].sort((a, b) => b[1].saved - a[1].saved).slice(0, 8);
	const maxSaved = groupRows[0]?.[1].saved ?? 1;
	const models = [...new Set(items.map((i) => i.model).filter(Boolean))] as string[];

	const csv = () => {
		const rows = [["time", "sessionId", "runId", "task", "model", "tier", "window", "budget", "actualIn", "before", "after", "savedPct"].join(",")];
		for (const i of filtered)
			rows.push(
				[i.at, i.sessionId, i.runId, JSON.stringify(i.task ?? ""), i.model ?? "", tierOf(i), i.contextWindow ?? "", i.contextBudget ?? "", i.actualInputTokens ?? "", i.estTokensBefore ?? "", i.estTokensAfter ?? "", savedPct(i) ?? ""].join(","),
			);
		const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `compactions-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const copySummary = (i: Item) => {
		void navigator.clipboard.writeText(i.recap ?? breakdown(i));
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<>
			<div className="sbx-head" style={{ marginBottom: 14 }}>
				<h1>Compaction</h1>
				<div className="sub">Inspect context compaction activity and token savings.</div>
			</div>
			<div className="section-head" style={{ marginTop: 0 }}>
				<RangePicker value={range} onChange={setRange} />
				<button className="sbx-btn" onClick={() => void load()} disabled={loading}>⟳ Refresh</button>
			</div>

			{loading && !items.length ? (
				<div className="stat-grid">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={88} />)}</div>
			) : (
				<div className="stat-grid">
					<Stat label="Compactions" value={filtered.length.toLocaleString()} />
					<Stat label="Est. Tokens (Before)" value={fmtTok(totalBefore)} />
					<Stat label="Est. Tokens (After)" value={fmtTok(totalAfter)} />
					<Stat label="Avg. Reduction" value={filtered.length ? `${avgReduction}%` : "—"} />
					<Stat label="Success Rate" value={filtered.length ? `${((succeeded / filtered.length) * 100).toFixed(1)}%` : "—"} sub={filtered.length ? `${succeeded} / ${filtered.length}` : undefined} />
				</div>
			)}

			<div className="mem-cards" style={{ gridTemplateColumns: "3fr 2fr" }}>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title" style={{ display: "flex", justifyContent: "space-between" }}>
						Token Volume (Before vs After)
						<span className="sbx-legend">
							<span><i className="dot" style={{ background: "#a78bfa" }} /> Before</span>
							<span><i className="dot" style={{ background: "#3ecf8e" }} /> After</span>
						</span>
					</div>
					<MultiLineChart series={chartSeries} height={170} />
				</div>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title" style={{ display: "flex", justifyContent: "space-between" }}>
						Savings by
						<span className="cmp-seg">
							<button className={groupBy === "model" ? "active" : ""} onClick={() => setGroupBy("model")}>Model</button>
							<button className={groupBy === "tier" ? "active" : ""} onClick={() => setGroupBy("tier")}>Tier</button>
						</span>
					</div>
					<div className="cmp-bars">
						{groupRows.map(([k, g]) => (
							<div key={k} className="cmp-bar-row">
								<span className="lbl" title={k}>{k}</span>
								<span className="track"><span className="fill" style={{ width: `${(g.saved / maxSaved) * 100}%` }} /></span>
								<span className="val">{fmtTok(g.saved)} ({g.before ? Math.round((g.saved / g.before) * 100) : 0}%)</span>
							</div>
						))}
						{!groupRows.length && <div className="muted" style={{ fontSize: 11 }}>No savings in this range.</div>}
					</div>
				</div>
			</div>

			<div className="mem-filters card" style={{ marginTop: 12, borderBottom: 0 }}>
				<input placeholder="Search compactions (task, run, session…)" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
				<select value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
					<option value="">All Models</option>
					{models.map((m) => <option key={m} value={m}>{m}</option>)}
				</select>
				<select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>
					<option value="">All Tiers</option>
					<option value="soft">soft</option>
					<option value="hard">hard</option>
					<option value="forced">forced</option>
				</select>
				<select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}>
					<option value="">All Triggers</option>
					<option value="budget">budget</option>
					<option value="threshold">threshold (forced)</option>
				</select>
				<select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
					<option value="">All Results</option>
					<option value="reduced">reduced</option>
					<option value="none">no reduction</option>
				</select>
				<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
					<span className="muted" style={{ fontSize: 11 }}>{filtered.length} compactions</span>
					<button className="sbx-btn" title="Export CSV" onClick={csv}>⇩</button>
				</span>
			</div>

			<div className="card table-card" style={{ marginTop: 0 }}>
				{loading && items.length === 0 ? (
					<div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}><Skeleton height={32} /><Skeleton height={32} /><Skeleton height={32} /></div>
				) : (
					<table className="sbx-table">
						<thead>
							<tr>
								<th style={{ width: 26 }}></th>
								<th>Time</th><th>Session</th><th>Run</th><th>Task</th><th>Model</th><th>Window</th><th>Tier</th><th>Budget</th><th>Actual in</th><th>Before → After</th><th>Saved</th>
							</tr>
						</thead>
						<tbody>
							{filtered.map((i, idx) => {
								const saved = savedPct(i);
								const open = expanded === idx;
								return (
									<>
										<tr key={idx} onClick={() => setExpanded(open ? null : idx)} style={{ cursor: "pointer" }}>
											<td className="muted">{open ? "▾" : "▸"}</td>
											<td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(i.at)}</td>
											<td className="muted mono" onClick={(e) => e.stopPropagation()}>
												<Link href={`/sessions/${i.sessionId}`} style={{ color: "inherit" }}>{(i.sessionId ?? "").slice(0, 8)}</Link>
											</td>
											<td className="muted mono" onClick={(e) => e.stopPropagation()}>
												<Link href={`/runs/${i.runId}`} style={{ color: "inherit" }}>{(i.runId ?? "").slice(0, 12)}</Link>
												{(i.agentIndex ?? 0) > 0 && <span className="muted"> ·a{i.agentIndex}</span>}
											</td>
											<td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={i.task}>{i.task ?? "—"}</td>
											<td className="muted" style={{ fontSize: 11.5 }} title={i.provider}>{i.model ?? "—"}</td>
											<td className="muted num">{i.contextWindow ? fmtTok(i.contextWindow) : "—"}</td>
											<td><span className={`sess-pill ${i.forced ? "failed" : i.soft ? "completed" : "running"}`}>{tierOf(i)}</span></td>
											<td className="muted num">{i.contextBudget ? fmtTok(i.contextBudget) : "—"}</td>
											<td className="num">{i.actualInputTokens != null ? i.actualInputTokens.toLocaleString() : "—"}</td>
											<td className="num">
												{i.estTokensBefore != null ? fmtTok(i.estTokensBefore) : "?"} → {i.estTokensAfter != null ? fmtTok(i.estTokensAfter) : "?"}
											</td>
											<td><span className={`sess-pill ${(saved ?? 0) > 30 ? "completed" : "running"}`}>{saved != null ? `${saved}%` : "—"}</span></td>
										</tr>
										{open && (
											<tr key={`${idx}-detail`}>
												<td colSpan={12} style={{ background: "var(--bg)", padding: 14 }}>
													<div className="cmp-detail">
														<div>
															<div className="chart-title" style={{ marginBottom: 8 }}>Compaction Details</div>
															{([
																["Session", i.sessionId],
																["Run", i.runId],
																["Task", i.task ?? "—"],
																["Trigger", i.forced ? "Context threshold" : "Context budget"],
																["Tier", tierOf(i)],
																["Budget", i.contextBudget ? `${fmtTok(i.contextBudget)} tokens` : "—"],
																["Window", i.contextWindow ? `${fmtTok(i.contextWindow)} tokens` : "—"],
																["Agent", String(i.agentIndex ?? 0)],
																["Breakdown", breakdown(i)],
															] as const).map(([k, v]) => (
																<div key={k} className="sbx-kv"><span className="k">{k}</span><span className="mono" style={{ fontSize: 11 }}>{String(v).slice(0, 90)}</span></div>
															))}
														</div>
														<ContextPanel title="Before Compaction" tokens={i.estTokensBefore} lines={i.contextPreview?.before} />
														<div>
															<ContextPanel
																title="After Compaction"
																tokens={i.estTokensAfter}
																lines={i.contextPreview?.after}
																fallback={
																	i.recap ? (
																		<pre style={{ margin: 0, padding: 10, whiteSpace: "pre-wrap", fontSize: 11.5, fontFamily: "inherit" }}>{i.recap}</pre>
																	) : (
																		<div className="muted" style={{ fontSize: 11, padding: 8 }}>No recap or preview — stub/clamp-only compaction.</div>
																	)
																}
															/>
															<div style={{ display: "flex", gap: 6, marginTop: 10 }}>
																<Link href={`/runs/${i.runId}`}><button className="sbx-btn">▶ View run</button></Link>
																<Link href={`/runs/${i.runId}#timeline`}><button className="sbx-btn">🔍 Inspect details</button></Link>
																<button className="sbx-btn" onClick={() => copySummary(i)}>{copied ? "✓ Copied" : "⧉ Copy summary"}</button>
															</div>
														</div>
													</div>
												</td>
											</tr>
										)}
									</>
								);
							})}
						</tbody>
					</table>
				)}
				{filtered.length === 0 && !loading && (
					<Empty>No compactions match — they appear when a run's context crosses its effective budget.</Empty>
				)}
			</div>
		</>
	);
}
