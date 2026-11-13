"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fmtTok } from "@/components/AreaChart";
import { Empty } from "@/components/Empty";
import { Modal } from "@/components/Modal";
import { Skeleton } from "@/components/Skeleton";
import { Stat } from "@/components/Stat";
import { apiFetch, useUser } from "@/lib/api";
import { RangePicker } from "@/lib/usage";

interface MemEvent {
	at: string;
	source: "cloud" | "ext";
	op?: string;
	path?: string;
	runId?: string;
	sessionId?: string;
	session?: string;
	task?: string;
	workspace?: string;
	queryCacheHit?: boolean;
	usedVector?: boolean;
	cacheHits?: number;
	embeddingsMade?: number;
	embedded?: boolean;
	scope?: string;
	chunks?: number;
	hits?: number;
	candidates?: number;
	tookMs?: number;
	query?: string;
	preview?: string;
	topScore?: number;
	items?: { scope?: string; status?: string; preview?: string; score?: number; branch?: string }[];
	previews?: string[];
	paths?: string[];
	[k: string]: unknown;
}

interface MemDoc {
	memoryId: string;
	sessionId: string;
	scope: string;
	repo?: string;
	branch?: string;
	content: string;
	origin?: { runId?: string; kind?: string };
	confidence?: number;
	status: string;
	createdAt: string;
	injectedCount?: number;
	lastRecalledAt?: string;
	lastOutcome?: string;
	helpedRuns?: number;
	failedRuns?: number;
	version?: number;
}

interface MemoryResponse {
	events: MemEvent[];
	embedUsage: Record<string, { calls: number; tokensIn: number; failed: number }>;
	memoryStats: { total: number; embedded: number; byStatus: Record<string, number>; byScope: Record<string, number> };
	docs: MemDoc[];
	collStats: { count: number; size: number; storageSize: number } | null;
	searchIndexes: { name: string; status: string; queryable: boolean }[] | null;
}

