"use client";

import { RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { fmtTok } from "@/components/AreaChart";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { StatusPill } from "@/components/StatusPill";
import { fmtCost, fmtDur, host, RangePicker, useUsageCalls } from "@/lib/usage";

export default function UsagePage() {
	const [range, setRange] = useState(86_400_000);
	const [model, setModel] = useState("");
	const [status, setStatus] = useState("");
	const [search, setSearch] = useState("");
	const { calls, loading, reload } = useUsageCalls(range);
	const [limit, setLimit] = useState(200);

	const models = useMemo(() => [...new Set(calls.map((c) => c.model).filter(Boolean))].sort(), [calls]);
	const filtered = useMemo(
		() =>
			calls.filter(
				(c) =>
					(!model || c.model === model) &&
					(!status || c.status === status) &&
					(!search || c.model.toLowerCase().includes(search.toLowerCase())),
			),
		[calls, model, status, search],
	);
	const visible = filtered.slice(0, limit);

	return (
		<>
			<div className="section-head" style={{ marginTop: 0 }}>
				<h1>Usage</h1>
				<RangePicker value={range} onChange={setRange} />
			</div>

			<div className="filter-bar">
				<div style={{ position: "relative" }}>
					<Search size={13} style={{ position: "absolute", left: 9, top: 7, color: "var(--muted)" }} />
					<input
						className="input"
						placeholder="Filter by model…"
						style={{ paddingLeft: 28, width: 220 }}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				<select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
					<option value="">All models</option>
					{models.map((m) => (
						<option key={m} value={m}>
							{m}
						</option>
					))}
				</select>
				<select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
					<option value="">All statuses</option>
					<option value="ok">ok</option>
					<option value="failed">failed</option>
				</select>
				<span className="spacer" />
				<span className="muted" style={{ fontSize: 11.5 }}>
					{filtered.length} request{filtered.length === 1 ? "" : "s"}
				</span>
				<button className="btn ghost sm" onClick={() => void reload()}>
					<RefreshCw size={13} />
				</button>
			</div>

			<div className="card table-card">
				{loading && filtered.length === 0 ? (
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
								<th>Status</th>
								<th>Model</th>
								<th>Provider</th>
								<th className="num">Usage</th>
								<th className="num">Cost est.</th>
								<th className="num">Duration</th>
								<th>Key</th>
								<th>Device</th>
							</tr>
						</thead>
						<tbody>
							{visible.map((c, i) => {
								const t = new Date(c.at);
								return (
									<tr key={i}>
										<td className="muted">
											{t.toLocaleDateString(undefined, { month: "short", day: "2-digit" }).toUpperCase()}{" "}
											{t.toLocaleTimeString()}
										</td>
										<td>
											<StatusPill status={c.status} />
										</td>
										<td className="model-cell">{c.model}</td>
										<td className="muted">{host(c.baseUrl) || c.provider}</td>
										<td className="num">
											{fmtTok(c.tokensIn)} in · {fmtTok(c.tokensOut)} out
											{c.cacheRead > 0 && <span className="muted"> · {fmtTok(c.cacheRead)}↩</span>}
										</td>
										<td className="num">{fmtCost(c.costUsd)}</td>
										<td className="num">{fmtDur(c.durationMs)}</td>
										<td className="mono muted">{c.keyLabel}</td>
										<td className="muted">{c.device || "—"}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
				{filtered.length === 0 && !loading && <Empty>No requests match your filters.</Empty>}
			</div>

			{filtered.length > limit && (
				<div style={{ textAlign: "center", marginTop: 16 }}>
					<button className="btn ghost" onClick={() => setLimit((l) => l + 200)}>
						Load more ({filtered.length - limit} remaining)
					</button>
				</div>
			)}
		</>
	);
}
