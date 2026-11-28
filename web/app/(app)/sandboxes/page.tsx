"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Empty } from "@/components/Empty";
import { Skeleton } from "@/components/Skeleton";
import { SandboxDetailPanel } from "@/components/SandboxDetailPanel";
import { BOOT_SOURCE } from "@/lib/sandboxLifecycle";

// Provider's stock/public images — used to label boot provenance on rows
// written before `source` was recorded.
const PUBLIC_TEMPLATES = new Set(["desktop", "code-interpreter-v1", "kernel-browser"]);
import { apiFetch, useUser } from "@/lib/api";

interface LiveVm { sandboxId: string; templateId?: string; state?: string; startedAt?: string }
interface Hist { sandboxId?: string; device?: string; deviceId?: string; template?: string; templateId?: string; repo?: string; runId?: string; event?: string; state?: string; source?: string; reason?: string; sessionId?: string; at?: string; createdAt?: string }
interface ProviderStatus { name: string; configured: boolean; reason?: string }
interface BakeDoc { name?: string; recipe?: string; status?: string; snapshotId?: string; templateId?: string; bakedAt?: string; error?: string; kind?: string; source?: string; commands?: string; verify?: string; description?: string }
interface RecipeMeta { key: string; imageName: string; base?: string; tools?: string[]; description?: string }
interface RepoTemplateDoc { key?: string; repo?: string; status?: string; depsOk?: boolean; snapshotId?: string; updatedAt?: string; error?: string; template?: string; baseTemplate?: string }
interface TemplatesRes { bakes: BakeDoc[]; repoTemplates?: RepoTemplateDoc[]; templates: { id: string; names: string[]; public: boolean }[]; recipes: RecipeMeta[]; flags: { templateBuildApi: boolean } }

const fmt = (v?: string) => (v ? new Date(v).toLocaleString() : "—");