const fmt = (v?: string) => (v ? new Date(v).toLocaleString() : "—");
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
const fmtBytes = (b?: number) =>
	b == null ? "—" : b < 1024 ? `${b} B` : b < 1 << 20 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1 << 20)).toFixed(1)} MB`;

function pathLabel(e: MemEvent): { text: string; cls: string } {
	if (e.op === "memory_recall") {
		if (e.path === "cold-start") return { text: "cold-start", cls: "completed" };
		if (e.path === "vector") return { text: e.queryCacheHit ? "vector·cached-q" : "vector", cls: "completed" };
		if (e.path === "recent-fallback") return { text: "fallback", cls: "running" };
		return { text: e.path ?? "no-embedder", cls: "failed" };
	}
	if (e.op === "recall_context") return e.usedVector ? { text: "vector", cls: "completed" } : { text: "keyword-fallback", cls: "running" };
	if (e.op === "memory_write") return e.embedded ? { text: "embedded", cls: "completed" } : { text: "no-embed", cls: "failed" };
	if (e.op === "memory_search") return { text: "local-vector", cls: "completed" };
	return { text: "—", cls: "" };
}

function detail(e: MemEvent): string {
	const p: string[] = [];
	if (e.query) p.push(`"${e.query}"`);
	if (e.hits != null) p.push(`${e.hits} hit${e.hits === 1 ? "" : "s"}`);
	if (e.candidates != null) p.push(`${e.candidates} cand`);
	if (e.chunks != null) p.push(`${e.chunks} chunks`);
	if (typeof e.chars === "number") p.push(`${e.chars} chars`);
	if (e.cacheHits != null) p.push(`${e.cacheHits} cache`);
	if (e.embeddingsMade != null) p.push(`${e.embeddingsMade} embeds`);
	if (typeof e.stale === "number") p.push(`${e.stale} stale`);
	if (typeof e.indexed === "number") p.push(`${e.indexed} indexed`);
	if (typeof e.path === "string" && e.op !== "memory_recall") p.push(e.path);
	if (e.scope) p.push(e.scope);
	if (typeof e.topScore === "number") p.push(`score ${e.topScore.toFixed(2)}`);
	if (e.tookMs != null) p.push(`${e.tookMs}ms`);
	return p.join(" · ") || "—";
}

/** What actually entered context — recalled memories or scored chunks. */
function injected(e: MemEvent): { text: string; score?: number; branch?: string }[] {
	if (e.items?.length) return e.items.filter((i) => i.preview).map((i) => ({ text: i.preview!, score: i.score, branch: i.branch }));
	if (e.previews?.length) return e.previews.filter(Boolean).map((t) => ({ text: t }));
	if (e.paths?.length) return e.paths.map((t) => ({ text: t }));
	if (e.preview) return [{ text: e.preview }];
	return [];
}

export default function MemoryPage() {
	const user = useUser();
	const [range, setRange] = useState(86_400_000 * 7);
	const [data, setData] = useState<MemoryResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [openItems, setOpenItems] = useState<{ title: string; items: { text: string; score?: number; branch?: string }[] } | null>(null);

	useEffect(() => {
		if (!user) return;
		setLoading(true);
		void (async () => {
			const since = range ? `&since=${Date.now() - range}` : "";
			const res = await apiFetch(`/api/memory?limit=500${since}`, user);
			if (res.ok) setData((await res.json()) as MemoryResponse);
			setLoading(false);
		})();
	}, [user, range]);

	const events = data?.events ?? [];
	const recalls = events.filter((e) => e.op === "memory_recall");
	const vectorRecalls = recalls.filter((e) => e.path === "vector");
	const qCacheHits = recalls.filter((e) => e.queryCacheHit).length;
	const zeroHits = recalls.filter((e) => e.hits === 0).length;
	// Prefer per-item scores; fall back to topScore only when no items (it
	// duplicates items[0].score otherwise and skews the average).
	const scores = events.flatMap((e) => {
		const itemScores = (e.items ?? []).map((i) => i.score).filter((s): s is number => typeof s === "number");
		return itemScores.length ? itemScores : typeof e.topScore === "number" ? [e.topScore] : [];
	});
	const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined;
	const embedOps = Object.entries(data?.embedUsage ?? {});
	const embedCalls = embedOps.reduce((s, [, v]) => s + v.calls, 0);
	const embedTokens = embedOps.reduce((s, [, v]) => s + v.tokensIn, 0);
	const ms = data?.memoryStats;
	const vectorIdx = data?.searchIndexes?.find((i) => i.name === "memories_vector");

	return (
		<>
			<div className="section-head" style={{ marginTop: 0 }}>
				<h1>Memory</h1>
				<RangePicker value={range} onChange={setRange} />
			</div>

			<div className="stat-grid">
				<Stat label="Memories stored" value={ms ? ms.total.toLocaleString() : "—"} />
				<Stat label="Vectorized" value={ms ? `${pct(ms.embedded, ms.total)}` : "—"} />
				<Stat label="Recalls" value={recalls.length.toLocaleString()} />
				<Stat label="Vector path" value={pct(vectorRecalls.length, recalls.length)} />
				<Stat label="Query cache hits" value={pct(qCacheHits, recalls.length)} />
				<Stat label="Zero-hit" value={recalls.length ? pct(zeroHits, recalls.length) : "—"} />
				<Stat label="Avg score" value={avgScore != null ? avgScore.toFixed(2) : "—"} />
				<Stat label="Embed calls" value={`${embedCalls.toLocaleString()} · ${fmtTok(embedTokens)} tok`} />
			</div>

			{(data?.collStats || data?.searchIndexes) && (
				<div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
					{data.collStats && (
						<span>
							memories: {data.collStats.count?.toLocaleString()} docs · {fmtBytes(data.collStats.size)} data ·{" "}
							{fmtBytes(data.collStats.storageSize)} storage
						</span>
					)}
					{vectorIdx && (
						<span style={{ marginLeft: 12 }}>
							index <span className="mono">{vectorIdx.name}</span>: {vectorIdx.status}
							{vectorIdx.queryable ? "" : " (not queryable)"}
						</span>
					)}
					{data.searchIndexes && !vectorIdx && <span style={{ marginLeft: 12 }}>no memories_vector index found</span>}
				</div>
			)}

			<div className="card table-card" style={{ marginTop: 12 }}>
				{loading && events.length === 0 ? (
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
								<th>Source</th>
								<th>Op</th>
								<th>Path</th>
								<th>Session / Run</th>
								<th>Task / Workspace</th>
								<th>Detail</th>
							</tr>
						</thead>
						<tbody>
							{events.map((e, i) => {
								const p = pathLabel(e);
								const sid = e.sessionId || e.session;
								return (
									<tr key={i}>
										<td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(e.at)}</td>
										<td className="muted" title={typeof e.deviceId === "string" ? e.deviceId : undefined}>
											{e.source}{typeof e.device === "string" && e.device ? `·${e.device}` : ""}
										</td>
										<td className="mono" style={{ fontSize: 11.5 }}>{e.op ?? "—"}</td>
										<td>{p.text === "—" ? "—" : <span className={`sess-pill ${p.cls}`}>{p.text}</span>}</td>
										<td className="muted mono">
											{sid ? (
												<Link href={`/sessions/${sid}`} style={{ color: "inherit" }}>
													{sid.slice(0, 8)}
												</Link>
											) : "—"}
											{e.runId && (
												<>
													{" / "}
													<Link href={`/runs/${e.runId}`} style={{ color: "inherit" }}>
														{e.runId.slice(0, 10)}
													</Link>
												</>
											)}
										</td>
										<td className="muted" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.task ?? e.workspace}>
											{e.task ?? e.workspace ?? "—"}
										</td>
										<td className="muted" style={{ fontSize: 11.5, whiteSpace: "normal", minWidth: 240 }}>
											{detail(e)}
											{injected(e).length > 0 && (
												<button
													className="btn ghost sm"
													style={{ marginTop: 3, fontSize: 10.5, padding: "1px 6px" }}
													onClick={() =>
														setOpenItems({
															title: `${String(e.tool ?? e.op ?? "event")} — ${injected(e).length} injected`,
															items: injected(e),
														})
													}
												>
													{injected(e).length} injected
												</button>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
				{events.length === 0 && !loading && (
					<Empty>
						No memory events yet — recalls, writes and index runs appear here. Cloud runs need a recent worker;
						extension events need <span className="mono">kronyx.sync.enabled</span> and an embedding model configured.
					</Empty>
				)}
			</div>

			{embedOps.length > 0 && (
				<div className="card table-card" style={{ marginTop: 12 }}>
					<table>
						<thead>
							<tr>
								<th>Embedding op</th>
								<th>Calls</th>
								<th>Tokens in</th>
								<th>Failed</th>
							</tr>
						</thead>
						<tbody>
							{embedOps.map(([op, v]) => (
								<tr key={op}>
									<td className="mono">{op}</td>
									<td className="num">{v.calls.toLocaleString()}</td>
									<td className="num">{fmtTok(v.tokensIn)}</td>
									<td className="num">{v.failed || "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{openItems && (
				<Modal title={openItems.title} onClose={() => setOpenItems(null)}>
					<div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "60vh", overflowY: "auto" }}>
						{openItems.items.map((t, i) => (
							<div key={i} className="mono" style={{ fontSize: 11.5, padding: "6px 8px", background: "var(--card-bg, rgba(255,255,255,0.03))", borderRadius: 6 }}>
								{t.score != null && (
									<span className="sess-pill completed" style={{ marginRight: 6, fontSize: 10 }} title="vector similarity score">
										{t.score.toFixed(2)}
									</span>
								)}
								{t.branch && (
									<span className="sess-pill running" style={{ marginRight: 6, fontSize: 10 }} title="written on branch">
										@{t.branch}
									</span>
								)}
								{t.text}
							</div>
						))}
					</div>
				</Modal>
			)}

			<div className="section-head" style={{ marginTop: 20 }}>
				<h2 style={{ fontSize: 14 }}>Stored memories</h2>
				{ms && (
					<span className="muted" style={{ fontSize: 11.5 }}>
						{Object.entries(ms.byStatus).map(([k, v]) => `${k}: ${v}`).join(" · ")}
						{Object.keys(ms.byScope).length > 0 && <> — {Object.entries(ms.byScope).map(([k, v]) => `${k}: ${v}`).join(" · ")}</>}
					</span>
				)}
			</div>
			<div className="card table-card">
				<table>
					<thead>
						<tr>
							<th>Created</th>
							<th>Scope</th>
							<th>Status</th>
							<th>Repo</th>
							<th>Origin</th>
							<th title="Times injected into a run's context">Inj.</th>
							<th title="Runs that succeeded / failed with this memory in context">W–L</th>
							<th>Last used</th>
							<th>Content</th>
						</tr>
					</thead>
					<tbody>
						{(data?.docs ?? []).map((m) => (
							<tr key={m.memoryId}>
								<td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(m.createdAt)}</td>
								<td className="muted">{m.scope}</td>
								<td>
									<span className={`sess-pill ${m.status === "active" ? "completed" : m.status === "superseded" ? "failed" : "running"}`}>
										{m.status}
									</span>
								</td>
								<td className="muted" style={{ fontSize: 11.5 }}>
									{m.repo ?? "—"}
									{m.branch ? <span className="mono">@{m.branch}</span> : ""}
								</td>
								<td className="muted mono" style={{ fontSize: 11.5 }}>
									{m.origin?.runId ? (
										<Link href={`/runs/${m.origin.runId}`} style={{ color: "inherit" }}>
											{m.origin.runId.slice(0, 10)}
										</Link>
									) : (m.origin?.kind ?? "—")}
								</td>
								<td className="num muted">{m.injectedCount ?? 0}</td>
								<td className="num muted" title={m.lastOutcome ? `last: ${m.lastOutcome}` : undefined}>
									{(m.helpedRuns ?? 0) > 0 || (m.failedRuns ?? 0) > 0 ? `${m.helpedRuns ?? 0}–${m.failedRuns ?? 0}` : "—"}
								</td>
								<td className="muted" style={{ whiteSpace: "nowrap", fontSize: 11.5 }}>
									{m.lastRecalledAt ? new Date(m.lastRecalledAt).toLocaleDateString() : "—"}
								</td>
								<td style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.content}>
									{m.content}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{(data?.docs ?? []).length === 0 && !loading && <Empty>No memories stored yet — the agent records them with memory_write.</Empty>}
			</div>
		</>
	);
}
