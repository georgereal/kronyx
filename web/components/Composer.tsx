"use client";

import type { User } from "firebase/auth";
import { Cpu, GitBranch, Paperclip, Plus, SendHorizontal, Settings2, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { ModelGroup, ModelOption } from "@/lib/types";

export type Mode = "ask" | "plan" | "agent";

export interface Attachment {
	attachmentId: string;
	filename: string;
	size: number;
}

export interface EnvState {
	repo: string;
	base: string;
	installationId: number | null;
	extraRepos: string[];
	template: string;
	securityProfile: "agent" | "bypass";
}

export const emptyEnv: EnvState = { repo: "", base: "", installationId: null, extraRepos: [], template: "", securityProfile: "agent" };

const MODES: { id: Mode; label: string; desc: string }[] = [
	{ id: "agent", label: "Agent", desc: "Full writes — branch, verify, push & open a PR" },
	{ id: "plan", label: "Plan", desc: "Read-only exploration, saves a plan to implement" },
	{ id: "ask", label: "Ask", desc: "Chat only — no sandbox, no repo needed" },
];

const SLASH_COMMANDS: { name: string; desc: string; action: "mode" | "prompt"; mode?: Mode; text?: string }[] = [
	{ name: "ask", desc: "Switch to Ask mode", action: "mode", mode: "ask" },
	{ name: "plan", desc: "Switch to Plan mode", action: "mode", mode: "plan" },
	{ name: "agent", desc: "Switch to Agent mode", action: "mode", mode: "agent" },
	{ name: "implement", desc: "Saved prompt — implement a described change", action: "prompt", text: "Implement the following change, following existing code conventions: " },
	{ name: "bug-catcher", desc: "Saved prompt — find and fix a bug", action: "prompt", text: "Find and fix the bug described below. First reproduce it or identify the root cause, then make a minimal fix: " },
	{ name: "review", desc: "Saved prompt — review recent changes", action: "prompt", text: "Review the recent changes on this branch for correctness, edge cases and style. Report findings by severity: " },
	{ name: "summarize", desc: "Saved prompt — summarize an area", action: "prompt", text: "Explain how the following area of the codebase works — entry points, data flow, key files: " },
];

interface Repo { repo: string; defaultBranch: string; installationId: number; }

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

	useEffect(() => {
		if (autoFocus) taRef.current?.focus();
	}, [autoFocus]);

	const toggleMenu = (m: typeof menu) => setMenu((cur) => (cur === m ? "none" : m));
	const closeMenus = () => setMenu("none");

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
								<div className="pop" onClick={(e) => e.stopPropagation()}>
									<div className="pop-title">Repository</div>
									<input className="pop-search" placeholder="Search repos…" value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} />
									<div className="pop-scroll">
										{repoFiltered.map((r) => (
											<button
												key={r.repo}
												className="pop-item"
												onClick={() => {
													if (env.repo === r.repo) return;
													onEnv({ ...env, repo: r.repo, base: r.defaultBranch, installationId: r.installationId });
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
											<div className="pop-title">Extra repos (read-only context)</div>
											<div className="pop-scroll" style={{ maxHeight: 140 }}>
												{repoFiltered.filter((r) => r.repo !== env.repo).map((r) => (
													<button
														key={r.repo}
														className="pop-item"
														onClick={() =>
															onEnv({
																...env,
																extraRepos: env.extraRepos.includes(r.repo)
																	? env.extraRepos.filter((x) => x !== r.repo)
																	: [...env.extraRepos, r.repo],
															})
														}
													>
														<span className="mono" style={{ flex: 1 }}>{r.repo}</span>
														<span className="right">{env.extraRepos.includes(r.repo) ? "✓" : ""}</span>
													</button>
												))}
											</div>
										</>
									)}
									<div className="pop-sep" />
									<div className="pop-title">Environment</div>
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
										onClick={() => onEnv({ ...env, securityProfile: env.securityProfile === "agent" ? "bypass" : "agent" })}
									>
										<span style={{ flex: 1 }}>Security profile</span>
										<span className="right">{env.securityProfile === "bypass" ? "Bypass approvals" : "Agent (default)"}</span>
									</button>
									<div className="pop-item disabled">
										<span style={{ flex: 1 }}>MCP connectors</span>
										<span className="right">Coming soon</span>
									</div>
								</div>
							)}
						</div>
					)}
					{env?.repo && <span className="sess-chip mono" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>{env.repo}</span>}
					<div className="spacer" />
					<div className="anchor">
						<button className="chip-btn" onClick={() => toggleMenu("model")}>
							<Cpu size={12} /> {MODES.find((m) => m.id === mode)?.label ?? "Agent"} · {modelLabel.length > 26 ? `${modelLabel.slice(0, 24)}…` : modelLabel}
						</button>
						{menu === "model" && (
							<div className="pop" style={{ left: "auto", right: 0, minWidth: 340 }} onClick={(e) => e.stopPropagation()}>
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
								<div className="pop-sep" />
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
					{running ? (
						<span className="send-btn stop">
							<button onClick={onStop} title="Stop">
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
