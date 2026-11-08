"use client";

import { useEffect, useState } from "react";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { apiFetch, useUser } from "@/lib/api";

interface LiveVm { sandboxId: string; templateId?: string; state?: string; startedAt?: string }
interface Hist { sandboxId?: string; device?: string; deviceId?: string; template?: string; repo?: string; runId?: string; event?: string; at?: string }

const fmt = (v?: string) => (v ? new Date(v).toLocaleString() : "—");

export default function SandboxesPage() {
	const user = useUser();
	const [live, setLive] = useState<LiveVm[]>([]);
	const [history, setHistory] = useState<Hist[]>([]);
	const [liveEnabled, setLiveEnabled] = useState(false);
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState("");

	const load = async () => {
		if (!user) return;
		const res = await apiFetch("/api/sandboxes", user);
		if (res.ok) {
			const b = (await res.json()) as { live: LiveVm[]; history: Hist[]; liveEnabled: boolean };
			setLive(b.live); setHistory(b.history); setLiveEnabled(b.liveEnabled);
		}
		setLoading(false);
	};
	useEffect(() => { void load(); /* eslint-disable-next-line */ }, [user]);

	const stop = async (id: string) => {
		if (!user) return;
		setMsg(`Stopping ${id.slice(0, 8)}…`);
		const res = await apiFetch(`/api/sandboxes/${id}`, user, { method: "DELETE" });
		setMsg(res.ok ? "Stopped." : "Stop failed.");
		void load();
	};

	if (!user) return null;
	const devs = new Map<string, number>();
	for (const h of history) if (h.device) devs.set(h.device, (devs.get(h.device) ?? 0) + 1);

	return (
		<div className="page">
			<h1>Sandboxes</h1>
			<div className="stat-grid" style={{ marginBottom: 20 }}>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title">Live</div>
					<div style={{ fontSize: 28, fontWeight: 700 }}>{liveEnabled ? live.length : "—"}</div>
					<div className="muted" style={{ fontSize: 12 }}>{liveEnabled ? `${live.filter((v) => v.state === "running").length} running` : "sync E2B key for live view"}</div>
				</div>
				{[...devs.entries()].map(([d, n]) => (
					<div key={d} className="card" style={{ padding: 16 }}>
						<div className="chart-title">{d}</div>
						<div style={{ fontSize: 28, fontWeight: 700 }}>{n}</div>
						<div className="muted" style={{ fontSize: 12 }}>lifecycle events</div>
					</div>
				))}
			</div>

			{loading && <Skeleton height={200} />}
			{!loading && live.length === 0 && history.length === 0 && <Empty>No sandboxes yet — start a cloud run.</Empty>}

			{live.length > 0 && (
				<div className="card table-card" style={{ marginBottom: 20 }}>
					<table>
						<thead><tr><th>Sandbox</th><th>Template</th><th>State</th><th>Started</th><th></th></tr></thead>
						<tbody>
							{live.map((v) => {
								const id = v.sandboxId ?? (v as unknown as { sandboxID?: string }).sandboxID ?? "";
								return (
								<tr key={id}>
									<td className="mono">{id.slice(0, 16)}</td>
									<td className="muted">{v.templateId || "base"}</td>
									<td>{v.state ?? "running"}</td>
									<td className="muted">{fmt(v.startedAt)}</td>
									<td><button className="btn danger sm" onClick={() => void stop(id)}>Stop</button></td>
								</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{history.length > 0 && (
				<div className="card table-card">
					<table>
						<thead><tr><th>Sandbox</th><th>Event</th><th>Device</th><th>Repo</th><th>Template</th><th>Time</th></tr></thead>
						<tbody>
							{history.map((h, i) => (
								<tr key={i}>
									<td className="mono">{(h.sandboxId ?? "").slice(0, 16)}</td>
									<td>{h.event}</td>
									<td className="muted">{h.device || "—"}</td>
									<td className="muted">{h.repo || "—"}</td>
									<td className="muted">{h.template || "base"}</td>
									<td className="muted">{fmt(h.at)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{msg && <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>{msg}</p>}
		</div>
	);
}