export default function SandboxesPage() {
	const user = useUser();
	const router = useRouter();
	const [live, setLive] = useState<LiveVm[]>([]);
	const [history, setHistory] = useState<Hist[]>([]);

	const [expanded, setExpanded] = useState<string | null>(null);
	const [providers, setProviders] = useState<ProviderStatus[]>([]);
	const [, setLiveEnabled] = useState(false);
	const [loading, setLoading] = useState(true);
	const [msg, setMsg] = useState("");
	const [tab, setTab] = useState<"live" | "history" | "templates">("live");
	const [tmplTab, setTmplTab] = useState<"all" | "mine" | "shared">("all");
	const [imgs, setImgs] = useState<TemplatesRes | null>(null);

	const load = async () => {
		if (!user) return;
		const res = await apiFetch("/api/sandboxes", user);
		if (res.ok) {
			const b = (await res.json()) as { live: LiveVm[]; history: Hist[]; providers?: ProviderStatus[]; liveEnabled: boolean };
			setLive(b.live); setHistory(b.history); setProviders(b.providers ?? []); setLiveEnabled(b.liveEnabled);
		}
		setLoading(false);
	};
	const loadTemplates = async () => {
		if (!user) return;
		const res = await apiFetch("/api/templates", user);
		if (res.ok) setImgs((await res.json()) as TemplatesRes);
	};
	const bake = async (recipe: string) => {
		if (!user) return;
		setMsg(`Baking ${recipe}… (a few minutes — refresh to see status)`);
		const res = await apiFetch("/api/templates/bake", user, { method: "POST", body: JSON.stringify({ recipe }) });
		setMsg(res.ok ? "Bake queued — a stock VM installs the recipe, then snapshots." : `Bake failed: ${res.status}`);
		void loadTemplates();
	};
	const removeImage = async (name: string) => {
		if (!user || !confirm(`Delete image ${name}? Its snapshot is removed too.`)) return;
		await apiFetch(`/api/templates/${encodeURIComponent(name)}`, user, { method: "DELETE" });
		void loadTemplates();
	};
	// deps: load once per user identity, not per render.
	useEffect(() => { void load(); void loadTemplates(); }, [user]);
	// Poll bake status while any image is in flight.
	useEffect(() => {
		const busy =
			imgs?.bakes.some((b) => b.status === "baking" || b.status === "building") ||
			imgs?.repoTemplates?.some((r) => r.status === "building");
		if (!busy) return;
		const t = setInterval(() => void loadTemplates(), 5000);
		return () => clearInterval(t);
		// deps: poll toggles only on bake-in-flight transitions.
	}, [imgs?.bakes.some((b) => b.status === "baking" || b.status === "building")]);

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
	const snapshot = async (id: string) => {
		if (!user) return;
		setMsg(`Snapshotting ${id.slice(0, 8)}…`);
		const res = await apiFetch(`/api/sandboxes/${id}/snapshot`, user, { method: "POST", body: "{}" });
		const b = res.ok ? await res.json().catch(() => null) : null;
		setMsg(res.ok ? `Snapshot saved${b?.snapshotId ? ` (${String(b.snapshotId).slice(0, 16)}…)` : ""}.` : "Snapshot failed.");
	};
	const resume = async (id: string) => {
		if (!user) return;
		setMsg(`Resuming ${id.slice(0, 8)}…`);
		const res = await apiFetch(`/api/sandboxes/${id}/resume`, user, { method: "POST" });
		setMsg(res.ok ? "Resumed." : "Resume failed.");
		void load();
	};

	const expandedPanel = (h: Hist) => (
		<div style={{ padding: "10px 14px 12px" }} onClick={(e) => e.stopPropagation()}>
			<SandboxDetailPanel id={h.sandboxId!} />
			<a href={`/sandboxes/${h.sandboxId}`} className="muted" style={{ fontSize: 11, display: "inline-block", marginTop: 10 }}>
				Open full details ›
			</a>
		</div>
	);

	if (!user) return null;
	// Repo → durable template binding — pure master data, no rebake.
	const mapRepo = async (repo: string, template: string | null) => {
		await apiFetch("/api/templates/map", user, { method: "POST", body: JSON.stringify({ repo, template }) });
		void loadTemplates();
	};

	// Boot provenance — recorded `source` wins; fall back to inferring from
	// the template name for rows written before sources existed.
	const bootSource = (h: Hist) => {
		if (h.source) return BOOT_SOURCE[h.source] ?? h.source;
		if (h.template?.startsWith("kronyx-repo-")) return "warm snapshot";
		if (h.template?.startsWith("kronyx-wip-")) return "session checkpoint";
		if (!h.template || h.template === "base") return "base image";
		if (PUBLIC_TEMPLATES.has(h.template)) return "provider image";
		return "durable template";
	};

	const liveRows = history.filter((h) => ["active", "running", "paused"].includes(h.state ?? ""));

	const deadRows = history.filter((h) => !["active", "running", "paused"].includes(h.state ?? ""));
	const myBakes = imgs?.bakes ?? [];
	const shared = (imgs?.templates ?? []).filter((t) => t.public);
	const catalogCount = myBakes.length + (imgs?.templates.length ?? 0);

	return (
		<div className="page">
			<div className="sbx-head" style={{ marginBottom: 14 }}>
				<h1>Sandboxes</h1>
				<div className="sub">Run, pause and manage agent sandboxes with full lifecycle control.</div>
			</div>
			{providers.length > 0 && (
				<div className="sbx-providers" style={{ marginBottom: 16 }}>
					{providers.map((p) => (
						<span key={p.name} className={`chip ${p.configured ? "on" : "off"}`} title={p.configured ? `${p.name} enabled` : p.reason}>
							<span className="dot" />{p.name} · {p.configured ? "enabled" : "not configured"}
						</span>
					))}
				</div>
			)}
			<div className="sbx-stats" style={{ marginBottom: 20 }}>
				<div className="sbx-stat">
					<div className="k">Live</div>
					<div className="v">{liveRows.length}</div>
					<div className="s">{liveRows.filter((v) => v.state !== "paused").length} running · {liveRows.filter((v) => v.state === "paused").length} paused</div>
				</div>
				<div className="sbx-stat">
					<div className="k">History</div>
					<div className="v">{deadRows.length}</div>
					<div className="s">dead / inaccessible / replaced</div>
				</div>
			</div>

			<div className="sbx-tabs" style={{ marginBottom: 14 }}>
				{(["live", "history", "templates"] as const).map((t) => (
					<button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
						{t === "live" ? `Live (${liveRows.length})` : t === "history" ? `History (${deadRows.length})` : `Templates (${catalogCount})`}
					</button>
				))}
			</div>

			{loading && <Skeleton height={200} />}
			{!loading && live.length === 0 && history.length === 0 && tab !== "templates" && <Empty>No sandboxes yet — start a cloud session.</Empty>}

			{tab === "live" && liveRows.length > 0 && (
				<div className="card table-card">
					<table className="sbx-table">
						<thead><tr><th>Sandbox</th><th>State</th><th>Session</th><th>Repo</th><th>Template</th><th>Created</th><th>Last event</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
						<tbody>
							{liveRows.map((h, i) => (
								<Fragment key={i}>
								<tr className="clickable" onClick={() => { window.location.href = `/sandboxes/${h.sandboxId}`; }}>
									<td className="mono">
										<span
											style={{ cursor: "pointer", display: "inline-block", width: 14 }}
											onClick={(e) => { e.stopPropagation(); setExpanded(expanded === h.sandboxId ? null : h.sandboxId!); }}
										>
											{expanded === h.sandboxId ? "▾" : "▸"}
										</span>
										{(h.sandboxId ?? "").slice(0, 16)}
									</td>
									<td><span className={`sbx-pill ${h.state ?? ""}`}>{h.state}</span></td>
									<td className="muted mono" onClick={(e) => e.stopPropagation()}>{h.sessionId ? <a href={`/sessions/${h.sessionId}`}>{h.sessionId.slice(0, 8)}</a> : "—"}</td>
									<td className="muted">{h.repo || "—"}</td>
									<td className="muted" title={h.templateId ?? undefined}>{h.template ?? "—"}{h.templateId && <div className="sub2">·{h.templateId.slice(0, 10)}</div>}{bootSource(h) && <div className="sub2">{bootSource(h)}</div>}</td>
									<td className="muted">{fmt(h.createdAt)}</td>
									<td className="muted">{fmt(h.at)}</td>
									<td style={{ whiteSpace: "nowrap", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
										{h.state === "paused" && <button className="sbx-btn primary" onClick={() => void resume(h.sandboxId!)}>▶ Resume</button>}{" "}
										{h.state !== "paused" && <button className="sbx-btn" onClick={() => void pause(h.sandboxId!)}>⏸ Pause</button>}{" "}
										{h.state !== "paused" && <button className="sbx-btn" onClick={() => void snapshot(h.sandboxId!)}>⧉ Snapshot</button>}{" "}
										<button className="sbx-btn danger" onClick={() => void stop(h.sandboxId!)}>Kill</button>
									</td>
								</tr>
								{expanded === h.sandboxId && (
									<tr>
										<td colSpan={8} style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>{expandedPanel(h)}</td>
									</tr>
								)}
								</Fragment>
							))}
						</tbody>
					</table>
				</div>
			)}
			{tab === "live" && !loading && liveRows.length === 0 && history.length > 0 && <Empty>No live sandboxes.</Empty>}

			{tab === "history" && deadRows.length > 0 && (
				<div className="card table-card">
					<table className="sbx-table">
						<thead><tr><th>Sandbox</th><th>State</th><th>Reason</th><th>Session</th><th>Repo</th><th>Template</th><th>Created</th><th>Last event</th></tr></thead>
						<tbody>
							{deadRows.map((h, i) => (
								<Fragment key={i}>
								<tr className="clickable" onClick={() => { window.location.href = `/sandboxes/${h.sandboxId}`; }}>
									<td className="mono">
										<span
											style={{ cursor: "pointer", display: "inline-block", width: 14 }}
											onClick={(e) => { e.stopPropagation(); setExpanded(expanded === h.sandboxId ? null : h.sandboxId!); }}
										>
											{expanded === h.sandboxId ? "▾" : "▸"}
										</span>
										{(h.sandboxId ?? "").slice(0, 16)}
									</td>
									<td><span className={`sbx-pill ${h.state ?? ""}`}>{h.state ?? h.event ?? "—"}</span></td>
									<td className="muted">{h.reason || "—"}</td>
									<td className="muted mono" onClick={(e) => e.stopPropagation()}>{h.sessionId ? <a href={`/sessions/${h.sessionId}`}>{h.sessionId.slice(0, 8)}</a> : h.device || "—"}</td>
									<td className="muted">{h.repo || "—"}</td>
									<td className="muted" title={h.templateId ?? undefined}>{h.template ?? "—"}{bootSource(h) && <div className="sub2">{bootSource(h)}</div>}</td>
									<td className="muted">{fmt(h.createdAt)}</td>
									<td className="muted">{fmt(h.at)}</td>
								</tr>
								{expanded === h.sandboxId && (
									<tr>
										<td colSpan={8} style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>{expandedPanel(h)}</td>
									</tr>
								)}
								</Fragment>
							))}
						</tbody>
					</table>
				</div>
			)}

			{tab === "templates" && (
				<>
					<div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
						<div className="sbx-tabs" style={{ marginBottom: 0 }}>
							{(["all", "mine", "shared"] as const).map((t) => (
								<button key={t} className={tmplTab === t ? "active" : ""} onClick={() => setTmplTab(t)}>
									{t === "all" ? `All (${catalogCount})` : t === "mine" ? `My Templates (${myBakes.length})` : `Shared (${shared.length})`}
								</button>
							))}
						</div>
						<button className="sbx-btn primary" style={{ marginLeft: "auto" }} onClick={() => router.push("/sandboxes/templates/new")}>+ New Template</button>
					</div>

					<div className="card table-card">
						<table className="sbx-table">
							<thead><tr><th>Template</th><th>Base image</th><th>Tools / stack</th><th>Status</th><th>Snapshot</th><th style={{ textAlign: "right" }}></th></tr></thead>
							<tbody>
								{tmplTab !== "shared" && myBakes.map((b, i) => {
									const recipe = imgs?.recipes.find((r) => r.imageName === b.name || r.key === b.recipe);
									return (
										<tr key={`b${i}`}>
											<td>
												<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
													<span className="sbx-icon">{String(b.name ?? "?")[0].toUpperCase()}</span>
													<span className="mono">{b.name ?? "—"}</span>
													{b.source === "custom" && <span className="sbx-badge">Custom</span>}
												</span>
											</td>
											<td className="muted">{recipe?.base ?? "stock e2b"}</td>
											<td><ToolChips tools={recipe?.tools} fallback={b.source === "custom" ? "custom recipe" : b.recipe} /></td>
											<td><span className={`sbx-pill ${b.status ?? ""}`}>{b.status ?? "—"}</span></td>
											<td className="muted mono" style={{ fontSize: 11 }} title={b.error}>{(b.snapshotId ?? b.templateId ?? "—").slice(0, 20)}</td>
											<td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
												{recipe && <button className="sbx-btn" disabled={b.status === "baking" || b.status === "building"} onClick={() => void bake(recipe.key)}>{b.status === "baking" || b.status === "building" ? "Baking…" : "Re-bake"}</button>}{" "}
												{b.commands && <button className="sbx-btn" onClick={() => router.push(`/sandboxes/templates/new?edit=${encodeURIComponent(String(b.name))}`)}>Edit</button>}{" "}
												<button className="sbx-btn danger" onClick={() => void removeImage(String(b.name))}>Delete</button>
											</td>
										</tr>
									);
								})}
								{tmplTab !== "shared" && (imgs?.recipes ?? [])
									.filter((r) => !myBakes.some((b) => b.name === r.imageName))
									.map((r) => (
										<tr key={r.key}>
											<td>
												<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
													<span className="sbx-icon">{r.imageName[0].toUpperCase()}</span>
													<span className="mono">{r.imageName}</span>
													{r.key === "browser" && <span className="sbx-badge">Default</span>}
												</span>
											</td>
											<td className="muted">{r.base ?? "stock e2b"}</td>
											<td><ToolChips tools={r.tools} fallback={r.description} /></td>
											<td className="muted">not baked</td>
											<td className="muted">—</td>
											<td style={{ textAlign: "right" }}><button className="sbx-btn" onClick={() => void bake(r.key)}>Bake</button></td>
										</tr>
									))}
								{tmplTab !== "mine" && (imgs?.templates ?? [])
									.filter((t) => tmplTab === "all" || t.public)
									.map((t) => (
										<tr key={t.id}>
											<td>
												<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
													<span className="sbx-icon">{String(t.names[0] ?? t.id)[0].toUpperCase()}</span>
													<span className="mono">{t.names[0] ?? t.id}</span>
												</span>
											</td>
											<td className="muted" colSpan={2}>provider template{t.names.length > 1 ? ` (${t.names.slice(1).join(", ")})` : ""}</td>
											<td className="muted">{t.public ? "shared" : "—"}</td>
											<td className="muted mono" style={{ fontSize: 11 }}>{t.id.slice(0, 20)}</td>
											<td></td>
										</tr>
									))}
								{!myBakes.length && tmplTab === "mine" && (
									<tr><td colSpan={6} className="muted" style={{ padding: 16 }}>No baked images yet — bake a builtin recipe or create a custom one.</td></tr>
								)}
							</tbody>
						</table>
					</div>
					{(imgs?.repoTemplates ?? []).length > 0 && (
						<>
							<h3 style={{ fontSize: 13, margin: "18px 0 8px" }}>Repositories</h3>
							<div className="card table-card">
								<table className="sbx-table">
									<thead><tr><th>Repo</th><th>Template</th><th>Warm status</th><th>Deps</th><th>Updated</th><th style={{ textAlign: "right" }}></th></tr></thead>
									<tbody>
										{(imgs?.repoTemplates ?? []).map((r) => (
											<tr key={r.key}>
												<td className="mono" style={{ fontSize: 12 }}>{r.repo ?? "—"}</td>
												<td className="mono" style={{ fontSize: 11 }} title={r.baseTemplate ? `warm base: ${r.baseTemplate}` : undefined}>
												{(() => {
													const durable = Array.from(new Set(
														[
															...(imgs?.bakes ?? []).map((b) => String(b.name ?? "")),
															...(imgs?.templates ?? []).flatMap((t) => t.names),
														].filter((n) => n && !n.startsWith("kronyx-repo-") && !n.startsWith("kronyx-wip-")),
													));
													const opts = r.template && !durable.includes(r.template) ? [r.template, ...durable] : durable;
													return (
														<select
															className="sbx-select"
															value={r.template ?? ""}
															onClick={(e) => e.stopPropagation()}
															onChange={(e) => r.repo && void mapRepo(r.repo, e.target.value || null)}
														>
															<option value="">— none —</option>
															{opts.map((n) => <option key={n} value={n}>{n}</option>)}
														</select>
													);
												})()}
											</td>
												<td><span className={`sbx-pill ${r.status === "ready" ? "running" : r.status === "failed" ? "dead" : "paused"}`} title={r.error}>{r.status ?? "—"}</span></td>
												<td className="muted">{r.depsOk === false ? "install failed" : "ok"}</td>
												<td className="muted">{fmt(r.updatedAt)}</td>
												<td style={{ textAlign: "right" }}>
													<button className="sbx-btn" onClick={() => router.push(`/sandboxes/templates/new?repo=${encodeURIComponent(r.repo ?? "")}`)}>
														{r.status === "building" ? "Building…" : "Re-bake"}
													</button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</>
					)}
					<p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
						My templates are named snapshots built in your account — set one as a session's template to boot from it.
						Shared templates come from the provider catalog. Repositories are warm snapshots baked with the repo cloned and its recipe run.
					</p>
				</>
			)}
			{msg && <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>{msg}</p>}
		</div>
	);
}

/** Tool/stack chips — first 3 + "+N" overflow. */
function ToolChips({ tools, fallback }: { tools?: string[]; fallback?: string }) {
	if (!tools?.length) return <span className="muted" style={{ fontSize: 11 }} title={fallback}>{fallback || "—"}</span>;
	return (
		<span className="sbx-tools" title={tools.join(" · ")}>
			{tools.slice(0, 3).map((t) => <span key={t} className="t">{t}</span>)}
			{tools.length > 3 && <span className="t">+{tools.length - 3}</span>}
		</span>
	);
}
