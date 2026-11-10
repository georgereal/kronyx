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
}

export interface RunEvent {
	runId?: string;
	seq: number;
	event: { type: string; [k: string]: unknown };
}
