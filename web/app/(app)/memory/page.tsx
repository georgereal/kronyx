"use client";

import { useEffect, useRef, useState } from "react";
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
	tags?: string[];
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
const PAGE = 8;

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
	if (typeof e.path === "string" && e.op !== "memory_recall") p.push(e.path);
	if (e.scope) p.push(e.scope);
	if (typeof e.topScore === "number") p.push(`score ${e.topScore.toFixed(2)}`);
	if (e.tookMs != null) p.push(`${e.tookMs}ms`);
	return p.join(" · ") || "—";
}

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
	const [tab, setTab] = useState<"memories" | "search" | "groups" | "policies" | "tuning">("memories");
	const [selected, setSelected] = useState<MemDoc | null>(null);
	const [editing, setEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
	const [editTags, setEditTags] = useState("");
	const [editScope, setEditScope] = useState("conversation");
	const [page, setPage] = useState(1);
	const [checked, setChecked] = useState<Set<string>>(new Set());
	const [f, setF] = useState({ q: "", source: "", scope: "", status: "", tag: "" });
	const [openItems, setOpenItems] = useState<{ title: string; items: { text: string; score?: number; branch?: string }[] } | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [importText, setImportText] = useState("");
	const [newMem, setNewMem] = useState({ content: "", scope: "conversation", repo: "", tags: "" });
	const [recallQ, setRecallQ] = useState("");
	const [recallRes, setRecallRes] = useState<{ docs: { memoryId: string; content: string; scope: string; score: number | null }[]; tookMs: number; embedded: boolean } | null>(null);
	const [recallOut, setRecallOut] = useState<string | null>(null);
	const [msg, setMsg] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);

	const load = async () => {
		if (!user) return;
		setLoading(true);
		const since = range ? `&since=${Date.now() - range}` : "";
		const res = await apiFetch(`/api/memory?limit=500${since}`, user);
		if (res.ok) setData((await res.json()) as MemoryResponse);
		setLoading(false);
	};
	useEffect(() => { void load(); }, [user, range]);

	const events = data?.events ?? [];
	const docs = data?.docs ?? [];
	const recalls = events.filter((e) => e.op === "memory_recall");
	const vectorRecalls = recalls.filter((e) => e.path === "vector");
	const qCacheHits = recalls.filter((e) => e.queryCacheHit).length;
	const zeroHits = recalls.filter((e) => e.hits === 0).length;
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
	const sinceMs = range ? Date.now() - range : 0;
	const newInRange = docs.filter((d) => !sinceMs || new Date(d.createdAt).getTime() >= sinceMs).length;
	const vectorPct = ms && ms.total ? Math.round((ms.embedded / ms.total) * 100) : 0;
	const zeroPct = recalls.length ? zeroHits / recalls.length : 0;
	const healthy = (vectorIdx?.queryable ?? false) && vectorPct === 100 && zeroPct < 0.2;
	const allTags = [...new Set(docs.flatMap((d) => d.tags ?? []))];

	const filtered = docs.filter((d) => {
		if (f.q && !`${d.content} ${d.repo ?? ""} ${(d.tags ?? []).join(" ")}`.toLowerCase().includes(f.q.toLowerCase())) return false;
		if (f.source && (d.origin?.kind ?? "agent") !== f.source) return false;
		if (f.scope && d.scope !== f.scope) return false;
		if (f.status && d.status !== f.status) return false;
		if (f.tag && !(d.tags ?? []).includes(f.tag)) return false;
		return true;
	});
	const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
	const pageRows = filtered.slice((page - 1) * PAGE, page * PAGE);

	const sel = (m: MemDoc | null) => {
		setSelected(m);
		setEditing(false);
		setRecallOut(null);
		if (m) {
			setEditContent(m.content);
			setEditTags((m.tags ?? []).join(", "));
			setEditScope(m.scope);
		}
	};

	const doExport = async () => {
		if (!user) return;
		const res = await apiFetch("/api/memories/export", user);
		if (!res.ok) return setMsg("Export failed.");
		const url = URL.createObjectURL(await res.blob());
		const a = document.createElement("a");
		a.href = url;
		a.download = `kronyx-memories-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const doCreate = async () => {
		if (!user || !newMem.content.trim()) return;
		const res = await apiFetch("/api/memories", user, {
			method: "POST",
			body: JSON.stringify({ ...newMem, tags: newMem.tags.split(",").map((t) => t.trim()).filter(Boolean) }),
		});
		setMsg(res.ok ? "Memory added." : "Add failed.");
		if (res.ok) {
			setAddOpen(false);
			setNewMem({ content: "", scope: "conversation", repo: "", tags: "" });
			void load();
		}
	};

	const doImport = async () => {
		if (!user) return;
		let docs: unknown[] = [];
		try {
			const parsed = JSON.parse(importText) as { docs?: unknown[] } | unknown[];
			docs = Array.isArray(parsed) ? parsed : parsed.docs ?? [];
		} catch {
			return setMsg("Import: invalid JSON.");
		}
		const res = await apiFetch("/api/memories/import", user, { method: "POST", body: JSON.stringify({ docs }) });
		const b = res.ok ? ((await res.json()) as { inserted?: number; skipped?: number }) : null;
		setMsg(b ? `Imported ${b.inserted ?? 0} (${b.skipped ?? 0} skipped).` : "Import failed.");
		if (b) {
			setImportOpen(false);
			setImportText("");
			void load();
		}
	};

	const doUpdate = async () => {
		if (!user || !selected) return;
		const res = await apiFetch(`/api/memories/${selected.memoryId}`, user, {
			method: "PATCH",
			body: JSON.stringify({ content: editContent, scope: editScope, tags: editTags.split(",").map((t) => t.trim()).filter(Boolean) }),
		});
		const b = res.ok ? ((await res.json()) as { memory?: MemDoc }) : null;
		setMsg(b?.memory ? "Updated." : "Update failed.");
		if (b?.memory) {
			setSelected(b.memory);
			setEditing(false);
			void load();
		}
	};

	const doDelete = async (ids: string[]) => {
		if (!user || !ids.length || !confirm(`Delete ${ids.length} memor${ids.length === 1 ? "y" : "ies"}?`)) return;
		let ok = 0;
		for (const id of ids) {
			const res = await apiFetch(`/api/memories/${id}`, user, { method: "DELETE" });
			if (res.ok) ok++;
		}
		setMsg(`Deleted ${ok}/${ids.length}.`);
		if (selected && ids.includes(selected.memoryId)) sel(null);
		setChecked(new Set());
		void load();
	};

	const doRecall = async (query: string, intoPanel = false) => {
		if (!user || !query.trim()) return;
		const res = await apiFetch("/api/memories/recall", user, { method: "POST", body: JSON.stringify({ query, limit: 10 }) });
		const b = res.ok ? ((await res.json()) as { docs: { memoryId: string; content: string; scope: string; score: number | null }[]; tookMs: number; embedded: boolean }) : null;
		if (intoPanel) setRecallOut(b ? `${b.docs.length} result${b.docs.length === 1 ? "" : "s"} · ${b.tookMs}ms` : "Recall failed.");
		else setRecallRes(b);
	};

	const rangeDays = range ? Math.round(range / 86_400_000) : 0;

	return (
		<>
			<div className="sbx-head" style={{ marginBottom: 14 }}>
				<h1>Memory Management</h1>
				<div className="sub">Manage the agent's long-term memory, vector index and recall performance.</div>
			</div>
			<div className="section-head" style={{ marginTop: 0 }}>
				<RangePicker value={range} onChange={setRange} />
				<button className="sbx-btn" onClick={() => void load()} disabled={loading}>⟳ Refresh</button>
			</div>

			{loading && !data ? (
				<div className="stat-grid">{[0, 1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} height={88} />)}</div>
			) : (
				<div className="stat-grid">
					<Stat label="Memories stored" value={ms ? ms.total.toLocaleString() : "—"} sub={newInRange ? `↑ +${newInRange} (${rangeDays}d)` : undefined} />
					<Stat label="Vectorized" value={ms ? `${vectorPct}%` : "—"} />
					<Stat label="Recalls" value={recalls.length.toLocaleString()} sub={recalls.length ? `+${recalls.length} (${rangeDays}d)` : undefined} />
					<Stat label="Vector path" value={pct(vectorRecalls.length, recalls.length)} />
					<Stat label="Query cache hits" value={pct(qCacheHits, recalls.length)} />
					<Stat label="Zero-hit" value={recalls.length ? pct(zeroHits, recalls.length) : "—"} />
					<Stat label="Avg score" value={avgScore != null ? avgScore.toFixed(2) : "—"} />
				</div>
			)}

			<div className="mem-cards">
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title" style={{ display: "flex", justifyContent: "space-between" }}>
						Memory Storage
						{data?.collStats && <span className="muted" style={{ fontWeight: 400 }}>{fmtBytes(data.collStats.size)} data · {fmtBytes(data.collStats.storageSize)} on disk</span>}
					</div>
					{data?.collStats ? (
						<>
							<div className="mem-bar">
								<div style={{ width: `${Math.min(100, (data.collStats.size / Math.max(data.collStats.storageSize, 1)) * 100)}%`, background: "var(--accent)" }} />
								<div style={{ flex: 1, background: "var(--border)" }} />
							</div>
							<div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
								<span style={{ color: "var(--accent)" }}>●</span> Memory data {fmtBytes(data.collStats.size)}
								&nbsp;&nbsp;<span style={{ color: "var(--border-strong, var(--muted))" }}>●</span> Storage overhead {fmtBytes(Math.max(0, data.collStats.storageSize - data.collStats.size))}
								&nbsp;&nbsp;{data.collStats.count} docs
							</div>
						</>
					) : (
						<div className="muted" style={{ fontSize: 11 }}>Storage stats unavailable (Atlas tier restricted).</div>
					)}
				</div>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title" style={{ display: "flex", justifyContent: "space-between" }}>
						Vector Index
						<span className={`sess-pill ${vectorIdx?.queryable ? "completed" : "failed"}`}>{vectorIdx?.queryable ? "READY" : "NOT QUERYABLE"}</span>
					</div>
					<div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
						Index: <span className="mono">{vectorIdx?.name ?? "memories_vector"}</span><br />
						Dim: 1,536 &nbsp;·&nbsp; Vectors: {ms?.embedded ?? "—"}
					</div>
				</div>
				<div className="card" style={{ padding: 16 }}>
					<div className="chart-title">Memory Health</div>
					<div style={{ fontSize: 13, fontWeight: 600, color: healthy ? "var(--ok)" : "var(--warn)", marginTop: 8 }}>
						{healthy ? "✓ Healthy" : "⚠ Attention"}
					</div>
					<div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
						{healthy
							? "Index is up to date · Vectorization complete"
							: [
									!vectorIdx?.queryable && "index not queryable",
									vectorPct < 100 && `${100 - vectorPct}% not vectorized`,
									zeroPct >= 0.2 && `${Math.round(zeroPct * 100)}% zero-hit recalls`,
							  ].filter(Boolean).join(" · ") || "checks pending"}
					</div>
				</div>
			</div>

			<div className="sbx-tabs-line" style={{ marginTop: 18, display: "flex", alignItems: "center" }}>
				{([
					["memories", `Memories (${docs.length})`],
					["search", "Browse & Search"],
					["groups", "Groups"],
					["policies", "Policies"],
					["tuning", "Usage & Tuning"],
				] as const).map(([t, label]) => (
					<button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{label}</button>
				))}
				<span style={{ marginLeft: "auto", display: "flex", gap: 6, paddingBottom: 6 }}>
					<button className="sbx-btn primary" onClick={() => setAddOpen(true)}>+ Add Memory</button>
					<button className="sbx-btn" onClick={() => setImportOpen(true)}>⇩ Import</button>
					<button className="sbx-btn" onClick={() => void doExport()}>⇧ Export</button>
				</span>
			</div>
			{msg && <div className="muted" style={{ fontSize: 12, margin: "6px 0" }}>{msg}</div>}

			{tab === "memories" && (
				<div className={selected ? "mem-layout" : ""}>
					<div className="card table-card" style={{ marginTop: 0 }}>
						<div className="mem-filters">
							<input placeholder="Search memories (content, tags, workspace…)" value={f.q} onChange={(e) => { setF({ ...f, q: e.target.value }); setPage(1); }} />
							<select value={f.source} onChange={(e) => { setF({ ...f, source: e.target.value }); setPage(1); }}>
								<option value="">All Sources</option>
								<option value="agent">agent</option>
								<option value="user">user</option>
							</select>
							<select value={f.scope} onChange={(e) => { setF({ ...f, scope: e.target.value }); setPage(1); }}>
								<option value="">All Scopes</option>
								<option value="conversation">conversation</option>
								<option value="project">project</option>
							</select>
							<select value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setPage(1); }}>
								<option value="">All Statuses</option>
								<option value="active">active</option>
								<option value="candidate">candidate</option>
								<option value="superseded">superseded</option>
							</select>
							{allTags.length > 0 && (
								<select value={f.tag} onChange={(e) => { setF({ ...f, tag: e.target.value }); setPage(1); }}>
									<option value="">All Tags</option>
									{allTags.map((t) => <option key={t} value={t}>{t}</option>)}
								</select>
							)}
							{checked.size > 0 && (
								<button className="sbx-btn danger" style={{ marginLeft: "auto" }} onClick={() => void doDelete([...checked])}>
									Delete {checked.size}
								</button>
							)}
						</div>
						<table className="sbx-table">
							<thead>
								<tr>
									<th style={{ width: 28 }}>
										<input type="checkbox"
											checked={pageRows.length > 0 && pageRows.every((d) => checked.has(d.memoryId))}
											onChange={(e) => {
												const next = new Set(checked);
												for (const d of pageRows) { if (e.target.checked) next.add(d.memoryId); else next.delete(d.memoryId); }
												setChecked(next);
											}} />
									</th>
									<th>Time</th><th>Source</th><th>Operation</th><th>Type</th><th>Session / Run</th><th>Workspace</th><th>Hits</th><th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{pageRows.map((m) => (
									<tr key={m.memoryId} className={selected?.memoryId === m.memoryId ? "row-selected" : ""} onClick={() => sel(m)}>
										<td onClick={(e) => e.stopPropagation()}>
											<input type="checkbox" checked={checked.has(m.memoryId)}
												onChange={(e) => { const n = new Set(checked); if (e.target.checked) n.add(m.memoryId); else n.delete(m.memoryId); setChecked(n); }} />
										</td>
										<td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(m.createdAt)}</td>
										<td className="muted">{m.origin?.kind ?? "agent"}</td>
										<td className="muted">memory_write</td>
										<td><span className={`sess-pill ${m.scope === "project" ? "completed" : "running"}`}>{m.scope}</span>
											{m.status !== "active" && <span className="sess-pill failed" style={{ marginLeft: 4 }}>{m.status}</span>}</td>
										<td className="muted mono" onClick={(e) => e.stopPropagation()}>
											{m.sessionId && m.sessionId !== "manual" ? (
												<Link href={`/sessions/${m.sessionId}`} style={{ color: "inherit" }}>{m.sessionId.slice(0, 8)}</Link>
											) : "—"}
											{m.origin?.runId && <> / <Link href={`/runs/${m.origin.runId}`} style={{ color: "inherit" }}>{m.origin.runId.slice(0, 8)}</Link></>}
										</td>
										<td className="muted" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.repo}>
											{m.repo ?? "—"}{m.branch ? <span className="mono">@{m.branch.slice(0, 14)}</span> : ""}
										</td>
										<td className="num muted">{m.injectedCount ?? 0}</td>
										<td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
											<button className="btn ghost sm" title="Details" onClick={() => sel(m)}>👁</button>
											<button className="btn ghost sm" title="Edit" onClick={() => { sel(m); setEditing(true); }}>✎</button>
											<button className="btn ghost sm" title="Delete" onClick={() => void doDelete([m.memoryId])}>🗑</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{filtered.length === 0 && !loading && <Empty>No memories match.</Empty>}
						<div className="mem-pager">
							<span className="muted">Showing {(page - 1) * PAGE + (pageRows.length ? 1 : 0)}–{(page - 1) * PAGE + pageRows.length} of {filtered.length} memories</span>
							<span>
								<button className="sbx-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
								{Array.from({ length: pageCount }, (_, i) => i + 1).slice(0, 9).map((p) => (
									<button key={p} className={`sbx-btn${p === page ? " primary" : ""}`} onClick={() => setPage(p)}>{p}</button>
								))}
								<button className="sbx-btn" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>›</button>
							</span>
						</div>
					</div>

					{selected && (
						<div className="card mem-rail">
							<div className="chart-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
								Memory Details
								<span style={{ display: "flex", gap: 4 }}>
									<button className="sbx-btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => setEditing(!editing)}>✎ {editing ? "Cancel" : "Edit"}</button>
									<button className="sbx-btn" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => sel(null)}>✕</button>
								</span>
							</div>
							{editing ? (
								<div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
									<textarea className="mem-edit" rows={6} value={editContent} onChange={(e) => setEditContent(e.target.value)} />
									<select value={editScope} onChange={(e) => setEditScope(e.target.value)}>
										<option value="conversation">conversation</option>
										<option value="project">project</option>
									</select>
									<input placeholder="tags (comma separated)" value={editTags} onChange={(e) => setEditTags(e.target.value)} />
									<button className="sbx-btn primary" onClick={() => void doUpdate()}>Save</button>
								</div>
							) : (
								<>
									<div className="mem-content">{selected.content}</div>
									<div style={{ marginTop: 12 }}>
										{([
											["Type", selected.scope],
											["Status", selected.status],
											["Source", selected.origin?.kind ?? "agent"],
											["Session", selected.sessionId === "manual" ? "—" : selected.sessionId.slice(0, 12)],
											["Run", selected.origin?.runId?.slice(0, 12) ?? "—"],
											["Workspace", selected.repo ? `${selected.repo}${selected.branch ? `@${selected.branch}` : ""}` : "—"],
											["Hits", String(selected.injectedCount ?? 0)],
											["W–L", (selected.helpedRuns ?? 0) > 0 || (selected.failedRuns ?? 0) > 0 ? `${selected.helpedRuns ?? 0}–${selected.failedRuns ?? 0}` : "—"],
											["Created", fmt(selected.createdAt)],
											["Last recalled", selected.lastRecalledAt ? fmt(selected.lastRecalledAt) : "—"],
											["Version", String(selected.version ?? 1)],
										] as const).map(([k, v]) => (
											<div key={k} className="sbx-kv"><span className="k">{k}</span><span className="mono" style={{ fontSize: 11.5 }}>{v}</span></div>
										))}
									</div>
									{(selected.tags ?? []).length > 0 && (
										<div className="mem-tags">
											{selected.tags!.map((t) => <span key={t} className="mem-tag">{t}</span>)}
										</div>
									)}
								</>
							)}
							<div style={{ display: "flex", gap: 6, marginTop: 14 }}>
								<button className="sbx-btn" onClick={() => void doRecall(selected.content.slice(0, 200), true)}>⟲ Recall</button>
								{!editing && <button className="sbx-btn" onClick={() => setEditing(true)}>✎ Update</button>}
								<button className="sbx-btn danger" onClick={() => void doDelete([selected.memoryId])}>🗑 Delete</button>
							</div>
							{recallOut && <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>{recallOut}</div>}
						</div>
					)}
				</div>
			)}

			{tab === "search" && (
				<>
					<div className="card" style={{ padding: 14, marginBottom: 12 }}>
						<div style={{ display: "flex", gap: 8 }}>
							<input placeholder="Test a recall query — returns ranked memories with vector scores" style={{ flex: 1 }}
								value={recallQ} onChange={(e) => setRecallQ(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && void doRecall(recallQ)} />
							<button className="sbx-btn primary" onClick={() => void doRecall(recallQ)}>Recall</button>
						</div>
						{recallRes && (
							<div style={{ marginTop: 10 }}>
								<div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
									{recallRes.docs.length} result{recallRes.docs.length === 1 ? "" : "s"} · {recallRes.tookMs}ms{!recallRes.embedded && " · no embedder — keyword fallback"}
								</div>
								{recallRes.docs.map((d) => (
									<div key={d.memoryId} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
										{d.score != null && <span className="sess-pill completed" style={{ fontSize: 10 }}>{d.score.toFixed(2)}</span>}
										<span className="sess-pill running" style={{ fontSize: 10 }}>{d.scope}</span>
										<span>{d.content}</span>
									</div>
								))}
							</div>
						)}
					</div>
					<div className="card table-card">
						{loading && events.length === 0 ? (
							<div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}><Skeleton height={32} /><Skeleton height={32} /><Skeleton height={32} /></div>
						) : (
							<table>
								<thead>
									<tr><th>Time</th><th>Source</th><th>Op</th><th>Path</th><th>Session / Run</th><th>Task / Workspace</th><th>Detail</th></tr>
								</thead>
								<tbody>
									{events.map((e, i) => {
										const p = pathLabel(e);
										const sid = e.sessionId || e.session;
										return (
											<tr key={i}>
												<td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(e.at)}</td>
												<td className="muted">{e.source}{typeof e.device === "string" && e.device ? `·${e.device}` : ""}</td>
												<td className="mono" style={{ fontSize: 11.5 }}>{e.op ?? "—"}</td>
												<td>{p.text === "—" ? "—" : <span className={`sess-pill ${p.cls}`}>{p.text}</span>}</td>
												<td className="muted mono">
													{sid ? <Link href={`/sessions/${sid}`} style={{ color: "inherit" }}>{sid.slice(0, 8)}</Link> : "—"}
													{e.runId && <> / <Link href={`/runs/${e.runId}`} style={{ color: "inherit" }}>{e.runId.slice(0, 10)}</Link></>}
												</td>
												<td className="muted" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.task ?? e.workspace}>{e.task ?? e.workspace ?? "—"}</td>
												<td className="muted" style={{ fontSize: 11.5, whiteSpace: "normal", minWidth: 220 }}>
													{detail(e)}
													{injected(e).length > 0 && (
														<button className="btn ghost sm" style={{ marginTop: 3, fontSize: 10.5, padding: "1px 6px" }}
															onClick={() => setOpenItems({ title: `${String(e.op ?? "event")} — ${injected(e).length} injected`, items: injected(e) })}>
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
							<Empty>No memory events yet — recalls, writes and index runs appear here.</Empty>
						)}
					</div>
				</>
			)}

			{(tab === "groups" || tab === "policies") && (
				<div className="card" style={{ padding: 40, textAlign: "center" }}>
					<Empty>
						{tab === "groups" ? "Memory groups — organize memories into named collections. Coming soon." : "Recall policies — rules for when and which memories get injected. Coming soon."}
					</Empty>
				</div>
			)}

			{tab === "tuning" && (
				<>
					<div className="card table-card">
						<table>
							<thead><tr><th>Embedding op</th><th>Calls</th><th>Tokens in</th><th>Failed</th></tr></thead>
							<tbody>
								{embedOps.map(([op, v]) => (
									<tr key={op}><td className="mono">{op}</td><td className="num">{v.calls.toLocaleString()}</td><td className="num">{fmtTok(v.tokensIn)}</td><td className="num">{v.failed || "—"}</td></tr>
								))}
								{!embedOps.length && <tr><td colSpan={4} className="muted" style={{ padding: 14 }}>No embedding calls in this range.</td></tr>}
							</tbody>
						</table>
					</div>
					<div className="card" style={{ padding: 16, marginTop: 12, fontSize: 12 }}>
						<div className="chart-title" style={{ marginBottom: 8 }}>Lifecycle policies (automatic)</div>
						{([
							["Stale candidates", "candidates never injected are superseded after a decay window"],
							["Poison memories", "active memories only seen in failed runs are superseded"],
							["Unrecalled", "active memories not recalled for 90d are superseded"],
							["Superseded TTL", "superseded docs are hard-deleted after a retention window"],
							["Dedupe", "near-identical embeddings (score ≥ 0.97) merge instead of duplicating"],
						] as const).map(([k, v]) => (
							<div key={k} className="sbx-kv"><span className="k">{k}</span><span className="muted">{v}</span></div>
						))}
						<div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
							Total embed calls: {embedCalls.toLocaleString()} · {fmtTok(embedTokens)} tokens
						</div>
					</div>
				</>
			)}

			{addOpen && (
				<Modal title="Add Memory" onClose={() => setAddOpen(false)}>
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						<textarea className="mem-edit" rows={5} placeholder="One concise fact to remember…" value={newMem.content} onChange={(e) => setNewMem({ ...newMem, content: e.target.value })} />
						<select value={newMem.scope} onChange={(e) => setNewMem({ ...newMem, scope: e.target.value })}>
							<option value="conversation">conversation — recalls within one session</option>
							<option value="project">project — recalls across sessions on a repo</option>
						</select>
						<input placeholder="repo (owner/name, for project scope)" value={newMem.repo} onChange={(e) => setNewMem({ ...newMem, repo: e.target.value })} />
						<input placeholder="tags (comma separated)" value={newMem.tags} onChange={(e) => setNewMem({ ...newMem, tags: e.target.value })} />
						<button className="sbx-btn primary" onClick={() => void doCreate()}>Save Memory</button>
					</div>
				</Modal>
			)}

			{importOpen && (
				<Modal title="Import Memories" onClose={() => setImportOpen(false)}>
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						<textarea className="mem-edit" rows={8} placeholder='Paste {"docs":[...]} or a JSON array of memory docs' value={importText} onChange={(e) => setImportText(e.target.value)} />
						<div style={{ display: "flex", gap: 8 }}>
							<button className="sbx-btn" onClick={() => fileRef.current?.click()}>Choose file…</button>
							<input ref={fileRef} type="file" accept=".json" style={{ display: "none" }}
								onChange={(e) => { const f0 = e.target.files?.[0]; if (f0) void f0.text().then(setImportText); }} />
							<button className="sbx-btn primary" onClick={() => void doImport()}>Import</button>
						</div>
						<div className="muted" style={{ fontSize: 11 }}>Up to 200 docs per import. Re-embedded on import when an embedder is configured.</div>
					</div>
				</Modal>
			)}

			{openItems && (
				<Modal title={openItems.title} onClose={() => setOpenItems(null)}>
					<div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "60vh", overflowY: "auto" }}>
						{openItems.items.map((t, i) => (
							<div key={i} className="mono" style={{ fontSize: 11.5, padding: "6px 8px", background: "var(--card-bg, rgba(255,255,255,0.03))", borderRadius: 6 }}>
								{t.score != null && <span className="sess-pill completed" style={{ marginRight: 6, fontSize: 10 }}>{t.score.toFixed(2)}</span>}
								{t.branch && <span className="sess-pill running" style={{ marginRight: 6, fontSize: 10 }}>@{t.branch}</span>}
								{t.text}
							</div>
						))}
					</div>
				</Modal>
			)}
		</>
	);
}
