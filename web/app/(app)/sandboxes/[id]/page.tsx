"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/Skeleton";
import { SandboxDetailPanel, type SandboxDetail } from "@/components/SandboxDetailPanel";
import { apiFetch, useUser } from "@/lib/api";

export default function SandboxDetailPage() {
	const user = useUser();
	const params = useParams<{ id: string }>();
	const router = useRouter();
	const id = params.id;
	const [d, setD] = useState<SandboxDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState("");

	const load = useCallback(async () => {
		if (!user) return;
		const res = await apiFetch(`/api/sandboxes/${id}`, user);
		if (res.ok) setD((await res.json()) as SandboxDetail);
		else if (res.status === 404) setD(null);
		setLoading(false);
	}, [user, id]);
	useEffect(() => { void load(); }, [load]);

	const act = async (label: string, fn: () => Promise<Response>) => {
		setBusy(label);
		const res = await fn().catch(() => null);
		setMsg(res?.ok ? `${label} done.` : `${label} failed${res ? ` (${res.status})` : ""}.`);
		setBusy("");
		void load();
	};
	const doPause = () => act("Pause", () => apiFetch(`/api/sandboxes/${id}/pause`, user!, { method: "POST" }));
	const doResume = () => act("Resume", () => apiFetch(`/api/sandboxes/${id}/resume`, user!, { method: "POST" }));
	const doSnapshot = () => act("Snapshot", () => apiFetch(`/api/sandboxes/${id}/snapshot`, user!, { method: "POST", body: "{}" }));
	const doKill = async () => {
		if (!user || !confirm(`Kill sandbox ${id.slice(0, 12)}?`)) return;
		await act("Kill", () => apiFetch(`/api/sandboxes/${id}`, user, { method: "DELETE" }));
		router.push("/sandboxes");
	};

	if (!user) return null;
	if (loading) return <div className="page"><Skeleton height={200} /></div>;
	if (!d) return <div className="page"><h1>Sandbox not found</h1><Link href="/sandboxes" className="muted">‹ Back to sandboxes</Link></div>;

	const sb = d.sandbox;
	const state = sb.state ?? "—";
	const paused = state === "paused";
	const dead = state === "dead" || state === "killed" || state === "terminated";

	return (
		<div className="page">
			<div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
				<Link href="/sandboxes" className="muted" style={{ fontSize: 12 }}>‹ Sandboxes</Link>
				<h1 className="mono" style={{ fontSize: 18, margin: 0 }}>{sb.sandboxId}</h1>
				<span className={`sbx-pill ${state}`}>{state}</span>
				<span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
					{paused && <button className="sbx-btn primary" disabled={!!busy} onClick={() => void doResume()}>▶ Resume</button>}
					{!paused && !dead && <button className="sbx-btn" disabled={!!busy} onClick={() => void doPause()}>⏸ Pause</button>}
					{!dead && <button className="sbx-btn" disabled={!!busy} onClick={() => void doSnapshot()}>⧉ Snapshot</button>}
					{!dead && <button className="sbx-btn danger" disabled={!!busy} onClick={() => void doKill()}>Kill</button>}
				</span>
			</div>
			<div className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
				{sb.repo && <>Repo: {sb.repo} · </>}
				{sb.template && <>Template: {sb.template} · </>}
				Provider: {sb.provider ?? "e2b"}
				{d.session?.sessionId && (
					<>
						{" · Session: "}
						<Link href={`/sessions/${d.session.sessionId}`} className="mono">
							{d.session.sessionId.slice(0, 8)}{d.session.title ? ` — ${d.session.title}` : ""}
						</Link>
						{d.session.branch && <> · Branch: <span className="mono">{d.session.branch}</span></>}
						{d.session.prUrl && <> · <a href={d.session.prUrl} target="_blank" rel="noreferrer">PR</a></>}
					</>
				)}
			</div>

			<div className="card" style={{ padding: 18 }}>
				<SandboxDetailPanel id={id} detail={d} />
			</div>
			{msg && <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>{msg}</p>}
		</div>
	);
}
