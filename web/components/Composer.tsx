"use client";

import type { User } from "firebase/auth";
import { Cpu, GitBranch, Paperclip, Plus, SendHorizontal, Settings2, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Modal } from "@/components/Modal";
import type { ModelGroup, ModelOption } from "@/lib/types";

export type Mode = "ask" | "plan" | "agent" | "multi";

export interface Attachment {
	attachmentId: string;
	filename: string;
	size: number;
}

export interface EnvState {
	repo: string;
	base: string;
	/** Ref to check out at clone time: branch name or pull/<n>/head. Defaults to base. */
	startRef: string;
	/** Display label when the start point came from a PR pick, e.g. "#42". */
	prLabel: string;
	installationId: number | null;
	extraRepos: string[];
	template: string;
	securityProfile: "agent" | "bypass" | "controlled";
}

export const emptyEnv: EnvState = { repo: "", base: "", startRef: "", prLabel: "", installationId: null, extraRepos: [], template: "", securityProfile: "agent" };

const MODES: { id: Mode; label: string; desc: string }[] = [
	{ id: "agent", label: "Agent", desc: "Full writes — branch, verify, push & open a PR" },
	{ id: "multi", label: "Multi", desc: "Parallel agents — task is split, merged into one PR" },
	{ id: "plan", label: "Plan", desc: "Read-only exploration, saves a plan to implement" },
	{ id: "ask", label: "Ask", desc: "Chat only — no sandbox, no repo needed" },
];

const SLASH_COMMANDS: { name: string; desc: string; action: "mode" | "prompt"; mode?: Mode; text?: string }[] = [
	{ name: "ask", desc: "Switch to Ask mode", action: "mode", mode: "ask" },
	{ name: "plan", desc: "Switch to Plan mode", action: "mode", mode: "plan" },
	{ name: "agent", desc: "Switch to Agent mode", action: "mode", mode: "agent" },
	{ name: "multi", desc: "Switch to Multi-agent mode", action: "mode", mode: "multi" },
	{ name: "implement", desc: "Saved prompt — implement a described change", action: "prompt", text: "Implement the following change, following existing code conventions: " },
	{ name: "bug-catcher", desc: "Saved prompt — find and fix a bug", action: "prompt", text: "Find and fix the bug described below. First reproduce it or identify the root cause, then make a minimal fix: " },
	{ name: "review", desc: "Saved prompt — review recent changes", action: "prompt", text: "Review the recent changes on this branch for correctness, edge cases and style. Report findings by severity: " },
	{ name: "summarize", desc: "Saved prompt — summarize an area", action: "prompt", text: "Explain how the following area of the codebase works — entry points, data flow, key files: " },
];

interface Repo { repo: string; defaultBranch: string; installationId: number; }
interface Pr { number: number; title: string; headRef: string; headRepo: string | null; baseRef: string; user: string; }

