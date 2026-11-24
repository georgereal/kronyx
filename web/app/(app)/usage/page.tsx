"use client";

import { FileJson, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { bucketizeSeries, fmtTok, MultiLineChart } from "@/components/AreaChart";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { Stat } from "@/components/Stat";
import { StatusPill } from "@/components/StatusPill";
import { apiFetch, useRole } from "@/lib/api";
import { fmtCost, fmtDur, host, RangePicker, useUsageCalls, type UsageCall } from "@/lib/usage";

const MODEL_COLORS = ["#a78bfa", "#3ecf8e", "#5b8cff", "#f5a97f", "#f38ba8", "#facc15", "#94a3b8"];

const delta = (cur: number, prev: number) => {
	if (!prev) return undefined;
	const d = ((cur - prev) / prev) * 100;
	return `${d >= 0 ? "↑ +" : "↓ −"}${Math.abs(d).toFixed(0)}%`;
};

function Donut({ rows }: { rows: { label: string; value: number }[] }) {
	const total = rows.reduce((s, r) => s + r.value, 0);
	const R = 52;
	const C = 2 * Math.PI * R;
	let off = 0;
	return (
		<div className="usg-donut">
			<svg viewBox="0 0 140 140" style={{ width: 150, height: 150 }}>
				<circle cx="70" cy="70" r={R} fill="none" stroke="var(--border)" strokeWidth="16" />
				{rows.map((r, i) => {
					const frac = total ? r.value / total : 0;
					const el = (
						<circle
							key={r.label}
							cx="70" cy="70" r={R} fill="none"
							stroke={MODEL_COLORS[i % MODEL_COLORS.length]}
							strokeWidth="16"
							strokeDasharray={`${frac * C} ${C}`}
							strokeDashoffset={-off * C}
							transform="rotate(-90 70 70)"
						/>
					);
					off += frac;
					return el;
				})}
				<text x="70" y="66" textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--fg)">{fmtTok(total)}</text>
				<text x="70" y="82" textAnchor="middle" fontSize="9" fill="var(--muted)">Tokens</text>
			</svg>
			<div className="usg-donut-legend">
				{rows.map((r, i) => (
					<div key={r.label}>
						<i className="dot" style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
						<span className="lbl" title={r.label}>{r.label}</span>
						<span className="val">{fmtTok(r.value)} ({total ? ((r.value / total) * 100).toFixed(1) : 0}%)</span>
					</div>
				))}
			</div>
		</div>
	);
}

const sum = (cs: UsageCall[], f: (c: UsageCall) => number) => cs.reduce((s, c) => s + f(c), 0);
const avg = (cs: UsageCall[], f: (c: UsageCall) => number) => (cs.length ? sum(cs, f) / cs.length : 0);
const median = (cs: UsageCall[], f: (c: UsageCall) => number) => {
	if (!cs.length) return 0;
	const vs = cs.map(f).sort((a, b) => a - b);
	return vs[Math.floor(vs.length / 2)];
};

function AggTable({ rows, nameLabel }: { rows: { key: string; sub?: string; calls: UsageCall[] }[]; nameLabel: string }) {
	const maxTot = Math.max(1, ...rows.map((r) => sum(r.calls, (c) => c.tokensIn + c.tokensOut)));
	return (
		<div className="card table-card">
			<table className="sbx-table">
				<thead>
					<tr><th>{nameLabel}</th><th>Requests</th><th>Tokens in</th><th>Tokens out</th><th>Cached</th><th>Cost est.</th><th>Billed</th><th>Median dur.</th><th>Share</th></tr>
				</thead>
				<tbody>
					{rows.map((r) => {
						const tot = sum(r.calls, (c) => c.tokensIn + c.tokensOut);
						const cached = sum(r.calls, (c) => c.cacheRead);
						const est = sum(r.calls, (c) => c.costUsd ?? 0);
						const billed = sum(r.calls, (c) => c.billedCostUsd ?? 0);
						return (
							<tr key={r.key}>
								<td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.key}>
									{r.sub ? <><span className="muted" style={{ fontSize: 11 }}>{r.sub}</span> {r.key}</> : r.key}
								</td>
								<td className="num">{r.calls.length.toLocaleString()}</td>
								<td className="num">{fmtTok(sum(r.calls, (c) => c.tokensIn))}</td>
								<td className="num">{fmtTok(sum(r.calls, (c) => c.tokensOut))}</td>
								<td className="num muted">{tot ? `${Math.round((cached / tot) * 100)}%` : "—"}</td>
								<td className="num">{fmtCost(est || null)}</td>
								<td className="num">{fmtCost(billed || null)}</td>
								<td className="num">{fmtDur(Math.round(median(r.calls, (c) => c.durationMs)))}</td>
								<td style={{ width: 120 }}><span className="track" style={{ display: "block", height: 8, borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)" }}><span style={{ display: "block", height: "100%", borderRadius: 4, background: "var(--accent)", width: `${(tot / maxTot) * 100}%` }} /></span></td>
							</tr>
						);
					})}
				</tbody>
			</table>
			{!rows.length && <Empty>No data in this range.</Empty>}
		</div>
	);
}

