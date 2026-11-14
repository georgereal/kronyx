/** Client-safe shared types (server copies live in backend/src/lib). */
export interface ModelOption {
	id: string;
	label?: string;
	description?: string;
	contextWindow?: number;
	maxTokens?: number;
	pricing?: { input?: number; output?: number };
	modalities?: { input?: string[]; output?: string[] };
	tags?: string[];
	owner?: string;
}

export interface ModelGroup {
	profile: string;
	active?: boolean;
	models: ModelOption[];
}

export interface SessionDoc {
	sessionId: string;
	title?: string;
	repo?: string | null;
	base?: string;
	branch?: string | null;
	prUrl?: string | null;
	mode?: string;
	template?: string | null;
	startRef?: string;
	installationId?: number | null;
	extraRepos?: string[];
	securityProfile?: string;
	updatedAt?: string;
	lastTask?: string;
	lastStatus?: string | null;
}

export interface RunDoc {
	runId: string;
	task?: string;
	status?: string;
	mode?: string;
	at?: number;
	durationMs?: number;
	tokensIn?: number;
	tokensOut?: number;
	createdAt?: string;
	finishedAt?: string;
	/** Multi-agent mode: per-slice status for the fan-out card. */
	slices?: { index: number; title: string; status: string; summary?: string }[];
	/** Sub-run linkage: set on multi-agent slice/coordinator docs. */
	parentRunId?: string;
	kind?: string;
	agentIndex?: number;
	summary?: string;
}

export interface RunEvent {
	runId?: string;
	seq: number;
	at?: string;
	event: { type: string; agentIndex?: number; [k: string]: unknown };
}
