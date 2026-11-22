"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { apiFetch, useUser } from "@/lib/api";
import type { ModelGroup } from "@/lib/types";

interface RepoOpt { repo: string; defaultBranch: string; installationId: number }
interface RecipeMeta { key: string; imageName: string; base?: string; tools?: string[]; description?: string }
interface ProjectScanRes {
	dir: string;
	stacks: string[];
	tools: string[];
	found: string[];
	needsCustom?: boolean;
	deps?: { prod: { name: string; version: string }[]; dev: { name: string; version: string }[] };
	scripts?: Record<string, string>;
	part: { commands: string[]; verify?: string; tools: string[] };
}
interface ScanRes {
	found?: string[];
	projects?: ProjectScanRes[];
	expected?: Record<string, string[]>;
	recipe?: { name: string; commands: string; verify?: string; tools?: string[]; description?: string; needsCustom?: boolean } | null;
	source?: "rules" | "llm" | "catalog" | "none";
}
type WizType = "repo" | "preset" | "custom";
type Source = "" | "rules" | "llm";

/** Canned preset recipes matching backend ruleRecipe shapes — one-click starts. */
const STACK_ICONS: Record<string, string> = { node: "◈", python: "◆", java: "◍", go: "◇", rust: "⬡", ruby: "❖" };
const STACK_LABELS: Record<string, string> = { node: "Node.js", python: "Python", java: "Java", go: "Go", rust: "Rust", ruby: "Ruby" };
const STACK_KEYS = ["node", "python", "go", "java", "rust", "ruby"];
const STACK_VERSIONS: Record<string, string[]> = {
	node: ["18", "20", "22", "24"],
	go: ["1.21", "1.22", "1.23", "1.24"],
};

/** Per-stack toolchain version override — "auto" follows detection/default. */
function VersionPicker({ stacks, versions, onChange }: { stacks: string[]; versions: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
	const pick = stacks.filter((s) => STACK_VERSIONS[s]);
	if (!pick.length) return null;
	return (
		<div style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "10px 0" }}>
			{pick.map((s) => (
				<label key={s} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
					<span className="muted">{STACK_LABELS[s]} version</span>
					<select
						className="input"
						style={{ padding: "3px 8px", fontSize: 12 }}
						value={versions[s] ?? ""}
						onChange={(e) => {
							const next = { ...versions };
							if (e.target.value) next[s] = e.target.value; else delete next[s];
							onChange(next);
						}}
					>
						<option value="">auto</option>
						{STACK_VERSIONS[s].map((v) => <option key={v} value={v}>{v}.x</option>)}
					</select>
				</label>
			))}
		</div>
	);
}

/** Merge project/stack parts client-side: apt update once, dedup commands. */
function mergeCommands(parts: { commands: string[]; verify?: string; tools: string[] }[]): { commands: string; verify?: string; tools: string[] } {
	const cmds = ["sudo apt-get update -qq"];
	const verify: string[] = [];
	const tools = new Set<string>();
	for (const p of parts) {
		for (const c of p.commands) if (!cmds.includes(c)) cmds.push(c);
		if (p.verify) verify.push(p.verify);
		p.tools.forEach((t) => tools.add(t));
	}
	return { commands: cmds.join(" && "), verify: verify.join(" && ") || undefined, tools: [...tools] };
}

const STEPS = ["Template Type", "Configure", "Build & Validate", "Summary"];
const STEP_SUB = ["Choose how to create the template", "Set up language, tools and dependencies", "Build the template and run checks", "Review and create the template"];

export default function NewTemplatePage() {
	return (
		<Suspense fallback={<div className="sbx-page"><p className="muted">Loading…</p></div>}>
			<Wizard />
		</Suspense>
	);
}

