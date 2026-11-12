"use client";

import { Bot, Box, Check, ChevronDown, Copy, GitBranch, KeyRound, MoreHorizontal, Pencil, Plus, ShieldCheck, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, useUser } from "@/lib/api";
import { CopyButton } from "@/components/CopyButton";
import { Modal } from "@/components/Modal";
import type { ModelGroup, ModelOption } from "@/lib/types";

const SHARED_SECRET_FIELDS = [{ key: "githubToken", label: "GitHub token", hint: "Fallback when no app installation" }];

const SANDBOX_PROVIDERS: { id: string; label: string; fields: { key: string; label: string; hint?: string; textarea?: boolean }[] }[] = [
	{
		id: "e2b",
		label: "E2B",
		fields: [{ key: "e2bApiKey", label: "E2B API key", hint: "Also read from E2B_API_KEY on the worker" }],
	},
	{
		id: "docker",
		label: "Docker",
		fields: [
			{ key: "dockerHost", label: "Docker host", hint: "Optional — e.g. ssh://user@host; blank = local socket" },
			{ key: "dockerImage", label: "Image", hint: "Default node:22" },
		],
	},
	{
		id: "kubernetes",
		label: "Kubernetes",
		fields: [
			{ key: "kubeconfig", label: "Kubeconfig", hint: "Raw YAML; blank = worker's env/in-cluster config", textarea: true },
			{ key: "k8sNamespace", label: "Namespace", hint: "Default 'default'" },
			{ key: "k8sImage", label: "Pod image", hint: "Default node:22" },
		],
	},
	{
		id: "vercel",
		label: "Vercel Sandbox",
		fields: [
			{ key: "vercelToken", label: "Vercel access token" },
			{ key: "vercelTeamId", label: "Team ID" },
			{ key: "vercelProjectId", label: "Project ID" },
			{ key: "vercelRuntime", label: "Runtime", hint: "Default node22" },
		],
	},
];

const SECTIONS = [
	{ id: "llm", label: "LLM Providers", icon: <Bot size={14} /> },
	{ id: "sandbox", label: "Sandbox Providers", icon: <Box size={14} /> },
	{ id: "defaults", label: "Model Defaults", icon: <SlidersHorizontal size={14} /> },
	{ id: "permissions", label: "Permissions", icon: <ShieldCheck size={14} /> },
	{ id: "github", label: "GitHub Access", icon: <GitBranch size={14} /> },
	{ id: "secrets", label: "Shared Secrets", icon: <KeyRound size={14} /> },
] as const;

type Section = (typeof SECTIONS)[number]["id"];
type CardTab = "models" | "config" | "usage";

interface Profile {
	name: string;
	providerId: string;
	baseUrl: string;
	modelId: string;
	enabled: boolean;
}

interface UsageEvent {
	profile?: string;
	model?: string;
	status?: string;
	tokensIn?: number;
	tokensOut?: number;
}

interface SettingsDoc {
	data?: {
		activeProfile?: string;
		sandboxProvider?: string;
		e2bTemplate?: string;
		sandboxAutoSwitch?: boolean;
		postRunChecks?: boolean;
		modelDefaults?: Record<string, string>;
		permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; modes?: Record<string, { allow?: string[]; ask?: string[]; deny?: string[] }> };
		profiles?: { name?: string; providerId?: string; baseUrl?: string; modelId?: string; enabled?: boolean }[];
	};
	secrets?: Record<string, string>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="settings-field">
			<div className="settings-label">
				<span>{label}</span>
				{hint && <span className="muted">{hint}</span>}
			</div>
			{children}
		</div>
	);
}

const emptyProfile = (): Profile => ({ name: "", providerId: "", baseUrl: "", modelId: "", enabled: true });

const host = (baseUrl: string) => {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
};

