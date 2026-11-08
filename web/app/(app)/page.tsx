"use client";

import { ArrowDownToLine, ArrowUpFromLine, DollarSign, Zap } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AreaChart, bucketize, fmtTok } from "@/components/AreaChart";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { Stat } from "@/components/Stat";
import { StatusPill } from "@/components/StatusPill";
import { apiFetch } from "@/lib/api";
import { fmtCost, RangePicker, useUsageCalls } from "@/lib/usage";

export default function Overview() {
	const [range, setRange] = useState(86_400_000);
	const { calls, loading, user } = useUsageCalls(range);
	const [devices, setDevices] = useState<{ id: string; name: string; lastSyncAt: string }[]>([]);
	const [settingsAt, setSettingsAt] = useState("");

	useEffect(() => {
		if (!user) return;
		void (async () => {
			const res = await apiFetch("/api/settings", user);
			if (!res.ok) return;
			const body = (await res.json()) as {
				devices?: Record<string, { name?: string; lastSyncAt?: string }>;
				settings?: { updatedAt?: string };
			};
			setDevices(
				Object.entries(body.devices ?? {}).map(([id, d]) => ({
					id,
					name: d.name || id.slice(0, 8),
					lastSyncAt: d.lastSyncAt ?? "",
				})),
			);
			setSettingsAt(body.settings?.updatedAt ?? "");
		})();
	}, [user]);

	const tin = calls.reduce((s, c) => s + c.tokensIn, 0);
	const tout = calls.reduce((s, c) => s + c.tokensOut, 0);
	const costKnown = calls.filter((c) => c.costUsd !== null);
	const cost = costKnown.reduce((s, c) => s + (c.costUsd ?? 0), 0);
	const buckets = bucketize(calls, (c) => new Date(c.at).getTime(), (c) => c.tokensIn + c.tokensOut);

	const byModel = new Map<string, { tokens: number; calls: number }>();
	for (const c of calls) {
		const m = byModel.get(c.model) ?? { tokens: 0, calls: 0 };
		m.tokens += c.tokensIn + c.tokensOut;
		m.calls += 1;
		byModel.set(c.model, m);
	}
	const topModels = [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 5);
	const maxModelTok = topModels[0]?.[1].tokens ?? 1;

	return (
		<>
			<div className="section-head" style={{ marginTop: 0 }}>
				<h1>Overview</h1>
				<RangePicker value={range} onChange={setRange} />
			</div>

			{loading && calls.length === 0 ? (
				<div className="stat-grid">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={88} />)}</div>
			) : (
				<div className="stat-grid">
					<Stat icon={<Zap size={13} />} label="Requests" value={calls.length.toLocaleString()} />
					<Stat icon={<ArrowDownToLine size={13} />} label="Tokens in" value={fmtTok(tin)} />
					<Stat icon={<ArrowUpFromLine size={13} />} label="Tokens out" value={fmtTok(tout)} />
					<Stat
						icon={<DollarSign size={13} />}
						label="Est. cost"
						value={costKnown.length ? fmtCost(cost) : "—"}
						sub={costKnown.length ? `${costKnown.length}/${calls.length} priced` : "pricing unavailable"}
					/>
				</div>
			)}

			<div className="card chart-wrap">
				<div className="chart-title">Token volume</div>
				<AreaChart buckets={buckets} />
			</div>

			<div className="stat-grid" style={{ gridTemplateColumns: "1fr 2fr", gap: 12 }}>
				<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title">Devices</div>
					{devices.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No devices synced yet.</div>}
					{devices.map((d) => (
						<div key={d.id} className="rank-row">
							<span style={{ flex: 1 }}>{d.name}</span>
							<span className="muted num" style={{ fontSize: 11 }}>
								{d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleDateString() : ""}
							</span>
						</div>
					))}
					{settingsAt && (
						<div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
							Settings synced {new Date(settingsAt).toLocaleString()}
						</div>
					)}
				</div>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title">Top models</div>
					{topModels.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No calls yet.</div>}
					{topModels.map(([model, m]) => (
						<div key={model} className="rank-row">
							<span className="mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
								{model}
							</span>
							<span className="rank-bar" style={{ width: `${Math.max(4, (m.tokens / maxModelTok) * 80)}px` }} />
							<span className="muted num" style={{ width: 48 }}>
								{fmtTok(m.tokens)}
							</span>
						</div>
					))}
				</div>
				</div>
				<div className="card table-card">
					<div className="chart-title" style={{ padding: "16px 16px 8px" }}>
						Recent requests · <Link href="/usage" style={{ color: "var(--accent)" }}>view all →</Link>
					</div>
					<table>
						<tbody>
							{calls.slice(0, 5).map((c, i) => (
								<tr key={i}>
									<td className="muted" style={{ width: 150 }}>
										{new Date(c.at).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
									</td>
									<td style={{ width: 70 }}>
										<StatusPill status={c.status} />
									</td>
									<td className="model-cell">{c.model}</td>
									<td className="num muted">
										{fmtTok(c.tokensIn)} / {fmtTok(c.tokensOut)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{calls.length === 0 && !loading && (
						<Empty>
							No usage yet — run a task in the Kronyx extension with sync enabled, or{" "}
							<Link href="/connect" style={{ color: "var(--accent)" }}>
								connect your editor
							</Link>
							.
						</Empty>
					)}
				</div>
			</div>
		</>
	);
}
