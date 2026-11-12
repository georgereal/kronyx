"use client";

import { useEffect, useState } from "react";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { apiFetch, useUser } from "@/lib/api";

interface LiveVm { sandboxId: string; templateId?: string; state?: string; startedAt?: string }
interface Hist { sandboxId?: string; device?: string; deviceId?: string; template?: string; templateId?: string; repo?: string; runId?: string; event?: string; state?: string; reason?: string; sessionId?: string; at?: string; createdAt?: string }
interface SbxEvent { sandboxId?: string; sessionId?: string; provider?: string; event?: string; state?: string; reason?: string; device?: string; runId?: string; at?: string }
interface ProviderStatus { name: string; configured: boolean; reason?: string }

const fmt = (v?: string) => (v ? new Date(v).toLocaleString() : "—");

export default function SandboxesPage() {
	const user = useUser();
	const [live, setLive] = useState<LiveVm[]>([]);
	const [history, setHistory] = useState<Hist[]>([]);
	const [events, setEvents] = useState<SbxEvent[]>([]);
	const [providers, setProviders] = useState<ProviderStatus[]>([]);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [, setLiveEnabled] = useState(false);
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState("");
	const [tab, setTab] = useState<"live" | "history">("live");

	const load = async () => {
		if (!user) return;
		const res = await apiFetch("/api/sandboxes", user);
		if (res.ok) {
			const b = (await res.json()) as { live: LiveVm[]; history: Hist[]; events?: SbxEvent[]; providers?: ProviderStatus[]; liveEnabled: boolean };
			setLive(b.live); setHistory(b.history); setEvents(b.events ?? []); setProviders(b.providers ?? []); setLiveEnabled(b.liveEnabled);
		}
		setLoading(false);
	};
	useEffect(() => { void load(); /* eslint-disable-next-line */ }, [user]);

	const stop = async (id: string) => {
		if (!user || !confirm(`Kill sandbox ${id.slice(0, 12)}?`)) return;
		setMsg(`Killing ${id.slice(0, 8)}…`);
		const res = await apiFetch(`/api/sandboxes/${id}`, user, { method: "DELETE" });
		setMsg(res.ok ? "Killed." : "Kill failed.");
		void load();
	};

	const pause = async (id: string) => {
		if (!user) return;
		setMsg(`Pausing ${id.slice(0, 8)}…`);
		const res = await apiFetch(`/api/sandboxes/${id}/pause`, user, { method: "POST" });
		setMsg(res.ok ? "Paused." : "Pause failed.");
		void load();
	};

	if (!user) return null;
	const liveRows = history.filter((h) => ["active", "running", "paused"].includes(h.state ?? ""));
	const deadRows = history.filter((h) => !["active", "running", "paused"].includes(h.state ?? ""));
	const eventsFor = (id?: string) => (id ? events.filter((e) => e.sandboxId === id) : []);

	const eventDot = (e?: string) =>
		e === "kill" || e === "stop" ? "var(--err)" : e === "pause" ? "var(--amber, #facc15)" : "var(--ok, #4ade80)";
	const timeline = (list: SbxEvent[]) => (
		<div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "6px 0 4px" }}>
			{list.map((e, i) => (
				<div key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11 }}>
					<span style={{ color: eventDot(e.event) }}>●</span>
					<span style={{ textTransform: "capitalize" }}>{e.event ?? e.state ?? "—"}</span>
					{e.reason && <span className="muted">{e.reason}</span>}
					{e.provider && <span className="muted">{e.provider}</span>}
					{e.device && <span className="muted">{e.device}</span>}
					{e.sessionId && <a className="muted mono" href={`/sessions/${e.sessionId}`}>{e.sessionId.slice(0, 8)}</a>}
					<span className="muted" style={{ marginLeft: "auto" }}>{fmt(e.at)}</span>
				</div>
			))}
			{!list.length && <div className="muted" style={{ fontSize: 11 }}>No events recorded yet.</div>}
		</div>
	);

	return (
		<div className="page">
			<h1>Sandboxes</h1>
			{providers.length > 0 && (
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
					{providers.map((p) => (
						<span
							key={p.name}
							className="sess-chip"
							title={p.configured ? `${p.name} enabled` : p.reason}
							style={{ fontSize: 11, opacity: p.configured ? 1 : 0.6 }}
						>
							{p.name} · {p.configured ? "enabled" : "not configured"}
						</span>
					))}
				</div>
			)}
			<div className="stat-grid" style={{ marginBottom: 20 }}>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title">Live</div>
					<div style={{ fontSize: 28, fontWeight: 700 }}>{liveRows.length}</div>
					<div className="muted" style={{ fontSize: 12 }}>{liveRows.filter((v) => v.state !== "paused").length} running · {liveRows.filter((v) => v.state === "paused").length} paused</div>
				</div>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title">History</div>
					<div style={{ fontSize: 28, fontWeight: 700 }}>{deadRows.length}</div>
					<div className="muted" style={{ fontSize: 12 }}>dead / replaced</div>
				</div>
			</div>

			<div className="sess-tabs" style={{ marginBottom: 14 }}>
				{(["live", "history"] as const).map((t) => (
					<button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
						{t === "live" ? `Live (${liveRows.length})` : `History (${deadRows.length})`}
					</button>
				))}
			</div>

			{loading && <Skeleton height={200} />}
			{!loading && live.length === 0 && history.length === 0 && <Empty>No sandboxes yet — start a cloud session.</Empty>}

			{tab === "live" && liveRows.length > 0 && (
				<div className="card table-card">
					<table>
						<thead><tr><th>Sandbox</th><th>State</th><th>Session</th><th>Repo</th><th>Template</th><th>Created</th><th>Last event</th><th></th></tr></thead>
						<tbody>
							{liveRows.map((h, i) => (
								<>
									<tr key={i} onClick={() => setExpanded(expanded === h.sandboxId ? null : h.sandboxId!)} style={{ cursor: "pointer" }}>
										<td className="mono">{expanded === h.sandboxId ? "▾" : "▸"} {(h.sandboxId ?? "").slice(0, 16)}</td>
										<td><span className={`sess-pill ${h.state === "paused" ? "completed" : "running"}`}>{h.state}</span></td>
										<td className="muted mono">{h.sessionId ? <a href={`/sessions/${h.sessionId}`}>{h.sessionId.slice(0, 8)}</a> : "—"}</td>
										<td className="muted">{h.repo || "—"}</td>
										<td className="muted" title={h.templateId ?? undefined}>{h.template ?? "—"}{h.templateId && h.template !== h.templateId ? <span className="muted" style={{ fontSize: 10 }}> ·{h.templateId.slice(0, 8)}</span> : null}</td>
										<td className="muted">{fmt(h.createdAt)}</td>
										<td className="muted">{fmt(h.at)}</td>
										<td style={{ whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
											{h.state !== "paused" && <button className="btn ghost sm" onClick={() => void pause(h.sandboxId!)}>Pause</button>}{" "}
											<button className="btn danger sm" onClick={() => void stop(h.sandboxId!)}>Kill</button>
										</td>
									</tr>
									{expanded === h.sandboxId && (
										<tr key={`${i}-ev`}>
											<td colSpan={8} style={{ paddingLeft: 24, background: "var(--bg)" }}>{timeline(eventsFor(h.sandboxId))}</td>
										</tr>
									)}
								</>
							))}
						</tbody>
					</table>
				</div>
			)}
			{tab === "live" && !loading && liveRows.length === 0 && history.length > 0 && <Empty>No live sandboxes.</Empty>}

			{tab === "history" && deadRows.length > 0 && (
				<div className="card table-card">
					<table>
						<thead><tr><th>Sandbox</th><th>State</th><th>Reason</th><th>Session</th><th>Repo</th><th>Template</th><th>Created</th><th>Last event</th></tr></thead>
						<tbody>
							{deadRows.map((h, i) => (
								<>
									<tr key={i} onClick={() => setExpanded(expanded === h.sandboxId ? null : h.sandboxId!)} style={{ cursor: "pointer" }}>
										<td className="mono">{expanded === h.sandboxId ? "▾" : "▸"} {(h.sandboxId ?? "").slice(0, 16)}</td>
										<td>{h.state ?? h.event ?? "—"}</td>
										<td className="muted">{h.reason || "—"}</td>
										<td className="muted mono">{h.sessionId ? <a href={`/sessions/${h.sessionId}`}>{h.sessionId.slice(0, 8)}</a> : h.device || "—"}</td>
										<td className="muted">{h.repo || "—"}</td>
										<td className="muted" title={h.templateId ?? undefined}>{h.template ?? "—"}{h.templateId && h.template !== h.templateId ? <span className="muted" style={{ fontSize: 10 }}> ·{h.templateId.slice(0, 8)}</span> : null}</td>
										<td className="muted">{fmt(h.createdAt)}</td>
										<td className="muted">{fmt(h.at)}</td>
									</tr>
									{expanded === h.sandboxId && (
										<tr key={`${i}-ev`}>
											<td colSpan={8} style={{ paddingLeft: 24, background: "var(--bg)" }}>{timeline(eventsFor(h.sandboxId))}</td>
										</tr>
									)}
								</>
							))}
						</tbody>
					</table>
				</div>
			)}
			{msg && <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>{msg}</p>}
		</div>
	);
}