function Wizard() {
	const user = useUser();
	const router = useRouter();
	const params = useSearchParams();
	const editName = params.get("edit");
	const [step, setStep] = useState(editName ? 1 : 0);
	const [type, setType] = useState<WizType>(editName ? "custom" : "repo");
	const [repos, setRepos] = useState<RepoOpt[]>([]);
	const [branches, setBranches] = useState<string[]>([]);
	const [repo, setRepo] = useState(params.get("repo") ?? "");
	const [branch, setBranch] = useState("");
	const [scan, setScan] = useState<ScanRes | null>(null);
	const [scanning, setScanning] = useState(false);
	const [source, setSource] = useState<Source>("");
	const [depsTab, setDepsTab] = useState<"prod" | "dev">("prod");
	const [depsProj, setDepsProj] = useState(0);
	const [selDirs, setSelDirs] = useState<Set<string>>(new Set());
	const [stackSel, setStackSel] = useState<Set<string>>(new Set());
	const [versions, setVersions] = useState<Record<string, string>>({});
	const [expected, setExpected] = useState<Record<string, string[]> | null>(null);
	const [showDetails, setShowDetails] = useState(false);
	const [editRecipe, setEditRecipe] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [commands, setCommands] = useState("sudo apt-get update -qq\n");
	const [verify, setVerify] = useState("");
	const [timeoutMin, setTimeoutMin] = useState(20);
	const [includeRepo, setIncludeRepo] = useState(true);
	const [defaultForRepo, setDefaultForRepo] = useState(true);
	const [builtin, setBuiltin] = useState<RecipeMeta[]>([]);
	const [groups, setGroups] = useState<ModelGroup[]>([]);
	const [pick, setPick] = useState<{ profile: string; modelId: string } | null>(null);
	const [msg, setMsg] = useState("");
	const [building, setBuilding] = useState<{ name: string; kind: "api-build" | "repo" } | null>(null);
	const [buildDoc, setBuildDoc] = useState<{ status?: string; error?: string; bakedAt?: string } | null>(null);
	const [buildStart, setBuildStart] = useState(0);
	const [elapsed, setElapsed] = useState(0);
	const nameOk = /^[a-z0-9][a-z0-9-]{2,40}$/.test(name.trim().toLowerCase());
	const inst = repos.find((r) => r.repo === repo);
	const projects = useMemo(() => scan?.projects ?? [], [scan]);
	const selProjects = useMemo(() => projects.filter((p) => selDirs.has(p.dir)), [projects, selDirs]);
	const firstWithScripts = selProjects.find((p) => p.scripts && Object.keys(p.scripts).length);
	const scriptNames = useMemo(() => Object.keys(firstWithScripts?.scripts ?? {}).filter((s) => ["build", "dev", "start", "test"].includes(s)), [firstWithScripts]);
	const choosePick = (value: string) => {
		const [profile, modelId] = value ? (JSON.parse(value) as [string, string]) : ["", ""];
		setPick(profile && modelId ? { profile, modelId } : null);
		if (profile && modelId) {
			localStorage.setItem("kronyx.modelProfile", profile);
			localStorage.setItem("kronyx.modelId", modelId);
		}
	};
	const allTools = useMemo(() => [...new Set(selProjects.flatMap((p) => p.tools))], [selProjects]);

	// The composer's model pick is shared with the web composer; it writes the recipe the scan may generate.
	useEffect(() => {
		const profile = localStorage.getItem("kronyx.modelProfile") ?? "";
		const modelId = localStorage.getItem("kronyx.modelId") ?? "";
		if (profile && modelId) setPick({ profile, modelId });
	}, []);

	useEffect(() => {
		if (!user) return;
		void apiFetch("/api/models", user).then(async (r) => r.ok && setGroups(((await r.json()) as { groups?: ModelGroup[] }).groups ?? [])).catch(() => undefined);
	}, [user]);

	useEffect(() => {
		if (!user) return;
		void apiFetch("/api/github/repos", user).then(async (r) => r.ok && setRepos(((await r.json()) as { repos?: RepoOpt[] }).repos ?? [])).catch(() => undefined);
		void apiFetch("/api/templates", user)
			.then(async (r) => {
				if (!r.ok) return;
				const b = (await r.json()) as { recipes?: RecipeMeta[]; bakes?: { name?: string; commands?: string; verify?: string; description?: string }[] };
				setBuiltin(b.recipes ?? []);
				if (editName) {
					const doc = b.bakes?.find((x) => x.name === editName);
					if (doc?.commands) {
						setName(doc.name ?? editName);
						setCommands(doc.commands);
						setVerify(doc.verify ?? "");
						setDescription(doc.description ?? "");
						setEditRecipe(true);
					}
				}
			})
			.catch(() => undefined);
	}, [user]);

	// Auto-scan when repo+branch resolve.
	useEffect(() => {
		if (!user || !repo || !inst) return;
		setScanning(true);
		setScan(null);
		void apiFetch("/api/templates/scan", user, { method: "POST", body: JSON.stringify({ repo, installationId: inst.installationId, ref: branch || undefined, versions: Object.keys(versions).length ? versions : undefined, profile: pick?.profile, modelId: pick?.modelId }) })
			.then(async (r) => {
				if (!r.ok) return;
				const b = (await r.json()) as ScanRes;
				setScan(b);
				setSelDirs(new Set((b.projects ?? []).map((p) => p.dir)));
				if (b.recipe) {
					setName(b.recipe.name);
					setDescription(b.recipe.description ?? "");
					setSource(b.source === "llm" ? "llm" : "rules");
				}
			})
			.finally(() => setScanning(false));
	}, [user, repo, branch, inst, versions, pick]);

	// Branches for the picked repo.
	useEffect(() => {
		setBranches([]);
		setBranch("");
		if (!user || !repo || !inst) return;
		void apiFetch(`/api/github/branches?installationId=${inst.installationId}&repo=${encodeURIComponent(repo)}`, user)
			.then(async (r) => {
				if (!r.ok) return;
				const b = (await r.json()) as { branches?: string[] };
				setBranches(b.branches ?? []);
				setBranch(inst.defaultBranch || b.branches?.[0] || "");
			})
			.catch(() => undefined);
	}, [user, repo, inst]);

	// Re-merge recipe when the project/stack selection changes.
	useEffect(() => {
		if (type === "repo" && selProjects.length) {
			const m = mergeCommands(selProjects.map((p) => p.part));
			setCommands(m.commands);
			setVerify(m.verify ?? "");
		}
	}, [selProjects, type]);

	// Catalog mode: stack picker → expected files + merged recipe.
	useEffect(() => {
		if (!user || (type !== "preset" && type !== "custom") || !stackSel.size) { setExpected(null); return; }
		const stacks = [...stackSel];
		void apiFetch("/api/templates/scan", user, { method: "POST", body: JSON.stringify({ stacks, versions: Object.keys(versions).length ? versions : undefined }) })
			.then(async (r) => {
				if (!r.ok) return;
				const b = (await r.json()) as ScanRes;
				setExpected(b.expected ?? null);
				if (b.recipe) { setCommands(b.recipe.commands); setVerify(b.recipe.verify ?? ""); setDescription(b.recipe.description ?? ""); if (!name.trim()) setName(b.recipe.name); }
			})
			.catch(() => undefined);
	}, [user, stackSel, type, versions]);

	const pickPreset = (key: string) => {
		setType("preset");
		setStackSel(new Set([key]));
		setName(`${key}-env`);
		setStep(1);
	};

	const submit = async () => {
		if (!user) return;
		const body = {
			name: name.trim().toLowerCase(), commands, verify: verify.trim() || undefined,
			timeoutMin, description: description.trim() || undefined,
			repo: type === "repo" && includeRepo ? repo : undefined,
			installationId: type === "repo" && includeRepo ? inst?.installationId : undefined,
			includeRepo: type === "repo" && includeRepo,
			defaultForRepo: type === "repo" && repo && (!includeRepo ? defaultForRepo : false) ? repo : undefined,
		};
		const res = await apiFetch("/api/templates/bake", user, { method: "POST", body: JSON.stringify(body) });
		if (res.ok) {
			setBuilding({ name: body.name, kind: body.includeRepo ? "repo" : "api-build" });
			setBuildStart(Date.now());
			setElapsed(0);
		} else setMsg(`Bake failed: ${res.status}`);
	};

	// Poll the build until ready/error — the job keeps running server-side if the user leaves.
	useEffect(() => {
		if (!user || !building) return;
		let alive = true;
		const tick = async () => {
			const res = await apiFetch("/api/templates", user).catch(() => null);
			if (!res?.ok || !alive) return;
			const b = (await res.json()) as {
				bakes?: { name?: string; kind?: string; status?: string; error?: string; bakedAt?: string }[];
				repoTemplates?: { repo?: string; status?: string; error?: string }[];
			};
			const doc =
				building.kind === "repo"
					? b.repoTemplates?.find((r) => r.repo === repo)
					: b.bakes?.find((x) => x.name === building.name && x.kind === "api-build");
			if (doc) setBuildDoc(doc);
		};
		void tick();
		const t = setInterval(() => { void tick(); setElapsed(Date.now() - buildStart); }, 4000);
		return () => { alive = false; clearInterval(t); };
	}, [user, building, buildStart, repo]);

	const done = buildDoc?.status === "ready";
	const failed = buildDoc?.status === "error" || buildDoc?.status === "failed";

	return (
		<div className="sbx-page" style={{ maxWidth: 1160 }}>
			<p className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
				<Link href="/sandboxes?tab=templates" style={{ color: "inherit" }}>Templates</Link> &nbsp;›&nbsp; Create Template
			</p>
			<h1 className="sbx-title">{editName ? "Edit Sandbox Template" : "Create Sandbox Template"}</h1>
			<p className="sbx-sub">{editName ? `Editing ${editName} — saving re-builds and supersedes the current image.` : "Create a reusable sandbox template from a language preset, a repository, or a custom configuration."}</p>

			<div className="wiz">
				<aside className="wiz-rail">
					{STEPS.map((s, i) => (
						<div key={s} className={`wiz-step ${i < step ? "done" : i === step ? "current" : ""}`} onClick={() => i < step && setStep(i)} role="button">
							<span className="node">{i < step ? "✓" : i + 1}</span>
							<span className="txt"><b>{s}</b><small>{STEP_SUB[i]}</small></span>
						</div>
					))}
					<div className="wiz-presets">
						<p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}><b>Language Presets</b><br />Pre-configured, ready-to-use templates</p>
						{STACK_KEYS.map((k) => (
							<button key={k} className="wiz-preset" onClick={() => pickPreset(k)}>
								<span className="sbx-icon">{STACK_ICONS[k]}</span> {STACK_LABELS[k]}
							</button>
						))}
						{builtin.map((b) => (
							<button key={b.key} className="wiz-preset" title={b.description} onClick={() => { setType("preset"); setName(b.imageName); setDescription(b.description ?? ""); setStep(1); }}>
								<span className="sbx-icon">{b.imageName[0].toUpperCase()}</span> {b.imageName}
							</button>
						))}
					</div>
				</aside>

				<main className="wiz-main">
					{building ? (
						<div style={{ textAlign: "center", padding: "40px 20px" }}>
							{!done && !failed && (
								<>
									<div className="wiz-spinner" />
									<h2 style={{ fontSize: 15, margin: "14px 0 4px" }}>Building {building.kind === "repo" ? "warm snapshot" : "template"}…</h2>
									<p className="muted" style={{ fontSize: 12 }}>
										<span className="mono">{building.name}</span> · {buildDoc?.status ?? "queued"} · {Math.round(elapsed / 1000)}s elapsed
									</p>
									<p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
										You can leave this page — the build continues in the background and shows on the Templates tab.
									</p>
									<button className="sbx-btn" style={{ marginTop: 8 }} onClick={() => router.push("/sandboxes?tab=templates")}>Close — keep building</button>
								</>
							)}
							{done && (
								<>
									<div style={{ fontSize: 34, color: "var(--ok, #3fb950)" }}>✓</div>
									<h2 style={{ fontSize: 15, margin: "10px 0 4px" }}>Template ready</h2>
									<p className="muted" style={{ fontSize: 12 }}>
										<span className="mono">{building.name}</span> built in {Math.round(elapsed / 1000)}s — usable as a session template.
									</p>
									<button className="sbx-btn primary" style={{ marginTop: 8 }} onClick={() => router.push("/sandboxes?tab=templates")}>View templates</button>
								</>
							)}
							{failed && (
								<>
									<div style={{ fontSize: 34, color: "var(--err)" }}>✗</div>
									<h2 style={{ fontSize: 15, margin: "10px 0 4px" }}>Build failed</h2>
									<p className="muted" style={{ fontSize: 12 }}>{buildDoc?.error ?? "unknown error"}</p>
									<div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 8 }}>
										<button className="sbx-btn" onClick={() => { setBuilding(null); setBuildDoc(null); }}>Edit recipe</button>
										<button className="sbx-btn primary" onClick={() => { setBuildDoc(null); void submit(); }}>Retry</button>
									</div>
								</>
							)}
						</div>
					) : (
					<>
					<h2 style={{ fontSize: 15, margin: "0 0 4px" }}>{step + 1}. {STEPS[step]}</h2>
					<p className="muted" style={{ fontSize: 12, marginBottom: 16 }}>
						{step === 0 ? "Start from a language preset, detect from a repository, or build a custom template."
							: step === 1 ? "Name the template and adjust the generated recipe."
							: step === 2 ? "Check the recipe before building — a failed command fails the bake."
							: "Review and create the template."}
					</p>

					{step === 0 && (
						<>
							<div className="wiz-types">
								{([
									{ k: "repo" as const, t: "From Repository", d: "Provide a repository and automatically detect the language, dependencies and build setup." },
									{ k: "preset" as const, t: "From Language Preset", d: "Start with a pre-configured environment for a specific language or framework." },
									{ k: "custom" as const, t: "Custom Template", d: "Manually configure the base image, runtimes, tools and build steps." },
								]).map((o) => (
									<button key={o.k} className={`wiz-type ${type === o.k ? "sel" : ""}`} onClick={() => setType(o.k)}>
										<span className="dot" />
										<b>{o.t}</b>
										<small>{o.d}</small>
									</button>
								))}
							</div>

							{type === "repo" && (
								<>
									<div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
										<label style={{ flex: 2, minWidth: 220 }}>
											<span className="muted" style={{ fontSize: 12 }}>Repository *</span>
											<select className="input" style={{ width: "100%" }} value={repo} onChange={(e) => setRepo(e.target.value)}>
												<option value="">Select a repository…</option>
												{repos.map((r) => <option key={r.repo} value={r.repo}>{r.repo}</option>)}
											</select>
										</label>
										<label style={{ flex: 1, minWidth: 140 }}>
											<span className="muted" style={{ fontSize: 12 }}>Branch</span>
											<select className="input" style={{ width: "100%" }} value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!repo}>
												{branches.map((b) => <option key={b} value={b}>{b}</option>)}
												{!branches.length && <option value="">{repo ? "loading…" : "—"}</option>}
											</select>
										</label>
									</div>

									<label style={{ display: "block", marginTop: 12 }}>
										<span className="muted" style={{ fontSize: 12 }}>Model — writes the environment recipe when no built-in recipe matches</span>
										<select className="input" style={{ width: "100%" }} value={pick ? JSON.stringify([pick.profile, pick.modelId]) : ""} onChange={(e) => choosePick(e.target.value)}>
											<option value="">Select a model…</option>
											{groups.map((g) => (
												<optgroup key={g.profile} label={`${g.profile}${g.active ? " · active" : ""}`}>
													{g.models.map((m) => (
														<option key={`${g.profile}:${m.id}`} value={JSON.stringify([g.profile, m.id])}>{m.label ?? m.id}</option>
													))}
												</optgroup>
											))}
										</select>
									</label>
									{scanning && <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>Scanning repository manifests…</p>}
									{scan && (
										<div className="wiz-detect">
											<div className="hd">
												<span style={{ color: "var(--ok, #3fb950)" }}>●</span> Project configuration (auto-detected)
												{scan.recipe && <span className="sbx-badge" style={{ marginLeft: "auto" }}>{allTools.join(" + ") || "Detected"}</span>}
											</div>

											{/* Detected projects checklist — untick to drop from the recipe */}
											{projects.length > 0 && (
												<div style={{ marginBottom: 12 }}>
													{projects.map((p) => (
														<label key={p.dir} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", fontSize: 12.5, borderBottom: "1px solid var(--border)" }}>
															<input
																type="checkbox"
																checked={selDirs.has(p.dir)}
																onChange={(e) => {
																	const next = new Set(selDirs);
																	if (e.target.checked) next.add(p.dir); else next.delete(p.dir);
																	setSelDirs(next);
																}}
															/>
															<span className="mono" style={{ minWidth: 130 }}>{p.dir === "." ? "(root)" : p.dir}</span>
															<span className="sbx-tools">
																{p.stacks.map((s) => <span key={s} className="t">{STACK_LABELS[s] ?? s}</span>)}
																{p.needsCustom && <span className="t" title="ships Dockerfile/compose">docker</span>}
															</span>
															<span className="muted" style={{ marginLeft: "auto", fontSize: 10.5 }}>{p.found.slice(0, 4).join(" · ")}</span>
														</label>
													))}
												</div>
											)}

											<div className="wiz-kvgrid">
												<div className="cell"><small>Runtime</small><b>{allTools[0] ?? "—"}</b></div>
												<div className="cell"><small>Stack(s)</small><b>{allTools.slice(1).join(" · ") || "—"}</b></div>
												<div className="cell"><small>Config files ({scan.found?.length ?? 0})</small><b>{(scan.found ?? []).slice(0, 3).join("  ")}</b></div>
												{firstWithScripts && scriptNames.map((s) => (
													<div className="cell" key={s}><small>{s === "dev" ? "Dev" : s[0].toUpperCase() + s.slice(1)} command</small><b className="mono">{firstWithScripts.scripts?.[s] ? `npm run ${s}` : "—"}</b></div>
												))}
											</div>
											<VersionPicker stacks={[...new Set(selProjects.flatMap((p) => p.stacks))]} versions={versions} onChange={setVersions} />
											<button className="muted" style={{ background: "none", border: 0, cursor: "pointer", fontSize: 12, padding: 0 }} onClick={() => setShowDetails(!showDetails)}>
												{showDetails ? "▾" : "▸"} Detection details
											</button>
											{showDetails && (
												<div className="sbx-tools" style={{ marginTop: 6 }}>
													{(scan.found ?? []).map((f) => <span key={f} className="t mono">{f}</span>)}
												</div>
											)}
											{projects.some((p) => p.needsCustom) && <p className="muted" style={{ fontSize: 11.5, margin: "8px 0 0" }}>A Dockerfile/compose was detected — compare the recipe with its RUN steps.</p>}

											{selProjects.some((p) => (p.deps?.prod.length || p.deps?.dev.length)) ? (
												<div style={{ marginTop: 14 }}>
													<small className="muted"><b>Detected dependencies</b></small>
													{selProjects.filter((p) => p.deps?.prod.length || p.deps?.dev.length).length > 1 && (
														<div className="sbx-tabs" style={{ margin: "6px 0" }}>
															{selProjects.map((p, i) => (p.deps?.prod.length || p.deps?.dev.length) ? (
																<button key={p.dir} className={depsProj === i ? "active" : ""} onClick={() => setDepsProj(i)}>{p.dir === "." ? "root" : p.dir}</button>
															) : null)}
														</div>
													)}
													{(() => {
														const dp = selProjects[depsProj] ?? selProjects.find((p) => p.deps);
														return dp?.deps ? (
															<>
																<div className="sbx-tabs" style={{ margin: "6px 0" }}>
																	<button className={depsTab === "prod" ? "active" : ""} onClick={() => setDepsTab("prod")}>Production ({dp.deps.prod.length})</button>
																	<button className={depsTab === "dev" ? "active" : ""} onClick={() => setDepsTab("dev")}>Development ({dp.deps.dev.length})</button>
																</div>
																<div className="sbx-tools">
																	{(depsTab === "prod" ? dp.deps.prod : dp.deps.dev).map((d) => (
																		<span key={d.name} className="t mono">{d.name} <i>{d.version}</i></span>
																	))}
																</div>
															</>
														) : null;
													})()}
												</div>
											) : null}

											{scan.recipe && (
												<div style={{ marginTop: 14 }}>
													<div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
														<small className="muted"><b>Suggested build recipe</b>{source === "llm" ? " (model-generated)" : ""} — runs inside the VM</small>
														<button className="sbx-btn" style={{ marginLeft: "auto" }} onClick={() => { setEditRecipe(true); setStep(1); }}>Edit</button>
													</div>
													<pre className="act-out" style={{ maxHeight: 200, overflow: "auto" }}>{scan.recipe.commands}</pre>
												</div>
											)}
											{!scan.recipe && <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>No stack recognized — continue to write the recipe by hand.</p>}
										</div>
									)}
								</>
							)}
							{(type === "preset" || type === "custom") && (
								<div style={{ marginTop: 16 }}>
									<p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
										Select the stacks this template needs — we'll show the config files each expects and draft a merged recipe.
									</p>
									<div className="wiz-types">
										{STACK_KEYS.map((k) => (
											<button
												key={k}
												className={`wiz-type ${stackSel.has(k) ? "sel" : ""}`}
												onClick={() => {
													const next = new Set(stackSel);
													if (next.has(k)) next.delete(k); else next.add(k);
													setStackSel(next);
												}}
											>
												<span className="dot" />
												<b>{STACK_LABELS[k]}</b>
											</button>
										))}
									</div>
									<VersionPicker stacks={[...stackSel]} versions={versions} onChange={setVersions} />
									{expected && (
										<div className="wiz-detect">
											<div className="hd"><span style={{ color: "var(--ok, #3fb950)" }}>●</span> Expected project files</div>
											{Object.entries(expected).map(([k, files]) => (
												<div key={k} style={{ display: "flex", gap: 8, fontSize: 12, padding: "4px 0", alignItems: "baseline" }}>
													<b style={{ minWidth: 70 }}>{STACK_LABELS[k]}</b>
													<span className="sbx-tools">{files.map((f) => <span key={f} className="t mono">{f}</span>)}</span>
												</div>
											))}
											<p className="muted" style={{ fontSize: 11, marginTop: 8 }}>The recipe installs toolchains; dependency install steps are skipped when the files aren't present in the cloned repo.</p>
										</div>
									)}
								</div>
							)}
						</>
					)}

					{step === 1 && (
						<div style={{ maxWidth: 640 }}>
							<label className="muted" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Template name</label>
							<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-env" style={{ width: "100%", marginBottom: 4 }} />
							{name && !nameOk && <div style={{ color: "var(--err)", fontSize: 11, marginBottom: 6 }}>3–41 chars: lowercase letters, digits, hyphens.</div>}
							<label className="muted" style={{ fontSize: 12, display: "block", margin: "10px 0 4px" }}>Description</label>
							<input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this template is for" style={{ width: "100%", marginBottom: 10 }} />
							<label className="muted" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Recipe — shell script run in the sandbox VM{type === "repo" && repo ? ` (repo cloned to /home/user/repo)` : ""}</label>
							<div className="sbx-code">
								<div className="gutter">{commands.split("\n").map((_, i) => <div key={i}>{i + 1}</div>)}</div>
								<textarea value={commands} onChange={(e) => setCommands(e.target.value)} rows={10} spellCheck={false} readOnly={type === "repo" && !!scan?.recipe && !editRecipe} />
							</div>
							{type === "repo" && scan?.recipe && !editRecipe && (
								<button className="sbx-btn" style={{ marginTop: 6 }} onClick={() => setEditRecipe(true)}>Edit recipe</button>
							)}
							<label className="muted" style={{ fontSize: 12, display: "block", margin: "12px 0 4px" }}>Build timeout: {timeoutMin} min</label>
							<input type="range" min={5} max={45} value={timeoutMin} onChange={(e) => setTimeoutMin(Number(e.target.value))} />
						</div>
					)}

					{step === 2 && (
						<div style={{ maxWidth: 640 }}>
							<label className="muted" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Validation command — non-zero exit fails the bake (optional)</label>
							<input className="input mono" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder='python3 -c "import torch"' style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />
							<ul className="muted" style={{ fontSize: 12, marginTop: 14, paddingLeft: 18 }}>
								<li>{commands.trim() ? "✓" : "✗"} Recipe is non-empty</li>
								<li>{nameOk ? "✓" : "✗"} Name is a valid image name</li>
								<li>{type !== "repo" || repo ? "✓" : "✗"} Repository selected</li>
								<li>✓ Runs on stock e2b ubuntu base</li>
							</ul>
							{type === "repo" && repo && (
								<div style={{ marginTop: 14, fontSize: 12.5 }}>
									<p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Template scope</p>
									<label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
										<input type="radio" checked={includeRepo} onChange={() => setIncludeRepo(true)} /> Warm snapshot — repo cloned in, boots straight into the project
									</label>
									<label style={{ display: "flex", gap: 6, alignItems: "center" }}>
										<input type="radio" checked={!includeRepo} onChange={() => setIncludeRepo(false)} /> Reusable template — durable toolchain image
									</label>
									{!includeRepo && (
										<label style={{ display: "flex", gap: 6, alignItems: "center", margin: "8px 0 0 22px", fontSize: 12 }}>
											<input type="checkbox" checked={defaultForRepo} onChange={(e) => setDefaultForRepo(e.target.checked)} />
											Use as default template for <b>{repo}</b> — sessions on this repo boot from it
										</label>
									)}
									{includeRepo && <p className="muted" style={{ fontSize: 11, margin: "6px 0 0 22px" }}>Sessions on this repo boot the snapshot while it lives; the repo's base template is the fallback.</p>}
								</div>
							)}
						</div>
					)}

					{step === 3 && (
						<div style={{ maxWidth: 640 }}>
							<div className="wiz-kvgrid" style={{ marginBottom: 14 }}>
								<div className="cell"><small>Name</small><b className="mono">{includeRepo && repo ? `kronyx-repo-*` : name.trim().toLowerCase()}</b></div>
								<div className="cell"><small>Scope</small><b>{type === "repo" ? (includeRepo ? `Warm: ${repo}` : "Reusable template") : type === "preset" ? "Preset" : "Custom"}</b></div>
								<div className="cell"><small>Base</small><b>stock e2b</b></div>
								<div className="cell"><small>Timeout</small><b>{timeoutMin} min</b></div>
								{repo && <div className="cell"><small>Branch</small><b>{branch || "default"}</b></div>}
								<div className="cell"><small>Verify</small><b className="mono">{verify.trim() || "—"}</b></div>
							</div>
							<pre className="act-out" style={{ maxHeight: 200, overflow: "auto" }}>{commands}</pre>
							{description && <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{description}</p>}
						</div>
					)}

					<div style={{ display: "flex", gap: 8, marginTop: 24, justifyContent: "flex-end" }}>
						<button className="sbx-btn" onClick={() => router.push("/sandboxes?tab=templates")}>Cancel</button>
						{step > 0 && <button className="sbx-btn" onClick={() => setStep(step - 1)}>Back</button>}
						{step < 3 && (
							<button
								className="sbx-btn primary"
								disabled={(step === 0 && type === "repo" && !repo) || (step === 1 && (!nameOk || !commands.trim()))}
								onClick={() => setStep(step + 1)}
							>
								Continue →
							</button>
						)}
						{step === 3 && <button className="sbx-btn primary" onClick={() => void submit()}>Create Template</button>}
					</div>
					{msg && <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>{msg}</p>}
					</>
					)}
				</main>
			</div>
		</div>
	);
}
