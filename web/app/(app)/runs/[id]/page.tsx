"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { StatusPill } from "@/components/StatusPill";
import { apiFetch, useUser } from "@/lib/api";
import { fmtDur } from "@/lib/usage";

interface RunDoc {
	runId: string;
	task?: string;
	status?: string;
	at?: number;
	durationMs?: number;
	tokensIn?: number;
	tokensOut?: number;
	session?: string;
}

interface Ev {
	seq: number;
	event: { type: string; [k: string]: unknown } & Record<string, unknown>;
}

const KIND: Record<string, string> = {
	"run-started": "Run started",
	assistant: "Agent",
	plan: "Plan",
	tool: "Tool",
	"file-changed": "File changed",
	checks: "Checks",
	status: "Status",
	"run-finished": "Run finished",
	"run-completed": "Run completed",
	"run-failed": "Run failed",
};

/** /runs/[id] — replayed run timeline from synced events (polls while running). */
export default function RunDetail() {
	const user = useUser();
	const params = useParams<{ id: string }>();
	const id = params.id;
	const [run, setRun] = useState<RunDoc | null>(null);
	const [pr, setPr] = useState<{ url?: string; status?: string; title?: string } | null>(null);
	const [events, setEvents] = useState<Ev[]>([]);
	const [notFound, setNotFound] = useState(false);

	useEffect(() => {
		if (!user) return;
		let alive = true;
		let after = 0;
		const tick = async () => {
			const res = await apiFetch(`/api/runs/${id}?after=${after}`, user);
			if (!alive) return;
			if (res.status === 404) return setNotFound(true);
			if (!res.ok) return;
			const body = (await res.json()) as { run: RunDoc | null; pr: { url?: string; status?: string; title?: string } | null; events: Ev[] };
			setRun(body.run);
			setPr(body.pr);
			if (body.events.length) {
				setEvents((prev) => [...prev, ...body.events]);
				after = body.events[body.events.length - 1].seq;
			}
			if (body.run?.status !== "completed" && body.run?.status !== "failed") {
				setTimeout(() => void tick(), 3000);
			}
		};
		void tick();
		return () => {
			alive = false;
		};
	}, [user, id]);

	if (!user) return null;
	if (notFound) return <div className="page">Run not found — it may still be syncing.</div>;
	return (
		<div className="page">
			<p><Link href="/runs" className="muted">← All runs</Link></p>
			<h1>{run?.task || "Cloud run"}</h1>
			<div className="muted" style={{ display: "flex", gap: 16, fontSize: 13, marginBottom: 16 }}>
				<span>{run?.status ?? "…"}</span>
				<span>{fmtDur(run?.durationMs ?? 0)}</span>
				<span>{run?.tokensIn ?? 0} in / {run?.tokensOut ?? 0} out</span>
				{pr?.url && (
					<a href={pr.url} target="_blank" rel="noreferrer" className="rowlink">
						PR: {pr.status ?? "open"} ↗
					</a>
				)}
			</div>
			<div className="runlog">
				{events.map((e) => {
					const ev = e.event;
					const kind = KIND[ev.type] ?? ev.type;
					const text =
						(ev.text as string) ||
						(ev.detail as string) ||
						(ev.status as string) ||
						(ev.name ? `${ev.name} ${(ev.args as string) ?? ""}` : "") ||
						(ev.message as string) ||
						"";
					const path = ev.path as string | undefined;
					const diff = ev.diff as string | undefined;
					return (
						<div key={e.seq} className={`runlog-item kind-${ev.type}`}>
							<span className="runlog-kind">{kind}</span>
							<span className="runlog-body">
								{ev.type === "checks" && <StatusPill status={String(ev.status)} />}
								{path && <span className="mono muted">{path} </span>}
								{text && <span>{text}</span>}
								{ev.type === "run-finished" && ev.summary ? <span>{String(ev.summary)}</span> : null}
								{diff && <pre className="runlog-diff">{diff}</pre>}
							</span>
						</div>
					);
				})}
				{events.length === 0 && <div className="muted">Waiting for events…</div>}
			</div>
		</div>
	);
}