export default function UsagePage() {
	const [range, setRange] = useState(86_400_000 * 7);
	const [model, setModel] = useState("");
	const [provider, setProvider] = useState("");
	const [status, setStatus] = useState("");
	const [search, setSearch] = useState("");
	const [cachedOnly, setCachedOnly] = useState(false);
	const [allUsers, setAllUsers] = useState(false);
	const [tab, setTab] = useState<"requests" | "model" | "task" | "provider" | "cost">("requests");
	const [expanded, setExpanded] = useState<number | null>(null);
	const [expandedTask, setExpandedTask] = useState<string | null>(null);
	const [limit, setLimit] = useState(200);
	const [copied, setCopied] = useState(false);
	const { calls, loading, reload, user, userNames } = useUsageCalls(range ? range * 2 : 0, allUsers);
	const role = useRole(user);
	const isAdmin = role === "admin";
	const [pricing, setPricing] = useState<Record<string, { input?: number; output?: number }>>({});

	useEffect(() => {
		if (!user) return;
		void apiFetch("/api/models/pricing", user)
			.then(async (r) => (r.ok ? setPricing(((await r.json()) as { pricing?: typeof pricing }).pricing ?? {}) : undefined))
			.catch(() => undefined);
	}, [user]);

	const sinceMs = range ? Date.now() - range : 0;
	const cur = useMemo(() => (range ? calls.filter((c) => new Date(c.at).getTime() >= sinceMs) : calls), [calls, range, sinceMs]);
	const prev = useMemo(() => (range ? calls.filter((c) => new Date(c.at).getTime() < sinceMs) : []), [calls, range, sinceMs]);

	const downloadReport = async (runId: string) => {
		if (!user) return;
		const res = await apiFetch(`/api/runs/${runId}/report`, user);
		if (!res.ok) return;
		const { report } = (await res.json()) as { report: unknown };
		const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `run-${runId.slice(0, 12)}-report.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const models = useMemo(() => [...new Set(cur.map((c) => c.model).filter(Boolean))].sort(), [cur]);
	const providers = useMemo(() => [...new Set(cur.map((c) => host(c.baseUrl) || c.provider).filter(Boolean))].sort(), [cur]);
	const filtered = useMemo(
		() =>
			cur.filter(
				(c) =>
					(!model || c.model === model) &&
					(!provider || (host(c.baseUrl) || c.provider) === provider) &&
					(!status || c.status === status) &&
					(!cachedOnly || c.cacheRead > 0 || (c.cacheWrite ?? 0) > 0) &&
					(!search || `${c.model} ${c.runId ?? ""} ${c.session ?? ""} ${c.task ?? ""}`.toLowerCase().includes(search.toLowerCase())),
			),
		[cur, model, provider, status, cachedOnly, search],
	);
	const visible = filtered.slice(0, limit);

	const tin = sum(filtered, (c) => c.tokensIn);
	const tout = sum(filtered, (c) => c.tokensOut);
	const costKnown = filtered.filter((c) => c.costUsd !== null);
	const cost = sum(costKnown, (c) => c.costUsd ?? 0);
	const avgDur = Math.round(avg(filtered, (c) => c.durationMs));
	const [inB, outB] = bucketizeSeries(filtered, (c) => new Date(c.at).getTime(), [(c) => c.tokensIn, (c) => c.tokensOut], 36);

	const modelRows = useMemo(() => {
		const m = new Map<string, UsageCall[]>();
		for (const c of filtered) m.set(c.model || "unknown", [...(m.get(c.model || "unknown") ?? []), c]);
		return [...m.entries()].map(([key, calls]) => ({ key, calls })).sort((a, b) => sum(b.calls, (c) => c.tokensIn + c.tokensOut) - sum(a.calls, (c) => c.tokensIn + c.tokensOut));
	}, [filtered]);
	// One run = one user task; rows without a runId (embedding/manual ops) fall back to session.
	const taskRows = useMemo(() => {
		const m = new Map<string, UsageCall[]>();
		for (const c of filtered) {
			const k = c.runId || c.session || "—";
			m.set(k, [...(m.get(k) ?? []), c]);
		}
		return [...m.entries()]
			.map(([key, calls]) => ({
				key,
				task: calls.find((c) => c.task)?.task || key,
				when: Math.max(...calls.map((c) => new Date(c.at).getTime())),
				runId: calls.find((c) => c.runId)?.runId,
				calls,
			}))
			.sort((a, b) => sum(b.calls, (c) => c.tokensIn + c.tokensOut) - sum(a.calls, (c) => c.tokensIn + c.tokensOut));
	}, [filtered]);
	const providerRows = useMemo(() => {
		const m = new Map<string, UsageCall[]>();
		for (const c of filtered) {
			const k = host(c.baseUrl) || c.provider || "unknown";
			m.set(k, [...(m.get(k) ?? []), c]);
		}
		return [...m.entries()].map(([key, calls]) => ({ key, calls })).sort((a, b) => sum(b.calls, (c) => c.costUsd ?? 0) - sum(a.calls, (c) => c.costUsd ?? 0));
	}, [filtered]);

	const csv = () => {
		const rows = [["time,status,model,provider,tokensIn,tokensOut,cacheRead,cacheWrite,costEst,billed,durationMs,runId,session,task"].join(",")];
		const csvEsc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
		for (const c of filtered)
			rows.push([c.at, c.status, c.model, host(c.baseUrl) || c.provider, c.tokensIn, c.tokensOut, c.cacheRead, c.cacheWrite ?? 0, c.costUsd ?? "", c.billedCostUsd ?? "", c.durationMs, c.runId ?? "", c.session ?? "", csvEsc(c.task ?? "")].join(","));
		const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `usage-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const copyRow = (c: UsageCall) => {
		void navigator.clipboard.writeText(JSON.stringify(c, null, 2));
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<>
			<div className="sbx-head" style={{ marginBottom: 14 }}>
				<h1>Token Usage</h1>
				<div className="sub">Track token consumption, cost and performance across models and runs.</div>
			</div>
			<div className="section-head" style={{ marginTop: 0 }}>
				<RangePicker value={range} onChange={setRange} />
				<button className="sbx-btn" onClick={() => void reload()} disabled={loading}>⟳ Refresh</button>
			</div>

			{loading && !calls.length ? (
				<div className="stat-grid">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={88} />)}</div>
			) : (
				<div className="stat-grid">
					<Stat label="Total Requests" value={filtered.length.toLocaleString()} sub={delta(filtered.length, prev.length)} />
					<Stat label="Total Tokens" value={fmtTok(tin + tout)} sub={delta(tin + tout, sum(prev, (c) => c.tokensIn + c.tokensOut))} />
					<Stat label="Input Tokens" value={fmtTok(tin)} sub={delta(tin, sum(prev, (c) => c.tokensIn))} />
					<Stat label="Output Tokens" value={fmtTok(tout)} sub={delta(tout, sum(prev, (c) => c.tokensOut))} />
					<Stat label="Total Cost (Est.)" value={fmtCost(cost || null)} sub={delta(cost, sum(prev, (c) => c.costUsd ?? 0))} />
					<Stat label="Avg. Duration" value={fmtDur(avgDur)} sub={delta(avgDur, avg(prev, (c) => c.durationMs))} />
				</div>
			)}

			<div className="mem-cards" style={{ gridTemplateColumns: "3fr 2fr" }}>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title" style={{ display: "flex", justifyContent: "space-between" }}>
						Token Usage Over Time
						<span className="sbx-legend">
							<span><i className="dot" style={{ background: "#a78bfa" }} /> Input ({fmtTok(tin)})</span>
							<span><i className="dot" style={{ background: "#3ecf8e" }} /> Output ({fmtTok(tout)})</span>
						</span>
					</div>
					<MultiLineChart series={[{ label: "in", color: "#a78bfa", buckets: inB }, { label: "out", color: "#3ecf8e", buckets: outB }]} height={170} />
				</div>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title">Usage by Model</div>
					<Donut rows={modelRows.slice(0, 7).map((r) => ({ label: r.key, value: sum(r.calls, (c) => c.tokensIn + c.tokensOut) }))} />
				</div>
			</div>

			<div className="sbx-tabs-line" style={{ marginTop: 18 }}>
				{([
					["requests", `Requests (${filtered.length.toLocaleString()})`],
					["model", "By Model"],
					["task", "By Task"],
					["provider", "By Provider"],
					["cost", "Cost Analysis"],
				] as const).map(([t, label]) => (
					<button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{label}</button>
				))}
			</div>

			{tab === "requests" && (
				<>
					<div className="mem-filters card" style={{ borderBottom: 0, marginTop: 0 }}>
						<div style={{ position: "relative", flex: 1, minWidth: 200 }}>
							<Search size={13} style={{ position: "absolute", left: 9, top: 8, color: "var(--muted)" }} />
							<input placeholder="Search by run, task or model…" style={{ paddingLeft: 28, width: "100%" }} value={search} onChange={(e) => setSearch(e.target.value)} />
						</div>
						<select value={model} onChange={(e) => setModel(e.target.value)}>
							<option value="">All Models</option>
							{models.map((m) => <option key={m} value={m}>{m}</option>)}
						</select>
						<select value={provider} onChange={(e) => setProvider(e.target.value)}>
							<option value="">All Providers</option>
							{providers.map((p) => <option key={p} value={p}>{p}</option>)}
						</select>
						<select value={status} onChange={(e) => setStatus(e.target.value)}>
							<option value="">All Statuses</option>
							<option value="ok">ok</option>
							<option value="failed">failed</option>
						</select>
						<label className="muted" style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
							<input type="checkbox" checked={cachedOnly} onChange={(e) => setCachedOnly(e.target.checked)} /> Show cached
						</label>
						{isAdmin && (
							<label className="muted" style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }} title="Aggregate usage across all users">
								<input type="checkbox" checked={allUsers} onChange={(e) => setAllUsers(e.target.checked)} /> All users
							</label>
						)}
						<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
							<span className="muted" style={{ fontSize: 11 }}>{filtered.length.toLocaleString()} requests</span>
							<button className="sbx-btn" title="Export CSV" onClick={csv}>⇩</button>
						</span>
					</div>

					<div className="card table-card" style={{ marginTop: 0 }}>
						<table className="sbx-table">
							<thead>
								<tr>
									<th style={{ width: 26 }}></th>
									<th>Time</th><th>Status</th><th>Model</th><th>Provider</th><th>Usage (in → out)</th><th>Cached</th><th>Turn</th><th>Duration</th><th>Cost (est.)</th><th>Billed</th>{allUsers && <th>User</th>}<th></th>
								</tr>
							</thead>
							<tbody>
								{visible.map((c, i) => {
									const open = expanded === i;
									const totIn = c.tokensIn || 1;
									const cachePct = Math.round((c.cacheRead / totIn) * 100);
									const savings = c.costUsd != null && c.billedCostUsd != null ? c.costUsd - c.billedCostUsd : null;
									return (
										<>
											<tr key={i} onClick={() => setExpanded(open ? null : i)} style={{ cursor: "pointer" }}>
												<td className="muted">{open ? "▾" : "▸"}</td>
												<td className="muted" style={{ whiteSpace: "nowrap" }}>{new Date(c.at).toLocaleString()}</td>
												<td><StatusPill status={c.status} /></td>
												<td style={{ fontSize: 11.5 }}>
													{c.model}
													{c.kind === "embedding" && <span className="sess-chip muted" style={{ marginLeft: 6, fontSize: 10 }}>emb</span>}
												</td>
												<td className="muted">{host(c.baseUrl) || c.provider}</td>
												<td className="num">{fmtTok(c.tokensIn)} → {fmtTok(c.tokensOut)}{(c.reasoningTokens ?? 0) > 0 && <span className="muted"> ·{fmtTok(c.reasoningTokens!)}↯</span>}</td>
												<td className="muted">{c.cacheRead > 0 ? `${fmtTok(c.cacheRead)} (${cachePct}%)` : "—"}</td>
												<td className="muted">{c.iteration != null ? `#${c.iteration}` : "—"}</td>
												<td className="muted">{fmtDur(c.durationMs)}</td>
												<td className="num">{fmtCost(c.costUsd)}</td>
												<td className="num muted">{fmtCost(c.billedCostUsd ?? null)}</td>
												{allUsers && <td className="muted">{(c.uid && (userNames[c.uid]?.name ?? userNames[c.uid]?.email)) ?? (c.uid ? c.uid.slice(0, 8) : "—")}</td>}
												<td onClick={(e) => e.stopPropagation()}>
													{c.runId && <button className="btn ghost sm" title="Download run report" onClick={() => void downloadReport(c.runId!)}><FileJson size={13} /></button>}
												</td>
											</tr>
											{open && (
												<tr>
													<td colSpan={13} style={{ background: "var(--bg)", padding: 14 }}>
														<div className="cmp-detail" style={{ gridTemplateColumns: "230px minmax(0,1.2fr) 200px 190px" }}>
															<div>
																<div className="chart-title" style={{ marginBottom: 8 }}>Request Details</div>
																{([
																	["Run", c.runId ? c.runId.slice(0, 14) : "—"],
																	["Session", c.session ? c.session.slice(0, 12) : "—"],
																	["Window", c.contextWindow ? fmtTok(c.contextWindow) : "—"],
																	["Turn", c.iteration != null ? `#${c.iteration}` : "—"],
																	["Messages", c.contextMsgs != null ? String(c.contextMsgs) : "—"],
																	["Key", c.keyLabel || "—"],
																	["Device", c.device || "—"],
																] as const).map(([k, v]) => (
																	<div key={k} className="sbx-kv"><span className="k">{k}</span><span className="mono" style={{ fontSize: 11 }}>{v}</span></div>
																))}
																{c.runId && <Link href={`/runs/${c.runId}`} className="muted" style={{ fontSize: 11 }}>Open run ›</Link>}
															</div>
															<div>
																<div className="chart-title" style={{ marginBottom: 8 }}>Token Breakdown</div>
																<div className="sbx-bar" style={{ height: 16, marginBottom: 8 }}>
																	<div className="seg running" style={{ width: `${(c.tokensIn / totIn) * 100}%` }} />
																	<div className="seg" style={{ width: `${(c.tokensOut / totIn) * 100}%`, background: "#3ecf8e" }} />
																	<div className="seg" style={{ width: `${(c.cacheRead / totIn) * 100}%`, background: "var(--warn)" }} />
																</div>
																{([
																	["Input tokens", c.tokensIn, "var(--ok)"],
																	["Output tokens", c.tokensOut, "#3ecf8e"],
																	["Cached tokens", c.cacheRead, "var(--warn)"],
																	...(c.cacheWrite ? [["Cache write", c.cacheWrite ?? 0, "var(--muted)"] as const] : []),
																	...(c.reasoningTokens ? [["Reasoning", c.reasoningTokens ?? 0, "#a78bfa"] as const] : []),
																] as const).map(([k, v, col]) => (
																	<div key={k} className="usg-break">
																		<i className="dot" style={{ background: String(col) }} />
																		<span>{k}</span>
																		<span className="val">{v.toLocaleString()} ({((v / totIn) * 100).toFixed(1)}%)</span>
																	</div>
																))}
															</div>
															<div>
																<div className="chart-title" style={{ marginBottom: 8 }}>Cost</div>
																{([
																	["Estimated", fmtCost(c.costUsd)],
																	["Billed", fmtCost(c.billedCostUsd ?? null)],
																	["Savings (cache)", savings != null && savings > 0 ? `${fmtCost(savings)} (${Math.round((savings / (c.costUsd ?? 1)) * 100)}%)` : "—"],
																] as const).map(([k, v]) => (
																	<div key={k} className="sbx-kv"><span className="k">{k}</span><span className="mono" style={{ fontSize: 11 }}>{v}</span></div>
																))}
															</div>
															<div>
																<div className="chart-title" style={{ marginBottom: 8 }}>Performance</div>
																{([
																	["Duration", fmtDur(c.durationMs)],
																	["Status", c.status],
																] as const).map(([k, v]) => (
																	<div key={k} className="sbx-kv"><span className="k">{k}</span><span className="mono" style={{ fontSize: 11 }}>{v}</span></div>
																))}
																<button className="sbx-btn" style={{ marginTop: 8 }} onClick={() => copyRow(c)}>{copied ? "✓ Copied" : "⧉ Copy JSON"}</button>
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
						{filtered.length === 0 && !loading && <Empty>No requests match your filters.</Empty>}
					</div>
					{filtered.length > limit && (
						<div style={{ textAlign: "center", marginTop: 16 }}>
							<button className="btn ghost" onClick={() => setLimit((l) => l + 200)}>Load more ({filtered.length - limit} remaining)</button>
						</div>
					)}
				</>
			)}

			{tab === "model" && <AggTable rows={modelRows} nameLabel="Model" />}
			{tab === "task" && (
				<div className="card table-card">
					<table className="sbx-table">
						<thead>
							<tr><th style={{ width: 26 }}></th><th>Task</th><th>When</th><th>Requests</th><th>Tokens in</th><th>Tokens out</th><th>Cached</th><th>Cost est.</th><th>Billed</th><th>Median dur.</th><th>Share</th></tr>
						</thead>
						<tbody>
							{(() => {
								const maxTot = Math.max(1, ...taskRows.map((r) => sum(r.calls, (c) => c.tokensIn + c.tokensOut)));
								return taskRows.map((r) => {
									const tot = sum(r.calls, (c) => c.tokensIn + c.tokensOut);
									const cached = sum(r.calls, (c) => c.cacheRead);
									const est = sum(r.calls, (c) => c.costUsd ?? 0);
									const billed = sum(r.calls, (c) => c.billedCostUsd ?? 0);
									const label = r.task.length > 80 ? `${r.task.slice(0, 80)}…` : r.task;
									const open = expandedTask === r.key;
									return (
										<>
											<tr key={r.key} onClick={() => setExpandedTask(open ? null : r.key)} style={{ cursor: "pointer" }}>
												<td className="muted">{open ? "▾" : "▸"}</td>
												<td style={{ maxWidth: 340 }} title={r.task}>
													<div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
													<div className="muted" style={{ fontSize: 10.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
														{r.key !== "—" && r.key !== r.task ? `${r.key.slice(0, 12)}` : ""}
														{r.runId && <> · <Link href={`/runs/${r.runId}`} onClick={(e) => e.stopPropagation()}>open run ›</Link></>}
													</div>
												</td>
												<td className="muted" style={{ whiteSpace: "nowrap" }}>{new Date(r.when).toLocaleString()}</td>
												<td className="num">{r.calls.length.toLocaleString()}</td>
												<td className="num">{fmtTok(sum(r.calls, (c) => c.tokensIn))}</td>
												<td className="num">{fmtTok(sum(r.calls, (c) => c.tokensOut))}</td>
												<td className="num muted">{tot ? `${Math.round((cached / tot) * 100)}%` : "—"}</td>
												<td className="num">{fmtCost(est || null)}</td>
												<td className="num">{fmtCost(billed || null)}</td>
												<td className="num">{fmtDur(Math.round(median(r.calls, (c) => c.durationMs)))}</td>
												<td style={{ width: 120 }}><span className="track" style={{ display: "block", height: 8, borderRadius: 4, background: "var(--bg)", border: "1px solid var(--border)" }}><span style={{ display: "block", height: "100%", borderRadius: 4, background: "var(--accent)", width: `${(tot / maxTot) * 100}%` }} /></span></td>
											</tr>
											{open && (
												<tr>
													<td colSpan={11} style={{ background: "var(--bg)", padding: "6px 14px 12px" }}>
														<table className="sbx-table" style={{ margin: 0 }}>
															<thead>
																<tr><th>Turn</th><th>Time</th><th>Status</th><th>Model</th><th>Provider</th><th>Usage (in → out)</th><th>Cached</th><th>Duration</th><th>Cost (est.)</th><th>Billed</th></tr>
															</thead>
															<tbody>
																{[...r.calls]
																	.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
																	.map((c, j) => (
																		<tr key={j}>
																			<td className="muted">{c.iteration != null ? `#${c.iteration}` : "—"}</td>
																			<td className="muted" style={{ whiteSpace: "nowrap" }}>{new Date(c.at).toLocaleTimeString()}</td>
																			<td><StatusPill status={c.status} /></td>
																			<td style={{ fontSize: 11.5 }}>{c.model}{c.kind === "embedding" && <span className="sess-chip muted" style={{ marginLeft: 6, fontSize: 10 }}>emb</span>}</td>
																			<td className="muted">{host(c.baseUrl) || c.provider}</td>
																			<td className="num">{fmtTok(c.tokensIn)} → {fmtTok(c.tokensOut)}{(c.reasoningTokens ?? 0) > 0 && <span className="muted"> ·{fmtTok(c.reasoningTokens!)}↯</span>}</td>
																			<td className="muted">{c.cacheRead > 0 ? fmtTok(c.cacheRead) : "—"}</td>
																			<td className="muted">{fmtDur(c.durationMs)}</td>
																			<td className="num">{fmtCost(c.costUsd)}</td>
																			<td className="num muted">{fmtCost(c.billedCostUsd ?? null)}</td>
																		</tr>
																	))}
															</tbody>
														</table>
													</td>
												</tr>
											)}
										</>
									);
								});
							})()}
						</tbody>
					</table>
					{!taskRows.length && <Empty>No data in this range.</Empty>}
				</div>
			)}
			{tab === "provider" && <AggTable rows={providerRows} nameLabel="Provider" />}

			{tab === "cost" && (
				<div className="mem-cards" style={{ gridTemplateColumns: "3fr 2fr" }}>
					<div className="card table-card">
						<div className="chart-title" style={{ padding: "12px 12px 0" }}>Cost Efficiency by Model</div>
						<table className="sbx-table">
							<thead>
								<tr><th>Model</th><th>Requests</th><th>In / Out</th><th>Cached</th><th>Billed</th><th>Published</th><th>Actual $/1M</th><th>$/request</th><th>Cache saved</th></tr>
							</thead>
							<tbody>
								{modelRows.map((r) => {
									const toks = sum(r.calls, (c) => c.tokensIn + c.tokensOut);
									const cached = sum(r.calls, (c) => c.cacheRead);
									const est = sum(r.calls, (c) => c.costUsd ?? 0);
									const billed = sum(r.calls, (c) => c.billedCostUsd ?? 0);
									const priced = r.calls.some((c) => c.billedCostUsd != null);
									const perTok = billed && toks ? `$${((billed / toks) * 1e6).toFixed(2)}` : null;
									const saved = Math.max(0, est - billed);
									return (
										<tr key={r.key}>
											<td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.key}>{r.key}</td>
											<td className="num">{r.calls.length.toLocaleString()}</td>
											<td className="num">{fmtTok(sum(r.calls, (c) => c.tokensIn))} / {fmtTok(sum(r.calls, (c) => c.tokensOut))}</td>
											<td className="num muted" title="cache-read tokens">{cached ? `${fmtTok(cached)} (${Math.round((cached / (toks || 1)) * 100)}%)` : "—"}</td>
											<td className="num">{priced ? fmtCost(billed || null) : "—"}{est ? <span className="muted" style={{ fontSize: 10 }}> / {fmtCost(est)}</span> : null}</td>
											<td className="num muted" style={{ fontSize: 10.5 }} title="published rate (in / out per 1M tokens)">
												{pricing[r.key]?.input != null ? `$${pricing[r.key].input!.toFixed(2)} / $${(pricing[r.key].output ?? 0).toFixed(2)}` : "—"}
											</td>
											<td className="num">{perTok ?? "—"}</td>
											<td className="num">{billed && r.calls.length ? fmtCost(billed / r.calls.length) : "—"}</td>
											<td className="num muted">{saved > 0 ? `${fmtCost(saved)} (${Math.round((saved / est) * 100)}%)` : "—"}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
						<div className="muted" style={{ fontSize: 11, padding: "8px 12px" }}>$/1M tok = billed ÷ total tokens (blended in+out, after cache discount). Grey value = est. cost when no bill is recorded.</div>
					</div>
					<div className="card" style={{ padding: 16 }}>
						<div className="chart-title" style={{ marginBottom: 10 }}>Cache Savings</div>
						{(() => {
							const est = sum(filtered, (c) => c.costUsd ?? 0);
							const billed = sum(filtered, (c) => c.billedCostUsd ?? 0);
							const saved = Math.max(0, est - billed);
							const priced = filtered.filter((c) => c.billedCostUsd != null).length;
							const toks = sum(filtered, (c) => c.tokensIn + c.tokensOut);
							return (
								<>
									{([
										["Estimated total", fmtCost(est || null)],
										["Billed total", fmtCost(billed || null)],
										["Saved via cache", `${fmtCost(saved || null)}${est ? ` (${Math.round((saved / est) * 100)}%)` : ""}`],
										["Cache-read tokens", fmtTok(sum(filtered, (c) => c.cacheRead))],
										["Blended $/1M tok", billed && toks ? `$${((billed / toks) * 1e6).toFixed(2)}` : "—"],
										["Requests priced", `${priced} / ${filtered.length}`],
									] as const).map(([k, v]) => (
										<div key={k} className="sbx-kv"><span className="k">{k}</span><span className="mono" style={{ fontSize: 12 }}>{v}</span></div>
									))}
									{(() => {
										const perModel = modelRows
											.map((r) => {
												const est = sum(r.calls, (c) => c.costUsd ?? 0);
												const billed = sum(r.calls, (c) => c.billedCostUsd ?? 0);
												const toks = sum(r.calls, (c) => c.tokensIn + c.tokensOut);
												return { key: r.key, saved: Math.max(0, est - billed), est, effTok: billed && toks ? (billed / toks) * 1e6 : null };
											})
											.filter((m) => m.saved > 0 || m.effTok != null)
											.sort((a, b) => b.saved - a.saved)
											.slice(0, 6);
										const maxSaved = perModel[0]?.saved ?? 1;
										if (!perModel.length) return null;
										return (
											<>
												<div className="chart-title" style={{ margin: "14px 0 8px", fontSize: 11 }}>Savings by Model</div>
												{perModel.map((m) => (
													<div key={m.key} className="cmp-bar-row" style={{ marginBottom: 6 }}>
														<span className="lbl" title={m.key}>{m.key}</span>
														<span className="track"><span className="fill" style={{ width: `${(m.saved / maxSaved) * 100}%` }} /></span>
														<span className="val">
															{fmtCost(m.saved)}{m.est ? ` (${Math.round((m.saved / m.est) * 100)}%)` : ""}
															{m.effTok != null && <span className="muted"> · ${m.effTok.toFixed(2)}/1M</span>}
															{pricing[m.key]?.input != null && <span className="muted"> vs ${pricing[m.key].input!.toFixed(2)}</span>}
														</span>
													</div>
												))}
											</>
										);
									})()}
								</>
							);
						})()}
					</div>
				</div>
			)}
		</>
	);
}
