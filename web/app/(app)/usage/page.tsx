"use client";

import { FileJson, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { fmtTok } from "@/components/AreaChart";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { StatusPill } from "@/components/StatusPill";
import { apiFetch, useRole } from "@/lib/api";
import { fmtCost, fmtDur, host, RangePicker, useUsageCalls } from "@/lib/usage";

export default function UsagePage() {
	const [range, setRange] = useState(86_400_000);
	const [model, setModel] = useState("");
	const [status, setStatus] = useState("");
	const [search, setSearch] = useState("");
	const [allUsers, setAllUsers] = useState(false);
	const { calls, loading, reload, user, userNames } = useUsageCalls(range, allUsers);
	const role = useRole(user);
	const isAdmin = role === "admin";
	const [limit, setLimit] = useState(200);

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
				{isAdmin && (
					<label
						className="muted"
						style={{ fontSize: 11.5, display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
						title="Aggregate usage across all users"
					>
						<input type="checkbox" checked={allUsers} onChange={(e) => setAllUsers(e.target.checked)} />
						All users
					</label>
				)}
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
								<th>Usage</th>
								<th>Cached</th>
								<th>Turn</th>
								<th>Cost est.</th>
								<th>Billed</th>
								<th>Duration</th>
								<th>Key</th>
								<th>Device</th>
								{allUsers && <th>User</th>}
								<th></th>
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
										<td className="model-cell">
											{c.model}
											{c.kind === "embedding" && <span className="sess-chip muted" style={{ marginLeft: 6, fontSize: 10 }}>emb{c.op ? `·${c.op.split("_")[1] ?? c.op}` : ""}</span>}
										</td>
										<td className="muted">{host(c.baseUrl) || c.provider}</td>
										<td>
											{fmtTok(c.tokensIn)} in · {fmtTok(c.tokensOut)} out
											{(c.reasoningTokens ?? 0) > 0 && (
												<span className="muted" title="reasoning tokens — the model's internal chain-of-thought (billed as output)">
													{" "}· {fmtTok(c.reasoningTokens!)}↯
												</span>
											)}
										</td>
										<td className="muted" title="prompt-cache read / write tokens">
											{c.cacheRead > 0 || (c.cacheWrite ?? 0) > 0 ? (
												<>
													{c.cacheRead > 0 && <>{fmtTok(c.cacheRead)}↩</>}
													{(c.cacheWrite ?? 0) > 0 && <span> +{fmtTok(c.cacheWrite!)}w</span>}
												</>
											) : "—"}
										</td>
										<td className="muted">
											{c.iteration != null ? `#${c.iteration}` : "—"}
											{c.contextMsgs != null && <span className="muted" title="messages in context"> · {c.contextMsgs}msg</span>}
										</td>
										<td>{fmtCost(c.costUsd)}</td>
										<td>{fmtCost(c.billedCostUsd ?? null)}</td>
										<td>{fmtDur(c.durationMs)}</td>
										<td className="mono muted">{c.keyLabel}</td>
										<td className="muted">{c.device || "—"}</td>
										{allUsers && (
											<td className="muted" title={c.uid}>
												{(c.uid && (userNames[c.uid]?.name ?? userNames[c.uid]?.email)) ?? (c.uid ? c.uid.slice(0, 8) : "—")}
											</td>
										)}
										<td>
											{c.runId && (
												<button
													className="btn ghost sm"
													title={`Download run report (${c.runId.slice(0, 12)})`}
													onClick={() => void downloadReport(c.runId!)}
												>
													<FileJson size={13} />
												</button>
											)}
										</td>
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
