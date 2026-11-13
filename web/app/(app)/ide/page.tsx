"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { Stat } from "@/components/Stat";
import { apiFetch, useUser } from "@/lib/api";
import { fmtDur, RangePicker } from "@/lib/usage";

interface IdeEvent {
	at: string;
	op?: string;
	tool?: string;
	file?: string;
	query?: string;
	direction?: string;
	newName?: string;
	results?: number;
	files?: number;
	defs?: number;
	refs?: number;
	impls?: number;
	edits?: number;
	tookMs?: number;
	before?: { errors: number; warnings: number };
	after?: { errors: number; warnings: number };
	session?: string;
	runId?: string;
	workspace?: string;
	device?: string;
	deviceId?: string;
	[k: string]: unknown;
}

interface IdeResponse {
	events: IdeEvent[];
	tools: Record<string, { calls: number; tookMs: number; results: number }>;
}

const fmt = (v?: string) => (v ? new Date(v).toLocaleString() : "—");

function detail(e: IdeEvent): string {
	const p: string[] = [];
	if (e.file) p.push(e.file);
	if (e.query) p.push(`"${e.query}"`);
	if (e.direction) p.push(e.direction);
	if (e.newName) p.push(`→ ${e.newName}`);
	if (e.results != null) p.push(`${e.results} result${e.results === 1 ? "" : "s"}`);
	if (e.defs != null) p.push(`${e.defs} def`);
	if (e.refs != null) p.push(`${e.refs} ref${e.refs === 1 ? "" : "s"}`);
	if (e.impls != null) p.push(`${e.impls} impl`);
	if (e.files != null) p.push(`${e.files} file${e.files === 1 ? "" : "s"}`);
	if (e.edits != null) p.push(`${e.edits} edit${e.edits === 1 ? "" : "s"}`);
	if (e.before && e.after) {
		const dErr = e.after.errors - e.before.errors;
		const dWarn = e.after.warnings - e.before.warnings;
		p.push(`errors ${dErr >= 0 ? "+" : ""}${dErr} · warnings ${dWarn >= 0 ? "+" : ""}${dWarn}`);
	}
	if (e.tookMs != null) p.push(`${e.tookMs}ms`);
	return p.join(" · ") || "—";
}

export default function IdePage() {
	const user = useUser();
	const [range, setRange] = useState(86_400_000 * 7);
	const [tool, setTool] = useState("");
	const [data, setData] = useState<IdeResponse | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!user) return;
		setLoading(true);
		void (async () => {
			const since = range ? `&since=${Date.now() - range}` : "";
			const res = await apiFetch(`/api/ide?limit=500${since}`, user);
			if (res.ok) setData((await res.json()) as IdeResponse);
			setLoading(false);
		})();
	}, [user, range]);

	const events = data?.events ?? [];
	const toolRows = Object.entries(data?.tools ?? {}).sort((a, b) => b[1].calls - a[1].calls);
	const filtered = tool ? events.filter((e) => (e.tool ?? e.op) === tool) : events;
	const totalCalls = toolRows.reduce((s, [, v]) => s + v.calls, 0);
	const totalMs = toolRows.reduce((s, [, v]) => s + v.tookMs, 0);
	const diagRuns = events.filter((e) => e.op === "diagnostics");
	const errorsAdded = diagRuns.reduce((s, e) => s + ((e.after?.errors ?? 0) - (e.before?.errors ?? 0)), 0);

	return (
		<>
			<div className="section-head" style={{ marginTop: 0 }}>
				<h1>IDE Tools</h1>
				<RangePicker value={range} onChange={setRange} />
			</div>

			<div className="stat-grid">
				<Stat label="Tool calls" value={totalCalls.toLocaleString()} />
				<Stat label="Distinct tools" value={toolRows.length.toLocaleString()} />
				<Stat label="Avg latency" value={totalCalls ? fmtDur(Math.round(totalMs / totalCalls)) : "—"} />
				<Stat label="Diag runs" value={diagRuns.length.toLocaleString()} />
				<Stat label="Errors added" value={diagRuns.length ? String(errorsAdded) : "—"} />
			</div>

			<div className="filter-bar" style={{ marginTop: 12 }}>
				<select className="select" value={tool} onChange={(e) => setTool(e.target.value)}>
					<option value="">All tools</option>
					{toolRows.map(([t]) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
				<span className="spacer" />
				<span className="muted" style={{ fontSize: 11.5 }}>
					{filtered.length} event{filtered.length === 1 ? "" : "s"}
				</span>
			</div>

			{toolRows.length > 0 && (
				<div className="card table-card">
					<table>
						<thead>
							<tr>
								<th>Tool</th>
								<th>Calls</th>
								<th>Results</th>
								<th>Avg latency</th>
							</tr>
						</thead>
						<tbody>
							{toolRows.map(([t, v]) => (
								<tr key={t}>
									<td className="mono">{t}</td>
									<td className="num">{v.calls.toLocaleString()}</td>
									<td className="num">{v.results.toLocaleString()}</td>
									<td className="num">{v.calls ? fmtDur(Math.round(v.tookMs / v.calls)) : "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<div className="card table-card" style={{ marginTop: 12 }}>
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
								<th>Tool</th>
								<th>Detail</th>
								<th>Session</th>
								<th>Workspace</th>
								<th>Device</th>
							</tr>
						</thead>
						<tbody>
							{filtered.map((e, i) => (
								<tr key={i}>
									<td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(e.at)}</td>
									<td className="mono" style={{ fontSize: 11.5 }}>
										{e.tool ?? e.op ?? "—"}
										{e.op === "diagnostics" && <span className="sess-chip muted" style={{ marginLeft: 6, fontSize: 10 }}>run</span>}
									</td>
									<td className="muted" style={{ fontSize: 11.5, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={detail(e)}>
										{detail(e)}
									</td>
									<td className="muted mono">
										{e.session ? e.session.slice(0, 12) : "—"}
										{e.runId && (
											<>
												{" / "}
												<Link href={`/runs/${e.runId}`} style={{ color: "inherit" }}>
													{e.runId.slice(0, 10)}
												</Link>
											</>
										)}
									</td>
									<td className="muted" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.workspace}>
										{e.workspace?.split("/").pop() ?? "—"}
									</td>
									<td className="muted" title={typeof e.deviceId === "string" ? e.deviceId : undefined}>
										{e.device || "—"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{filtered.length === 0 && !loading && (
					<Empty>
						No IDE tool events yet — get_diagnostics, search_symbols, get_symbol_context, get_call_hierarchy and
						rename_symbol calls from the extension appear here once <span className="mono">kronyx.sync.enabled</span> is on.
					</Empty>
				)}
			</div>
		</>
	);
}