function fmtSize(n: number): string {
	return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function Composer({
	user,
	mode,
	onMode,
	env,
	onEnv,
	onSubmit,
	onStop,
	running,
	stopping,
	autoFocus,
	onModel,
}: {
	user: User;
	mode: Mode;
	onMode: (m: Mode) => void;
	env?: EnvState;
	onEnv?: (e: EnvState) => void;
	onSubmit: (task: string, attachmentIds: string[]) => void;
	onStop?: () => void;
	running?: boolean;
	/** Run is halting — show a disabled "stopping" state instead of a stop button. */
	stopping?: boolean;
	autoFocus?: boolean;
	onModel?: (modelId: string, profile: string) => void;
}) {
	const [text, setText] = useState("");
	const [atts, setAtts] = useState<Attachment[]>([]);
	const [menu, setMenu] = useState<"none" | "attach" | "env" | "model" | "slash" | "mode">("none");
	const [repos, setRepos] = useState<Repo[]>([]);
	const [groups, setGroups] = useState<ModelGroup[]>([]);
	const [modelId, setModelId] = useState("");
	const [modelProfile, setModelProfile] = useState("");
	const [repoQuery, setRepoQuery] = useState("");
	const [modelQuery, setModelQuery] = useState("");
	const [branches, setBranches] = useState<string[]>([]);
	const [branchQuery, setBranchQuery] = useState("");
	const [envPage, setEnvPage] = useState<"menu" | "branch">("menu");
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [prs, setPrs] = useState<Pr[]>([]);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!env) return;
		void (async () => {
			const res = await apiFetch("/api/github/repos", user);
			if (res.ok) setRepos(((await res.json()) as { repos: Repo[] }).repos ?? []);
		})();
	}, [user, env]);

	useEffect(() => {
		void (async () => {
			const res = await apiFetch("/api/models", user);
			if (res.ok) setGroups(((await res.json()) as { groups: ModelGroup[] }).groups ?? []);
		})();
		const saved = typeof window !== "undefined" ? localStorage.getItem("kronyx.modelId") : null;
		if (saved) setModelId(saved);
		const savedProfile = typeof window !== "undefined" ? localStorage.getItem("kronyx.modelProfile") : null;
		if (savedProfile) setModelProfile(savedProfile);
	}, [user]);

	useEffect(() => onModel?.(modelId, modelProfile), [modelId, modelProfile, onModel]);

	// Branch + open-PR lists for the start-point picker — lazy per repo,
	// fetched when the branch page opens.
	useEffect(() => {
		if (!env?.repo || !env.installationId || menu !== "env" || envPage !== "branch") return;
		const repo = env.repo;
		const inst = env.installationId;
		setBranches([]);
		setPrs([]);
		const q = `?installationId=${inst}&repo=${encodeURIComponent(repo)}`;
		void apiFetch(`/api/github/branches${q}`, user)
			.then(async (r) => (r.ok ? setBranches(((await r.json()) as { branches: string[] }).branches ?? []) : undefined))
			.catch(() => {});
		void apiFetch(`/api/github/prs${q}`, user)
			.then(async (r) => (r.ok ? setPrs(((await r.json()) as { prs: Pr[] }).prs ?? []) : undefined))
			.catch(() => {});
	}, [env?.repo, env?.installationId, menu, envPage, user]);

	useEffect(() => {
		if (autoFocus) taRef.current?.focus();
	}, [autoFocus]);

	const toggleMenu = (m: typeof menu) => {
		setMenu((cur) => (cur === m ? "none" : m));
		setEnvPage("menu");
	};
	const closeMenus = () => {
		setMenu("none");
		setEnvPage("menu");
	};

	const submit = () => {
		const task = text.trim();
		if (!task || running) return;
		if (modelId && env) localStorage.setItem("kronyx.modelId", modelId);
		if (modelId) localStorage.setItem("kronyx.modelId", modelId);
		onSubmit(task, atts.map((a) => a.attachmentId));
		setText("");
		setAtts([]);
	};

	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && ((!e.shiftKey && menu !== "slash") || e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			submit();
		}
		if (e.key === "Escape") closeMenus();
	};

	const onChange = (v: string) => {
		setText(v);
		setMenu(v.startsWith("/") && !v.includes(" ") ? "slash" : menu === "slash" ? "none" : menu);
	};

	const pickSlash = (c: (typeof SLASH_COMMANDS)[number]) => {
		if (c.action === "mode" && c.mode) {
			onMode(c.mode);
			setText("");
		} else {
			setText(c.text ?? "");
		}
		setMenu("none");
		taRef.current?.focus();
	};

	const upload = async (files: FileList | null) => {
		if (!files?.length) return;
		const fd = new FormData();
		for (const f of files) fd.append("files", f);
		const res = await apiFetch("/api/attachments", user, { method: "POST", body: fd });
		if (res.ok) {
			const body = (await res.json()) as { attachments: Attachment[] };
			setAtts((a) => [...a, ...body.attachments]);
		}
	};

	const slashFiltered = SLASH_COMMANDS.filter((c) => c.name.startsWith(text.slice(1).toLowerCase()));
	const repoFiltered = repos.filter((r) => r.repo.toLowerCase().includes(repoQuery.toLowerCase()));
	// Selected repo only, until the user searches or nothing is selected.
	const repoShown = env?.repo && !repoQuery ? repoFiltered.filter((r) => r.repo === env.repo) : repoFiltered;
	const modelFiltered = groups
		.map((g) => ({ ...g, models: g.models.filter((m) => m.id.toLowerCase().includes(modelQuery.toLowerCase())).slice(0, 60) }))
		.filter((g) => g.models.length > 0);
	const modelLabel = modelId || "Model";

	const fmtCtx = (n?: number) => (n ? (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`) : "");
	const fmtPrice = (p?: { input?: number; output?: number }) => {
		if (!p?.input && !p?.output) return "";
		const per = (v?: number) => (v === undefined ? "?" : v * 1_000_000 < 1 ? `$${(v * 1_000_000).toFixed(2)}` : `$${(v * 1_000_000).toFixed(1)}`);
		return `${per(p.input)}/${per(p.output)}`;
	};
	const modelDesc = (m: ModelOption) =>
		[fmtCtx(m.contextWindow), m.modalities?.input?.join("+"), fmtPrice(m.pricing)].filter(Boolean).join(" · ");

	const pickModel = (m: ModelOption, profile: string) => {
		setModelId(m.id);
		setModelProfile(profile);
		localStorage.setItem("kronyx.modelId", m.id);
		localStorage.setItem("kronyx.modelProfile", profile);
		setMenu("none");
	};

	return (
		<div onKeyDown={onKey}>
			<div className="composer" onClick={closeMenus}>
				<textarea
					ref={taRef}
					value={text}
					placeholder={mode === "ask" ? "Ask a question… ( / for commands )" : "Ask Kronyx to build features, fix bugs, or work on your code"}
					onChange={(e) => onChange(e.target.value)}
					onClick={(e) => e.stopPropagation()}
					onFocus={() => text.startsWith("/") && setMenu("slash")}
				/>
				{menu === "slash" && slashFiltered.length > 0 && (
					<div className="pop" onClick={(e) => e.stopPropagation()} style={{ position: "absolute", marginTop: -6 }}>
						<div className="pop-title">Commands</div>
						<div className="pop-scroll">
							{slashFiltered.map((c) => (
								<button key={c.name} className="pop-item" onClick={() => pickSlash(c)}>
									<span className="mono">/{c.name}</span>
									<span className="right">{c.desc}</span>
								</button>
							))}
						</div>
					</div>
				)}
				{atts.length > 0 && (
					<div className="att-chips">
						{atts.map((a) => (
							<span key={a.attachmentId} className="att-chip">
								<Paperclip size={11} /> {a.filename}
								<span className="muted">{fmtSize(a.size)}</span>
								<button onClick={() => setAtts(atts.filter((x) => x.attachmentId !== a.attachmentId))}>
									<X size={11} />
								</button>
							</span>
						))}
					</div>
				)}
				<div className="composer-bar" onClick={(e) => e.stopPropagation()}>
					<div className="anchor">
						<button className="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}>
							<Plus size={16} />
						</button>
						<input ref={fileRef} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
					</div>
					{env && onEnv && (
						<div className="anchor">
							<button className="icon-btn" title="Environment" onClick={() => toggleMenu("env")}>
								<Settings2 size={15} />
							</button>
							{menu === "env" && (
								<Modal title={envPage === "branch" ? `Select branch — ${env.repo}` : "Environment"} onClose={closeMenus}>
									{envPage === "branch" && env.repo ? (
										<>
											<button className="pop-item" onClick={() => setEnvPage("menu")}>
												<span className="muted" style={{ flex: 1 }}>← {env.repo}</span>
											</button>
											<div className="pop-sep" />
											<div className="pop-title">Start from</div>
											{branches.length > 15 && (
												<input
													className="pop-search"
													placeholder="Search branches…"
													value={branchQuery}
													onChange={(e) => setBranchQuery(e.target.value)}
												/>
											)}
											<div className="pop-scroll" style={{ maxHeight: 220 }}>
												{branches.filter((b) => b.toLowerCase().includes(branchQuery.toLowerCase())).slice(0, 60).map((b) => {
													const sel = !env.prLabel && (env.startRef || env.base) === b;
													return (
														<button
															key={b}
															className="pop-item"
															onClick={() => {
																onEnv({ ...env, base: b, startRef: b, prLabel: "" });
																setEnvPage("menu");
															}}
														>
															<GitBranch size={13} />
															<span className="mono" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{b}</span>
															{sel && <span className="right">✓</span>}
														</button>
													);
												})}
												{branches.length === 0 && <div className="pop-item disabled">Loading branches…</div>}
											</div>
											{prs.length > 0 && (
												<>
													<div className="pop-title">Open PRs</div>
													<div className="pop-scroll" style={{ maxHeight: 160 }}>
														{prs.map((p) => {
															const sel = env.prLabel === `#${p.number}`;
															return (
																<button
																	key={p.number}
																	className="pop-item"
																	onClick={() => {
																		onEnv({
																			...env,
																			base: p.baseRef,
																			startRef: p.headRepo === env.repo ? p.headRef : `pull/${p.number}/head`,
																			prLabel: `#${p.number}`,
																		});
																		setEnvPage("menu");
																	}}
																>
																	<span style={{ flex: 1, minWidth: 0 }}>
																		<span style={{ display: "block", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
																			#{p.number} {p.title}
																		</span>
																		<span className="muted mono" style={{ display: "block", fontSize: 10.5 }}>
																			{p.headRef} → {p.baseRef}
																		</span>
																	</span>
																	{sel && <span className="right">✓</span>}
																</button>
															);
														})}
													</div>
												</>
											)}
										</>
									) : (
										<>
											<div className="pop-title">Repository</div>
											<input className="pop-search" placeholder={env.repo ? "Search all repos…" : "Search repos…"} value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} />
											<div className="pop-scroll" style={{ maxHeight: 200 }}>
												{repoShown.map((r) => (
													<button
														key={r.repo}
														className="pop-item"
														onClick={() => {
															if (env.repo === r.repo) {
																onEnv({ ...env, repo: "", base: "", startRef: "", prLabel: "", installationId: null });
																return;
															}
															onEnv({ ...env, repo: r.repo, base: r.defaultBranch, startRef: "", prLabel: "", installationId: r.installationId });
														}}
													>
														<GitBranch size={13} />
														<span className="mono" style={{ flex: 1 }}>{r.repo}</span>
														{env.repo === r.repo && <span className="right">✓</span>}
														{env.repo !== r.repo && env.extraRepos.includes(r.repo) && <span className="right">extra</span>}
													</button>
												))}
												{repos.length === 0 && (
													<div className="pop-item disabled">
														No repos —{" "}
														<a href="/connect" style={{ color: "var(--accent)" }}>connect GitHub</a>
													</div>
												)}
											</div>
											{env.repo && (
												<>
													<div className="pop-sep" />
													<button
														className="pop-item"
														onClick={() => {
															setBranchQuery("");
															setEnvPage("branch");
														}}
													>
														<GitBranch size={13} />
														<span style={{ flex: 1 }}>Select branch</span>
														<span className="right mono" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
															{env.prLabel || env.startRef || env.base} →
														</span>
													</button>
												</>
											)}
											<div className="pop-sep" />
											<button className="pop-item" onClick={() => setShowAdvanced((v) => !v)}>
												<span style={{ flex: 1 }}>Advanced</span>
												<span className="right">{showAdvanced ? "▾" : "▸"}</span>
											</button>
											{showAdvanced && (
												<>
													<div className="pop-item" style={{ cursor: "default" }}>
														<span style={{ flex: 1 }}>Virtual environment</span>
														<input
															className="pop-search"
															style={{ width: 130, margin: 0 }}
															placeholder="e2b template"
															value={env.template}
															onChange={(e) => onEnv({ ...env, template: e.target.value })}
														/>
													</div>
													<button
														className="pop-item"
														onClick={() =>
															onEnv({
																...env,
																securityProfile:
																	env.securityProfile === "agent" ? "controlled" : env.securityProfile === "controlled" ? "bypass" : "agent",
															})
														}
													>
														<span style={{ flex: 1 }}>Security profile</span>
														<span className="right">
															{env.securityProfile === "bypass" ? "Bypass approvals" : env.securityProfile === "controlled" ? "Approve each change" : "Agent (default)"}
														</span>
													</button>
													<div className="pop-item disabled">
														<span style={{ flex: 1 }}>MCP connectors</span>
														<span className="right">Coming soon</span>
													</div>
												</>
											)}
										</>
									)}
								</Modal>
							)}
						</div>
					)}
					{env?.repo ? (
						<button
							className="sess-chip mono"
							style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}
							onClick={() => toggleMenu("env")}
							title="Change repository or branch"
						>
							{env.repo}
							{env.prLabel ? ` ${env.prLabel}` : ` @${env.startRef || env.base}`}
						</button>
					) : (
						env && onEnv && mode !== "ask" && (
							<button className="chip-btn" onClick={() => toggleMenu("env")}>
								<GitBranch size={12} /> Select repository
							</button>
						)
					)}
					<div className="spacer" />
					<div className="anchor">
						<button className="chip-btn" onClick={() => toggleMenu("mode")}>
							{MODES.find((m) => m.id === mode)?.label ?? "Agent"}
						</button>
						{menu === "mode" && (
							<div className="pop" style={{ left: "auto", right: 0, minWidth: 260 }} onClick={(e) => e.stopPropagation()}>
								<div className="pop-title">Mode</div>
								{MODES.map((m) => (
									<button key={m.id} className="pop-item" onClick={() => { onMode(m.id); closeMenus(); }}>
										<span style={{ flex: 1 }}>
											<span style={{ display: "block", fontSize: 12.5 }}>{m.label}</span>
											<span className="muted" style={{ display: "block", fontSize: 10.5 }}>{m.desc}</span>
										</span>
										{mode === m.id && <span className="right">✓</span>}
									</button>
								))}
							</div>
						)}
					</div>
					<div className="anchor">
						<button className="chip-btn" onClick={() => toggleMenu("model")}>
							<Cpu size={12} /> {modelLabel.length > 26 ? `${modelLabel.slice(0, 24)}…` : modelLabel}
						</button>
						{menu === "model" && (
							<div className="pop" style={{ left: "auto", right: 0, minWidth: 340 }} onClick={(e) => e.stopPropagation()}>
								<input className="pop-search" placeholder="Search models" value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} />
								<div className="pop-scroll">
									{modelFiltered.map((g) => (
										<div key={g.profile}>
											<div className="pop-title">
												{g.profile}
												{g.active ? " · active" : ""}
											</div>
											{g.models.map((m) => (
												<button key={`${g.profile}:${m.id}`} className="pop-item" onClick={() => pickModel(m, g.profile)}>
													<span style={{ flex: 1, minWidth: 0 }}>
														<span className="mono" style={{ display: "block", fontSize: 12 }}>{m.label ?? m.id}</span>
														{modelDesc(m) && <span className="muted" style={{ display: "block", fontSize: 10.5 }}>{modelDesc(m)}</span>}
													</span>
													{modelId === m.id && modelProfile === g.profile && <span className="right">✓</span>}
												</button>
											))}
										</div>
									))}
									{modelFiltered.length === 0 && <div className="pop-item disabled">No models — set a provider in Settings</div>}
								</div>
							</div>
						)}
					</div>
					{running || stopping ? (
						<span className="send-btn stop">
							<button onClick={onStop} disabled={stopping} title={stopping ? "Stopping…" : "Stop"}>
								<Square size={14} />
							</button>
						</span>
					) : (
						<span className="send-btn">
							<button onClick={submit} disabled={!text.trim()} title="Send">
								<SendHorizontal size={14} />
							</button>
						</span>
					)}
				</div>
			</div>
		</div>
	);
}
