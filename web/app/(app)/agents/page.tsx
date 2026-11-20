"use client";

import { Bot, Cloud, Laptop, Pin, Plus, Send } from "lucide-react";
import { useState } from "react";

type Mode = "cloud" | "local";
type Status = "active" | "idle" | "busy";

interface Message {
	id: number;
	role: "user" | "agent";
	text: string;
}

interface Agent {
	id: string;
	name: string;
	status: Status;
	mode: Mode;
	repo: string;
	branch: string;
	messages: Message[];
}

// Placeholder data — replace with real agent sessions once the API exists.
const SEED_AGENTS: Agent[] = [
	{
		id: "agent-alpha",
		name: "Agent Alpha",
		status: "active",
		mode: "cloud",
		repo: "georgereal/kronyx",
		branch: "main",
		messages: [
			{ id: 1, role: "user", text: "Refactor the memory search to bound the SQL row limit." },
			{ id: 2, role: "agent", text: "Done. listChunks now defaults to 1000 rows before bounded top-k ranking." },
		],
	},
	{
		id: "agent-beta",
		name: "Agent Beta",
		status: "idle",
		mode: "local",
		repo: "georgereal/kronyx",
		branch: "feat/ide-tools",
		messages: [],
	},
	{
		id: "agent-gamma",
		name: "Agent Gamma",
		status: "busy",
		mode: "cloud",
		repo: "georgereal/kronyx",
		branch: "fix/diagnostics",
		messages: [{ id: 1, role: "user", text: "Investigate the post-edit diagnostics timeout." }],
	},
];

const STATUS_LABEL: Record<Status, string> = {
	active: "Active",
	idle: "Idle",
	busy: "Running",
};

/** /agents — cloud agent workspace: agent list, transcript, and composer. */
export default function AgentsPage() {
	const [agents, setAgents] = useState<Agent[]>(SEED_AGENTS);
	const [selectedId, setSelectedId] = useState<string | null>(SEED_AGENTS[0]?.id ?? null);
	const [draft, setDraft] = useState("");
	const [nextMessageId, setNextMessageId] = useState(100);

	const selected = agents.find((a) => a.id === selectedId) ?? null;

	const updateSelected = (patch: Partial<Agent>) => {
		if (!selected) return;
		setAgents((list) => list.map((a) => (a.id === selected.id ? { ...a, ...patch } : a)));
	};

	const newSession = () => {
		const n = agents.length + 1;
		const agent: Agent = {
			id: `agent-${Date.now()}`,
			name: `Agent ${n}`,
			status: "idle",
			mode: "cloud",
			repo: "georgereal/kronyx",
			branch: "main",
			messages: [],
		};
		setAgents((list) => [...list, agent]);
		setSelectedId(agent.id);
		setDraft("");
	};

	const send = () => {
		const text = draft.trim();
		if (!selected || !text) return;
		const userMsg: Message = { id: nextMessageId, role: "user", text };
		const agentMsg: Message = {
			id: nextMessageId + 1,
			role: "agent",
			text: "Queued. Backend execution is not wired up yet.",
		};
		setNextMessageId(nextMessageId + 2);
		updateSelected({ status: "busy", messages: [...selected.messages, userMsg, agentMsg] });
		setDraft("");
	};

	return (
		<div className="agents-page">
			<aside className="agents-side card">
				<div className="agents-side-head">
					<h2>Agents</h2>
					<button className="btn sm" onClick={newSession}>
						<Plus size={13} /> New session
					</button>
				</div>
				<nav className="agents-list">
					{agents.map((a) => (
						<button
							key={a.id}
							type="button"
							onClick={() => {
								setSelectedId(a.id);
								setDraft("");
							}}
							className={`agents-item${a.id === selectedId ? " on" : ""}`}
						>
							<span className={`agents-dot ${a.status}`} aria-hidden />
							<span className="agents-item-main">
								<span className="agents-item-name">{a.name}</span>
								<span className="agents-item-sub muted">
									{STATUS_LABEL[a.status]} · {a.branch}
								</span>
							</span>
						</button>
					))}
				</nav>
			</aside>

			<section className="agents-main card">
				{selected ? (
					<>
						<header className="agents-head">
							<div className="agents-head-title">
								<Bot size={16} />
								<h1>{selected.name}</h1>
								<span className={`agents-badge ${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
							</div>
							<div className="agents-seg" role="group" aria-label="Execution mode">
								<button
									type="button"
									className={selected.mode === "cloud" ? "on" : ""}
									onClick={() => updateSelected({ mode: "cloud" })}
								>
									<Cloud size={12} /> Cloud
								</button>
								<button
									type="button"
									className={selected.mode === "local" ? "on" : ""}
									onClick={() => updateSelected({ mode: "local" })}
								>
									<Laptop size={12} /> Local
								</button>
							</div>
						</header>

						<div className="agents-pinned muted">
							<Pin size={12} />
							<span>
								{selected.repo} · {selected.branch} · {selected.mode === "cloud" ? "Cloud sandbox" : "Local IDE"}
							</span>
						</div>

						<div className="agents-transcript">
							{selected.messages.length === 0 ? (
								<div className="agents-empty muted">No messages yet. Describe a task to start this agent.</div>
							) : (
								selected.messages.map((m) => (
									<div key={m.id} className={`agents-msg ${m.role}`}>
										<div className="agents-bubble">{m.text}</div>
									</div>
								))
							)}
						</div>

						<div className="agents-composer">
							<textarea
								className="input"
								rows={3}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
								}}
								placeholder="Describe a task for this agent… (⌘/Ctrl+Enter to send)"
							/>
							<div className="agents-composer-foot">
								<span className="muted">Executes in {selected.mode === "cloud" ? "the cloud" : "your local IDE"}</span>
								<button className="btn sm" onClick={send} disabled={!draft.trim()}>
									<Send size={12} /> Send
								</button>
							</div>
						</div>
					</>
				) : (
					<div className="agents-empty muted">Select an agent or create a new session to get started.</div>
				)}
			</section>
		</div>
	);
}