const fmtCtx = (n?: number) => (n ? (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M ctx` : `${Math.round(n / 1000)}k ctx`) : "");
const fmtPrice = (p?: { input?: number; output?: number }) => {
	if (!p?.input && !p?.output) return "";
	const per = (v?: number) => (v === undefined ? "?" : v * 1_000_000 < 1 ? `$${(v * 1_000_000).toFixed(2)}` : `$${(v * 1_000_000).toFixed(1)}`);
	return `${per(p.input)}/${per(p.output)}/M`;
};

const capChips = (m: ModelOption): string[] =>
	[fmtCtx(m.contextWindow), ...(m.modalities?.input ?? []).filter((i) => i !== "text"), m.tags?.[0], fmtPrice(m.pricing)].filter(
		(c): c is string => !!c,
	);

/** /settings — providers, models, sandboxes and secrets with explicit defaults. */
export default function SettingsPage() {
	const user = useUser();
	const [section, setSection] = useState<Section>("llm");
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const [activeProfile, setActiveProfile] = useState("");
	const [sandboxProvider, setSandboxProvider] = useState("e2b");
	const [e2bTemplate, setE2bTemplate] = useState("");
	const [sandboxAutoSwitch, setSandboxAutoSwitch] = useState(true);
	const [postRunChecks, setPostRunChecks] = useState(true);
	const [modelDefaults, setModelDefaults] = useState<Record<string, string>>({});
	type PermScope = "global" | "ask" | "plan" | "agent";
	const emptyPermText = () => ({ allow: "", ask: "", deny: "" });
	const [permText, setPermText] = useState<Record<PermScope, { allow: string; ask: string; deny: string }>>({
		global: emptyPermText(),
		ask: emptyPermText(),
		plan: emptyPermText(),
		agent: emptyPermText(),
	});
	const [permScope, setPermScope] = useState<PermScope>("global");
	const SUGGESTED_PERMS: Record<PermScope, { allow: string[]; ask: string[]; deny: string[] }> = {
		global: {
			allow: ["read_file(**)", "list_files(**)", "search_files(**)", "run_command(git status)", "run_command(git diff *)", "run_command(git log *)", "run_command(git show *)", "run_command(git branch *)", "run_command(ls *)", "run_command(pwd)", "run_command(which *)"],
			ask: ["run_command(git push *)", "run_command(git commit *)", "run_command(sudo *)", "browser_use", "switch_environment"],
			deny: ["run_command(rm -rf *)", "run_command(git push --force*)", "run_command(git reset --hard*)", "write_file(.env)", "write_file(**/.env)", "read_file(**/secrets*)", "read_file(**/*.pem)", "read_file(**/id_rsa*)"],
		},
		ask: {
			allow: ["read_file(**)", "list_files(**)", "search_files(**)"],
			ask: [],
			deny: [],
		},
		plan: {
			allow: ["save_plan", "read_file(**)", "list_files(**)", "search_files(**)", "run_command(git diff *)", "run_command(git log *)"],
			ask: [],
			deny: [],
		},
		agent: {
			allow: ["run_command(git checkout *)", "run_command(git switch *)", "run_command(git stash *)", "run_command(git merge *)"],
			ask: ["run_command(git rebase *)", "run_command(git clean *)"],
			deny: [],
		},
	};
	const loadSuggestedPerms = () =>
		setPermText((pt) => {
			const merge = (cur: string, extra: string[]) =>
				[...new Set([...cur.split("\n").map((s) => s.trim()).filter(Boolean), ...extra])].join("\n");
			return Object.fromEntries(
				(["global", "ask", "plan", "agent"] as PermScope[]).map((scope) => [
					scope,
					{
						allow: merge(pt[scope].allow, SUGGESTED_PERMS[scope].allow),
						ask: merge(pt[scope].ask, SUGGESTED_PERMS[scope].ask),
						deny: merge(pt[scope].deny, SUGGESTED_PERMS[scope].deny),
					},
				]),
			) as typeof pt;
		});
	const [dataExtras, setDataExtras] = useState<Record<string, unknown>>({});
	const [groups, setGroups] = useState<ModelGroup[]>([]);
	const [usage, setUsage] = useState<UsageEvent[]>([]);
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [syncedKeys, setSyncedKeys] = useState<Set<string>>(new Set());
	const [deleted, setDeleted] = useState<Set<string>>(new Set());
	const [expanded, setExpanded] = useState<string | null>(null);
	const [cardTab, setCardTab] = useState<CardTab>("models");
	const [expandedSbx, setExpandedSbx] = useState<string | null>(null);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [modelQuery, setModelQuery] = useState("");
	const [modFilter, setModFilter] = useState("all");
	const [descOpen, setDescOpen] = useState<Set<string>>(new Set());
	const [sortCost, setSortCost] = useState<"asc" | "desc" | null>(null);
	const [editing, setEditing] = useState<{ index: number | null; draft: Profile } | null>(null);
	const [newSecretOpen, setNewSecretOpen] = useState(false);
	const [newSecretKey, setNewSecretKey] = useState("");
	const [msg, setMsg] = useState("");

	useEffect(() => {
		if (!user) return;
		void (async () => {
			const res = await apiFetch("/api/settings", user);
			if (res.ok) {
				const { settings } = (await res.json()) as { settings?: SettingsDoc };
				const synced = settings?.secrets ?? {};
				setSyncedKeys(new Set(Object.keys(synced)));
				setProfiles(
					(settings?.data?.profiles ?? []).map((p) => ({
						name: p.name ?? "",
						providerId: p.providerId ?? "",
						baseUrl: p.baseUrl ?? "",
						modelId: p.modelId ?? "",
						enabled: p.enabled !== false,
					})),
				);
				setActiveProfile(settings?.data?.activeProfile ?? "");
				setSandboxProvider(settings?.data?.sandboxProvider ?? "e2b");
				setE2bTemplate(settings?.data?.e2bTemplate ?? "");
				setSandboxAutoSwitch(settings?.data?.sandboxAutoSwitch !== false);
				setPostRunChecks(settings?.data?.postRunChecks !== false);
				setModelDefaults(settings?.data?.modelDefaults ?? {});
				const toText = (r?: { allow?: string[]; ask?: string[]; deny?: string[] }) => ({
					allow: (r?.allow ?? []).join("\n"),
					ask: (r?.ask ?? []).join("\n"),
					deny: (r?.deny ?? []).join("\n"),
				});
				const perms = settings?.data?.permissions;
				setPermText({
					global: toText(perms),
					ask: toText(perms?.modes?.ask),
					plan: toText(perms?.modes?.plan),
					agent: toText(perms?.modes?.agent),
				});
				// PUT replaces settings.data wholesale — retain keys this page doesn't own
				// (providerId/baseUrl/modelId synced by the extension) so saving here
				// doesn't wipe them.
				const { activeProfile: _a, sandboxProvider: _s, e2bTemplate: _t, sandboxAutoSwitch: _sw, postRunChecks: _pc, modelDefaults: _m, permissions: _p, profiles: _pr, ...rest } =
					(settings?.data ?? {}) as Record<string, unknown>;
				setDataExtras(rest);
			}
			const [mr, ur] = await Promise.all([apiFetch("/api/models", user), apiFetch("/api/usage?limit=500", user)]);
			if (mr.ok) setGroups(((await mr.json()) as { groups: ModelGroup[] }).groups ?? []);
			if (ur.ok) setUsage(((await ur.json()) as { calls: UsageEvent[] }).calls ?? []);
		})();
		const installId = new URLSearchParams(window.location.search).get("installation");
		if (installId) {
			void (async () => {
				await apiFetch("/api/github/link", user, { method: "POST", body: JSON.stringify({ installationId: Number(installId) }) });
				window.history.replaceState({}, "", "/settings");
				setGithubLinked(true);
			})();
		}
		void apiFetch("/api/github/repos", user).then(async (r) => {
			if (!r.ok) return;
			const body = (await r.json()) as {
				repos?: { repo: string; defaultBranch: string; installationId: number }[];
				installations?: { id: number; account: string; type: string }[];
			};
			const list = body.repos ?? [];
			setGithubLinked(list.length > 0);
			setGhRepos(list);
			setGhInstallations(body.installations ?? []);
		});
	}, [user]);

	const [githubLinked, setGithubLinked] = useState(false);
	const [ghRepos, setGhRepos] = useState<{ repo: string; defaultBranch: string; installationId: number }[]>([]);
	const [ghInstallations, setGhInstallations] = useState<{ id: number; account: string; type: string }[]>([]);
	const appSlug = (process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || "kronyx")
		.replace(/^https?:\/\/github\.com\/apps\//, "")
		.replace(/\/.*/, "");
	const installUrl = `https://github.com/apps/${appSlug}/installations/new`;

	const setProfile = (i: number, patch: Partial<Profile>) => setProfiles((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

	const clearSecret = (key: string) => {
		setDeleted((d) => new Set(d).add(key));
		setSyncedKeys((s) => {
			const n = new Set(s);
			n.delete(key);
			return n;
		});
	};

	const secretInput = (key: string, textarea = false) => {
		const synced = syncedKeys.has(key);
		const gone = deleted.has(key);
		const input = textarea ? (
			<textarea
				className="input mono"
				rows={5}
				placeholder={synced ? "(synced — blank to keep)" : "paste here"}
				value={secrets[key] ?? ""}
				onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
			/>
		) : (
			<input
				className="input mono"
				type="password"
				placeholder={synced ? "(synced — blank to keep)" : gone ? "(cleared)" : "set to sync"}
				value={secrets[key] ?? ""}
				onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
			/>
		);
		return (
			<div style={{ display: "flex", gap: 6, alignItems: "center" }}>
				<div style={{ flex: 1 }}>{input}</div>
				{synced && (
					<button className="btn ghost sm" title="Clear synced secret" onClick={() => clearSecret(key)}>
						<X size={12} />
					</button>
				)}
			</div>
		);
	};

	const usageFor = (name: string) => {
		const rows = usage.filter((c) => c.profile === name);
		return {
			calls: rows.length,
			tokensIn: rows.reduce((a, c) => a + (c.tokensIn ?? 0), 0),
			tokensOut: rows.reduce((a, c) => a + (c.tokensOut ?? 0), 0),
		};
	};

	const allModels = useMemo(() => groups.flatMap((g) => g.models), [groups]);
	const defaultProfile = profiles.find((p) => p.name === activeProfile) ?? profiles[0];

	const save = async () => {
		if (!user) return;
		setMsg("Saving…");
		const secretPatch: Record<string, string | null> = {};
		for (const [k, v] of Object.entries(secrets)) if (v) secretPatch[k] = v;
		for (const k of deleted) secretPatch[k] = null;
		const res = await apiFetch("/api/settings", user, {
			method: "PUT",
			body: JSON.stringify({
				version: 1,
				data: {
					...dataExtras,
					activeProfile,
					sandboxProvider,
					e2bTemplate: e2bTemplate || undefined,
					sandboxAutoSwitch,
					postRunChecks,
					modelDefaults,
					permissions: (() => {
						const toList = (t: { allow: string; ask: string; deny: string }) => ({
							allow: t.allow.split("\n").map((s) => s.trim()).filter(Boolean),
							ask: t.ask.split("\n").map((s) => s.trim()).filter(Boolean),
							deny: t.deny.split("\n").map((s) => s.trim()).filter(Boolean),
						});
						const modes = Object.fromEntries(
							(["ask", "plan", "agent"] as const)
								.map((m) => [m, toList(permText[m])])
								.filter(([, r]) => (r as { allow: string[] }).allow.length + (r as { ask: string[] }).ask.length + (r as { deny: string[] }).deny.length > 0),
						);
						return { ...toList(permText.global), modes };
					})(),
					profiles: profiles.map(({ name, providerId, baseUrl, modelId, enabled }) => ({ name, providerId, baseUrl, modelId, enabled })),
				},
				secrets: secretPatch,
			}),
		});
		setMsg(res.ok ? "Saved — synced at next point-of-need." : "Save failed.");
	};




	const llmSection = (
		<>
			<div className="settings-head">
				<div>
					<div className="chart-title">LLM Providers</div>
					<p className="muted" style={{ fontSize: 12 }}>Configure LLM providers and the models you can use.</p>
				</div>
				<button className="btn primary sm" onClick={() => setEditing({ index: null, draft: emptyProfile() })}>
					<Plus size={13} /> Add Provider
				</button>
			</div>

			<div className="summary-bar">
				<div className="summary-cell">
					<span className="muted">Default Provider</span>
					<strong>{defaultProfile?.name || "—"}</strong>
				</div>
				<div className="summary-cell">
					<span className="muted">Default Model</span>
					<strong className="mono">{defaultProfile?.modelId || "—"}</strong>
				</div>
				<button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setSection("defaults")}>
					Change Defaults
				</button>
			</div>

			{profiles.length === 0 && <p className="muted" style={{ fontSize: 12 }}>No providers — add one to define a BYOK provider + model + key.</p>}
			{profiles.map((p, i) => {
				const g = groups.find((gr) => gr.profile === p.name);
				const open = expanded === p.name;
				const isDefault = activeProfile === p.name && !!p.name;
				const u = usageFor(p.name);
				return (
					<div key={i} className={`provider-acc${open ? " open" : ""}${p.enabled ? "" : " disabled"}`}>
						<div className="acc-head" onClick={() => { setExpanded(open ? null : p.name); setCardTab("models"); }}>
							<ChevronDown size={14} className="acc-chevron" />
							<div className="acc-id">
								<span style={{ fontWeight: 600 }}>{p.name || "New provider"}</span>
								{isDefault && <span className="default-badge">Default</span>}
								{!p.enabled && <span className="cap-chip">Disabled</span>}
								{p.baseUrl && <span className="muted" style={{ fontSize: 11 }}>{host(p.baseUrl)}</span>}
							</div>
							<div className="anchor">
								<button className="icon-btn" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === `p${i}` ? null : `p${i}`); }}>
									<MoreHorizontal size={15} />
								</button>
								{menuFor === `p${i}` && (
									<div className="pop" style={{ left: "auto", right: 0, top: 26 }}>
										<button className="pop-item" disabled={!p.name} onClick={(e) => { e.stopPropagation(); setActiveProfile(p.name); setMenuFor(null); }}>
											<Check size={13} /> Set as default
										</button>
										<button className="pop-item" onClick={(e) => { e.stopPropagation(); setEditing({ index: i, draft: { ...p } }); setMenuFor(null); }}>
											<Pencil size={13} /> Edit
										</button>
										<button className="pop-item" onClick={(e) => { e.stopPropagation(); setProfile(i, { enabled: !p.enabled }); setMenuFor(null); }}>
											{p.enabled ? "Disable" : "Enable"}
										</button>
										<div className="pop-sep" />
										<button className="pop-item" onClick={(e) => { e.stopPropagation(); setProfiles(profiles.filter((_, j) => j !== i)); setMenuFor(null); }}>
											<Trash2 size={13} /> Remove provider
										</button>
									</div>
								)}
							</div>
						</div>
						{open && (
							<div className="acc-body">
								<div className="acc-tabs">
									{(["models", "config", "usage"] as CardTab[]).map((t) => (
										<button key={t} className={`acc-tab${cardTab === t ? " active" : ""}`} onClick={() => setCardTab(t)}>
											{t === "config" ? "Configuration" : t[0].toUpperCase() + t.slice(1)}
										</button>
									))}
								</div>
								{cardTab === "models" && (() => {
									const models = g?.models ?? [];
									const mods = Array.from(new Set(models.flatMap((m) => m.modalities?.input ?? []).filter((x) => x !== "text")));
									const q = modelQuery.trim().toLowerCase();
									const filtered = models.filter(
										(m) =>
											(!q ||
												m.id.toLowerCase().includes(q) ||
												(m.label ?? "").toLowerCase().includes(q) ||
												(m.description ?? "").toLowerCase().includes(q)) &&
											(modFilter === "all" || (m.modalities?.input ?? []).includes(modFilter)),
									);
									return (
										<div>
											<div className="model-filters">
												<input
													className="input mono"
													style={{ flex: 1 }}
													placeholder={`Search ${models.length} models…`}
													value={modelQuery}
													onChange={(e) => setModelQuery(e.target.value)}
												/>
												{["all", ...mods].map((f) => (
													<button key={f} className={`cap-chip filter${modFilter === f ? " active" : ""}`} onClick={() => setModFilter(f)}>
														{f === "all" ? "All" : f}
													</button>
												))}
											</div>
											<p className="muted" style={{ fontSize: 11, margin: "0 0 6px" }}>Click a row (or its radio) to make it this provider's default model.</p>
											{sortCost &&
												(filtered.sort(
													(a, b) =>
														((a.pricing?.input ?? Number.POSITIVE_INFINITY) - (b.pricing?.input ?? Number.POSITIVE_INFINITY)) *
														(sortCost === "asc" ? 1 : -1),
												),
												null)}
											<div className="model-table">
												<div className="model-row head">
													<span style={{ width: 22 }} />
													<span style={{ flex: 3 }}>Model</span>
													<span style={{ flex: 2 }}>Capabilities</span>
													<span
														style={{ width: 90, cursor: "pointer", userSelect: "none" }}
														title="Sort by input cost"
														onClick={() => setSortCost(sortCost === "asc" ? "desc" : sortCost === "desc" ? null : "asc")}
													>
														Cost/M {sortCost === "asc" ? "↑" : sortCost === "desc" ? "↓" : "↕"}
													</span>
													<span style={{ width: 60 }}>Default</span>
													<span style={{ width: 30 }} title="Copy model id">Copy</span>
												</div>
												{filtered.map((m) => (
													<div key={m.id} className="model-row" onClick={() => setProfile(i, { modelId: m.id })}>
														<span style={{ width: 22 }}>
															<input type="radio" name={`model-${i}`} checked={p.modelId === m.id} onChange={() => setProfile(i, { modelId: m.id })} onClick={(e) => e.stopPropagation()} />
														</span>
														<span style={{ flex: 3, minWidth: 0 }}>
															<span className="mono" style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.label ?? m.id}</span>
															{m.description && (
																<span
																	className={`muted model-desc${descOpen.has(m.id) ? " open" : ""}`}
																	title={descOpen.has(m.id) ? "Click to collapse" : "Click to expand"}
																	onClick={(e) => {
																		e.stopPropagation();
																		setDescOpen((s) => {
																			const n = new Set(s);
																			if (n.has(m.id)) n.delete(m.id);
																			else n.add(m.id);
																			return n;
																		});
																	}}
																>
																	{m.description}
																</span>
															)}
														</span>
														<span style={{ flex: 2, display: "flex", gap: 4, flexWrap: "wrap" }}>
															{capChips(m).map((c) => <span key={c} className="cap-chip">{c}</span>)}
														</span>
														<span className="mono muted" style={{ width: 90, fontSize: 11 }}>{fmtPrice(m.pricing) || "—"}</span>
														<span style={{ width: 60 }}>{p.modelId === m.id && <span className="default-badge">Default</span>}</span>
														<span style={{ width: 30 }}>
															<button
																className="icon-btn"
																title="Copy model id"
																onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(m.id); }}
															>
																<Copy size={13} />
															</button>
														</span>
													</div>
												))}
												{filtered.length === 0 && (
													<div className="model-row muted">{models.length === 0 ? "No models — set a base URL + API key in Configuration." : "No models match the filter."}</div>
												)}
											</div>
										</div>
									);
								})()}
								{cardTab === "config" && (
									<div>
										<div className="profile-grid">
											<Field label="Provider ID"><input className="input" value={p.providerId} onChange={(e) => setProfile(i, { providerId: e.target.value })} placeholder="vercel" /></Field>
											<Field label="Name"><input className="input" value={p.name} onChange={(e) => setProfile(i, { name: e.target.value })} placeholder="openai" /></Field>
										</div>
										<Field label="Base URL"><input className="input mono" value={p.baseUrl} onChange={(e) => setProfile(i, { baseUrl: e.target.value })} placeholder="https://ai-gateway.vercel.sh/v1" /></Field>
										<Field label="API key" hint={syncedKeys.has(`profile.apiKey.${p.name}`) ? "synced — blank to keep" : "per-profile key"}>
											{secretInput(`profile.apiKey.${p.name}`)}
										</Field>
									</div>
								)}
								{cardTab === "usage" && (
									<div className="usage-stats">
										<div className="summary-cell"><span className="muted">Calls</span><strong>{u.calls}</strong></div>
										<div className="summary-cell"><span className="muted">Tokens in</span><strong>{u.tokensIn.toLocaleString()}</strong></div>
										<div className="summary-cell"><span className="muted">Tokens out</span><strong>{u.tokensOut.toLocaleString()}</strong></div>
									</div>
								)}
							</div>
						)}
					</div>
				);
			})}
		</>
	);

	const sandboxSection = (
		<>
			<div className="settings-head">
				<div>
					<div className="chart-title">Sandbox Providers</div>
					<p className="muted" style={{ fontSize: 12 }}>Where cloud runs execute. Vercel is ephemeral — each run starts fresh.</p>
				</div>
			</div>
			{SANDBOX_PROVIDERS.map((p) => {
				const open = expandedSbx === p.id;
				const isDefault = sandboxProvider === p.id;
				return (
					<div key={p.id} className={`provider-acc${open ? " open" : ""}`}>
						<div className="acc-head" onClick={() => setExpandedSbx(open ? null : p.id)}>
							<ChevronDown size={14} className="acc-chevron" />
							<div className="acc-id">
								<span style={{ fontWeight: 600 }}>{p.label}</span>
								{isDefault && <span className="default-badge">Default</span>}
							</div>
							<label className="radio-row" onClick={(e) => e.stopPropagation()}>
								<input type="radio" name="defaultSandbox" checked={isDefault} onChange={() => setSandboxProvider(p.id)} />
								Set default
							</label>
						</div>
						{open && (
							<div className="acc-body">
								{p.fields.map((f) => (
									<Field key={f.key} label={f.label} hint={f.hint}>
										{secretInput(f.key, f.textarea)}
									</Field>
								))}
								{p.id === "e2b" && (
									<>
										<Field label="Default template" hint="e2b template build — blank lets the model pick">
											<input
												className="input mono"
												value={e2bTemplate}
												onChange={(e) => setE2bTemplate(e.target.value)}
												placeholder="kronyx-browser"
											/>
										</Field>
										<Field label="Auto template switch" hint="agent may swap VM images mid-run">
											<label className="radio-row">
												<input
													type="checkbox"
													checked={sandboxAutoSwitch}
													onChange={(e) => setSandboxAutoSwitch(e.target.checked)}
												/>
												Allow switch_environment
											</label>
										</Field>
									</>
								)}
							</div>
						)}
					</div>
				);
			})}
			<Field label="Post-run checks" hint="after the agent finishes: push, open the PR, then run tests + boot smoke">
				<label className="radio-row">
					<input type="checkbox" checked={postRunChecks} onChange={(e) => setPostRunChecks(e.target.checked)} />
					Run verification (npm test / app boot) after cloud runs
				</label>
			</Field>
		</>
	);

	const defaultsSection = (
		<>
			<div className="settings-head">
				<div>
					<div className="chart-title">Model Defaults</div>
					<p className="muted" style={{ fontSize: 12 }}>Default model per session mode — overridden by the composer picker.</p>
				</div>
			</div>
			{(["agent", "multi", "plan", "ask"] as const).map((mode) => (
				<Field key={mode} label={`${mode[0].toUpperCase() + mode.slice(1)} mode`}>
					<select className="input" value={modelDefaults[mode] ?? ""} onChange={(e) => setModelDefaults({ ...modelDefaults, [mode]: e.target.value })}>
						<option value="">(provider default)</option>
						{allModels.map((m) => (
							<option key={m.id} value={m.id}>{m.label ?? m.id}</option>
						))}
					</select>
				</Field>
			))}
		</>
	);

	const permissionsSection = (
		<>
			<div className="settings-head">
				<div>
					<div className="chart-title">Global Permission Rules</div>
					<p className="muted" style={{ fontSize: 12 }}>
						Apply to every repo, in local and cloud runs — synced via <code>~/.kronyx/permissions.json</code>.
						Repo (<code>.kronyx/permissions.json</code>) and local (<code>.kronyx/permissions.local.json</code>) rules
						can override allow/ask; <strong>global deny is never overridden</strong>.
					</p>
				</div>
			</div>
			<p className="muted" style={{ fontSize: 11 }}>
				One rule per line — <code className="mono">tool</code> or <code className="mono">tool(glob)</code>, e.g.{" "}
				<code className="mono">run_command(npm run test:*)</code>, <code className="mono">write_file(src/**)</code>.
			</p>
			<div style={{ display: "flex", gap: 6, margin: "10px 0 14px", flexWrap: "wrap" }}>
				{(
					[
						["global", "All modes"],
						["ask", "Ask"],
						["plan", "Plan"],
						["agent", "Agent"],
					] as [PermScope, string][]
				).map(([id, label]) => (
					<button
						key={id}
						className={`chip-btn${permScope === id ? " active" : ""}`}
						style={permScope === id ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
						onClick={() => setPermScope(id)}
					>
						{label}
					</button>
				))}
				<span style={{ flex: 1 }} />
				<button className="btn ghost sm" onClick={loadSuggestedPerms} title="Fill all mode lists with a sensible starter set">
					Load suggested defaults
				</button>
			</div>
			<p className="muted" style={{ fontSize: 11, marginTop: -6 }}>
				{permScope === "global"
					? "Baseline rules for every mode. Deny here can never be overridden."
					: permScope === "agent"
						? "Extra rules for write-capable modes (Agent/code/smart). Checked after repo rules, before the All-modes lists."
						: `Extra rules only when the session runs in ${permScope === "ask" ? "Ask" : "Plan"} mode. Checked after repo rules, before the All-modes lists.`}
			</p>
			{permScope !== "global" && (
				<div className="card" style={{ padding: "10px 14px", marginBottom: 14, background: "var(--bg)" }}>
					<div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
						Built-in for {permScope === "ask" ? "Ask" : permScope === "plan" ? "Plan" : "Agent"} — always enforced
					</div>
					{(permScope === "agent"
						? [
								"Multi-agent runs share the Agent rules (each slice evaluates as agent)",
								"Write tools allowed — confirmation depends on the run's security profile",
								"browser_use + switch_environment available",
								"Identical repeated actions auto-skipped (dedup guard)",
							]
						: [
								"Write tools not exposed to the model: write_file, edit_file, append_file, insert_lines, file_editor",
								"run_command, browser_use, switch_environment not exposed",
								permScope === "plan" ? "save_plan is the single write permitted (plan mode only)" : "No write tools at all — chat only",
								"Sequential tool calls; stray writes hard-blocked",
							]
					).map((r) => (
						<div key={r} className="mono" style={{ fontSize: 11, color: "var(--muted)", padding: "2px 0" }}>
							• {r}
						</div>
					))}
				</div>
			)}
			{(["allow", "ask", "deny"] as const).map((kind) => (
				<Field
					key={kind}
					label={kind === "allow" ? "Allow" : kind === "ask" ? "Ask" : "Deny"}
					hint={kind === "allow" ? "auto-approve matching tools" : kind === "ask" ? "always prompt, even in auto modes" : "never run — cannot be overridden by lower layers"}
				>
					<textarea
						className="input mono"
						rows={kind === "ask" ? 3 : 4}
						value={permText[permScope][kind]}
						onChange={(e) => setPermText((pt) => ({ ...pt, [permScope]: { ...pt[permScope], [kind]: e.target.value } }))}
						placeholder={
							kind === "allow"
								? "run_command(npm run build)\nread_file(**)"
								: kind === "ask"
									? "browser_use\nrun_command(git push *)"
									: "run_command(rm -rf *)\nwrite_file(.env)"
						}
					/>
				</Field>
			))}
		</>
	);

	const githubSection = (
		<div className="card" style={{ padding: 20 }}>
			<div className="chart-title" style={{ marginBottom: 4 }}>GitHub access</div>
			<p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
				{githubLinked
					? "App installed — cloud runs can clone/push/PR on your repos."
					: "Install the Kronyx GitHub App on your repos so cloud runs can work on them (scoped, revocable)."}
			</p>
			{githubLinked ? (
				<>
					<div style={{ color: "var(--ok)", fontSize: 13, marginBottom: 10 }}>
						✓ Enabled — {ghRepos.length} repo{ghRepos.length === 1 ? "" : "s"} across {ghInstallations.length || 1} installation{(ghInstallations.length || 1) === 1 ? "" : "s"}
					</div>
					{ghInstallations.length === 0 && (
						<div className="pop-scroll" style={{ maxHeight: 160, marginBottom: 12 }}>
							{ghRepos.map((r) => (
								<div key={r.repo} className="pop-item" style={{ cursor: "default", padding: "4px 12px" }}>
									<GitBranch size={12} />
									<span className="mono" style={{ flex: 1, fontSize: 12 }}>{r.repo}</span>
									<span className="right">{r.defaultBranch}</span>
								</div>
							))}
						</div>
					)}
					{ghInstallations.map((inst) => {
						const mine = ghRepos.filter((r) => r.installationId === inst.id);
						return (
							<div key={inst.id} style={{ marginBottom: 12 }}>
								<div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 4 }}>
									<span style={{ fontWeight: 600 }}>{inst.account || `Installation ${inst.id}`}</span>
									<span className="muted">{inst.type}</span>
									<a
										href={`https://github.com/apps/${appSlug}/installations/${inst.id}`}
										target="_blank"
										rel="noreferrer"
										className="muted"
										style={{ fontSize: 11 }}
									>
										manage ↗
									</a>
								</div>
								<div className="pop-scroll" style={{ maxHeight: 160 }}>
									{mine.map((r) => (
										<div key={r.repo} className="pop-item" style={{ cursor: "default", padding: "4px 12px" }}>
											<GitBranch size={12} />
											<span className="mono" style={{ flex: 1, fontSize: 12 }}>{r.repo}</span>
											<span className="right">{r.defaultBranch}</span>
										</div>
									))}
								</div>
							</div>
						);
					})}
					<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
						<a className="btn ghost sm" href={installUrl} target="_blank" rel="noreferrer">
							+ Add another account / repos
						</a>
						<CopyButton text={installUrl} label="Copy install link" />
					</div>
					<p className="muted" style={{ fontSize: 11, marginTop: 10, maxWidth: 420 }}>
						To install on a different GitHub account or org: open an incognito window, sign in to GitHub as that user, and
						paste the copied install link — then pick the account and repos to grant.
					</p>
				</>
			) : (
				<>
					<a className="btn ghost" href={installUrl} target="_blank" rel="noreferrer">
						Enable GitHub access
					</a>
					<p className="muted" style={{ fontSize: 11, marginTop: 10, maxWidth: 420 }}>
						Installing for a different GitHub account? Open an incognito window, sign in to GitHub as that user, and open:
					</p>
					<div className="key-reveal mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{installUrl}</div>
					<CopyButton text={installUrl} label="Copy install link" />
				</>
			)}
		</div>
	);

	const secretLabel = (key: string): { label: string; hint: string } => {
		if (key === "githubToken") return { label: "GitHub token", hint: "fallback when no app installation" };
		if (key === "e2bApiKey") return { label: "E2B API key", hint: "cloud sandboxes — overrides worker env" };
		if (key === "providerApiKey") return { label: "LLM API key", hint: "fallback when no profile key" };
		if (key.startsWith("profile.apiKey.")) return { label: `Profile key — ${key.slice("profile.apiKey.".length)}`, hint: "LLM key for that provider profile" };
		const prof = profiles.find((p) => p.name === key);
		if (prof) return { label: `Profile key — ${key}`, hint: "LLM key for that provider profile" };
		return { label: key, hint: "custom" };
	};

	const secretsSection = (() => {
		const known = SHARED_SECRET_FIELDS.map((f) => f.key);
		const keys = [
			...new Set([
				...known,
				...Object.keys(secrets).filter((k) => !deleted.has(k)),
				...[...syncedKeys],
			]),
		];
		return (
			<div className="card" style={{ padding: 20 }}>
				<div className="chart-title" style={{ marginBottom: 4 }}>Shared secrets</div>
				<p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
					Credentials shared between your editors and cloud runs — LLM keys, sandbox keys, git tokens. Stored
					server-side per account (opt-in): the extension pulls them into its secret store and pushes local ones up,
					and the worker injects them into sandbox runs. Blank keeps the synced value; ✕ clears it.
				</p>
				{keys.map((k) => {
					const l = secretLabel(k);
					return (
						<Field key={k} label={l.label} hint={l.hint}>
							{secretInput(k)}
						</Field>
					);
				})}
				{keys.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No secrets yet.</div>}
				{newSecretOpen ? (
					<div style={{ display: "flex", gap: 8, marginTop: 10 }}>
						<input
							className="input mono"
							style={{ width: 220 }}
							placeholder="secret name (e.g. npmToken)"
							value={newSecretKey}
							onChange={(e) => setNewSecretKey(e.target.value)}
							autoFocus
						/>
						<button
							className="btn sm"
							disabled={!/^[\w.-]+$/.test(newSecretKey.trim())}
							onClick={() => {
								setSecrets((s) => ({ ...s, [newSecretKey.trim()]: "" }));
								setNewSecretKey("");
								setNewSecretOpen(false);
							}}
						>
							Add
						</button>
						<button className="btn ghost sm" onClick={() => setNewSecretOpen(false)}>Cancel</button>
					</div>
				) : (
					<button className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => setNewSecretOpen(true)}>
						+ Add a secret
					</button>
				)}
			</div>
		);
	})();

	if (!user) return null;
	return (
		<div className="page">
			<h1>Settings</h1>
			<p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
				Configure LLM providers, models, and sandbox providers used by Kronyx.
			</p>

			<div className="settings-layout">
				<nav className="settings-rail">
					{SECTIONS.map((s) => (
						<button key={s.id} className={`rail-item${section === s.id ? " active" : ""}`} onClick={() => setSection(s.id)}>
							{s.icon} <span>{s.label}</span>
							{s.id === "llm" && <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{profiles.length}</span>}
							{s.id === "sandbox" && <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>{SANDBOX_PROVIDERS.length}</span>}
						</button>
					))}
				</nav>
				<div className="settings-main">
					{section === "llm" && llmSection}
					{section === "sandbox" && sandboxSection}
					{section === "defaults" && defaultsSection}
					{section === "permissions" && permissionsSection}
					{section === "github" && githubSection}
					{section === "secrets" && secretsSection}
				</div>
			</div>

			{editing && (
				<Modal title={editing.index === null ? "Add provider" : `Edit ${profiles[editing.index]?.name ?? "provider"}`} onClose={() => setEditing(null)}>
					<Field label="Name"><input className="input" autoFocus value={editing.draft.name} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })} placeholder="openai" /></Field>
					<div className="profile-grid">
						<Field label="Provider ID"><input className="input" value={editing.draft.providerId} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, providerId: e.target.value } })} placeholder="vercel" /></Field>
						<Field label="Default model"><input className="input mono" value={editing.draft.modelId} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, modelId: e.target.value } })} placeholder="anthropic/claude-sonnet-4.6" /></Field>
					</div>
					<Field label="Base URL"><input className="input mono" value={editing.draft.baseUrl} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, baseUrl: e.target.value } })} placeholder="https://ai-gateway.vercel.sh/v1" /></Field>
					<Field label="API key" hint="stored as a synced secret">{secretInput(`profile.apiKey.${editing.draft.name}`)}</Field>
					<div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
						<button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
						<button
							className="btn primary"
							disabled={!editing.draft.name}
							onClick={() => {
								if (editing.index === null) setProfiles([...profiles, editing.draft]);
								else setProfile(editing.index, editing.draft);
								setExpanded(editing.draft.name);
								setEditing(null);
							}}
						>
							{editing.index === null ? "Add" : "Save"}
						</button>
					</div>
				</Modal>
			)}
			<div className="save-bar">
				<button className="btn primary" onClick={() => void save()}>Save settings</button>
				<span className="muted" style={{ fontSize: 12 }}>{msg}</span>
			</div>
		</div>
	);
}
