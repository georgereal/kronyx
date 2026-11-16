"use client";

import { useEffect, useState } from "react";
import { SandboxLifecycle } from "@/components/SandboxLifecycle";
import { Skeleton } from "@/components/Skeleton";
import { apiFetch, useUser } from "@/lib/api";
import { eventColor, eventLabel, fmtTick } from "@/lib/sandboxLifecycle";

export interface SbxRow { sandboxId?: string; state?: string; reason?: string; sessionId?: string; repo?: string; template?: string; templateId?: string; provider?: string; createdAt?: string; at?: string; snapshots?: { snapshotId: string; name?: string | null; at?: string }[] }
export interface SbxEvent { event?: string; state?: string; reason?: string; sessionId?: string; provider?: string; snapshotId?: string; source?: string; template?: string; at?: string }
export interface LinkedSession { sessionId?: string; title?: string; repo?: string; branch?: string; prUrl?: string; template?: string; provider?: string }
export interface SandboxDetail { sandbox: SbxRow; events: SbxEvent[]; session: LinkedSession | null; live: { state?: string; templateId?: string; name?: string; envdUnresponsiveAtPause?: boolean } | null }

const fmt = (v?: string) => (v ? new Date(v).toLocaleString() : "—");

/**
 * The sandbox detail sub-tabs (Overview / Snapshots / Logs / Configuration)
 * from the UX mockup — used both on the /sandboxes/[id] page (with data the
 * page already fetched) and inline inside expanded rows on the list page
 * (fetches /api/sandboxes/:id on mount).
 */
export function SandboxDetailPanel({ id, detail }: { id: string; detail?: SandboxDetail }) {
	const user = useUser();
	const [d, setD] = useState<SandboxDetail | null>(detail ?? null);
	const [err, setErr] = useState("");
	const [tab, setTab] = useState<"overview" | "snapshots" | "logs" | "config">("overview");

	useEffect(() => {
		if (detail || !user) return;
		apiFetch(`/api/sandboxes/${id}`, user)
			.then(async (r) => (r.ok ? setD((await r.json()) as SandboxDetail) : setErr(`Failed to load (${r.status})`)))
			.catch(() => setErr("Failed to load."));
	}, [id, detail, user]);

	if (err) return <div className="muted" style={{ padding: 12, fontSize: 12 }}>{err}</div>;
	if (!d) return <Skeleton height={180} />;

	const sb = d.sandbox;
	const snapshots = [
		...(sb.snapshots ?? []).map((s) => ({ snapshotId: s.snapshotId, name: s.name, at: s.at, reason: "manual" })),
		...d.events.filter((e) => e.event === "checkpoint" && e.snapshotId).map((e) => ({ snapshotId: e.snapshotId!, name: null as string | null, at: e.at, reason: e.reason ?? "auto" })),
		// Inbound: the snapshot this VM booted FROM (warm repo / WIP restore).
		...d.events.filter((e) => e.event === "boot" && e.snapshotId).map((e) => ({ snapshotId: e.snapshotId!, name: null as string | null, at: e.at, reason: e.source === "warm" ? "booted from (warm)" : "booted from" })),
	].filter((v, i, a) => a.findIndex((x) => x.snapshotId === v.snapshotId) === i);

	return (
		<div>
			<div className="sbx-tabs-line" style={{ marginBottom: 14 }}>
				{([
					["overview", "Overview"],
					["snapshots", `Snapshots (${snapshots.length})`],
					["logs", `Logs (${d.events.length})`],
					["config", "Configuration"],
				] as const).map(([t, label]) => (
					<button key={t} className={tab === t ? "active" : ""} onClick={(e) => { e.stopPropagation(); setTab(t); }}>{label}</button>
				))}
			</div>

			{tab === "overview" && (
				<div onClick={(e) => e.stopPropagation()}>
					<SandboxLifecycle events={d.events} createdAt={sb.createdAt} />
					{d.live && (
						<div className="muted" style={{ fontSize: 12, marginTop: 14 }}>
							Provider reports: <b>{d.live.state ?? "unknown"}</b>
							{d.live.envdUnresponsiveAtPause ? " (envd was unresponsive at pause — resume will cold-boot from disk)" : ""}
						</div>
					)}
					{sb.reason && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Last transition reason: {sb.reason}</div>}
				</div>
			)}

			{tab === "snapshots" && (
				<table className="sbx-table" onClick={(e) => e.stopPropagation()}>
					<thead><tr><th>Snapshot ID</th><th>Name</th><th>Source</th><th>Taken</th></tr></thead>
					<tbody>
						{snapshots.map((s, i) => (
							<tr key={i}>
								<td className="mono" style={{ fontSize: 11 }}>{s.snapshotId}</td>
								<td className="muted">{s.name ?? "—"}</td>
								<td className="muted">{s.reason ?? "auto"}</td>
								<td className="muted">{fmt(s.at)}</td>
							</tr>
						))}
						{!snapshots.length && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No snapshots yet — use the Snapshot button or wait for a checkpoint.</td></tr>}
					</tbody>
				</table>
			)}

			{tab === "logs" && (
				<div style={{ display: "flex", flexDirection: "column", gap: 4 }} onClick={(e) => e.stopPropagation()}>
					{[...d.events].reverse().map((e, i) => (
						<div key={i} className="sbx-activity-row">
							<span className="dot" style={{ background: eventColor(e.event) }} />
							<span className="name">
								{eventLabel(e)}
								{e.reason ? <span className="muted"> ({e.reason})</span> : null}
								{e.snapshotId ? <span className="muted mono"> {e.snapshotId.slice(0, 16)}</span> : null}
								{e.sessionId ? <a className="muted mono" href={`/sessions/${e.sessionId}`}> {e.sessionId.slice(0, 8)}</a> : null}
							</span>
							<span className="t">{e.at ? fmtTick(Date.parse(e.at)) : "—"}</span>
						</div>
					))}
					{!d.events.length && <div className="muted" style={{ fontSize: 11 }}>No events recorded yet.</div>}
				</div>
			)}

			{tab === "config" && (
				<div onClick={(e) => e.stopPropagation()}>
					{([
						["Template", `${sb.template ?? "—"}${sb.templateId ? ` (${sb.templateId})` : ""}`],
						["Provider", sb.provider ?? "e2b"],
						["Repo", sb.repo ?? "—"],
						["Session", d.session?.sessionId ?? "—"],
						["Branch", d.session?.branch ?? "—"],
						["Created", fmt(sb.createdAt)],
						["Last event", fmt(sb.at)],
						["Idle policy", "auto-pause after 15m idle · killed only when unreachable or orphaned"],
					] as const).map(([k, v]) => (
						<div key={k} className="sbx-kv">
							<span className="k">{k}</span>
							<span className="mono" style={{ fontSize: 12 }}>{v}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
