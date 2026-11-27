/**
 * Ports (vscode-free): the interfaces the harness loop depends on and the
 * normalized request/response/value types crossing the provider boundary.
 */

import type { ProviderItems, ToolCall, Usage } from "./events";
import type { Task } from "./tasks";
import type { RequestStrategy } from "../policies/requestStrategy";
import type { Ledger } from "../taskLedger";
import type { Message } from "../projections";

export interface ToolSpec {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** True for read-only tools that may run concurrently with adjacent parallel calls. */
	parallel?: boolean;
}

export interface ToolResult {
	ok: boolean;
	output: string;
	/** Token usage of nested model calls (e.g. a subagent), counted against the session budget. */
	usage?: Usage;
}

export const HOOK_POINTS = ["beforeModel", "beforeTool", "afterTool", "onStop", "onError"] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];

/**
 * A rule's answer. `deny` and `ask` block (ask has no approval channel here, so it blocks too).
 * `note` is extra guidance that becomes a durable steer.note event.
 */
export type HookDecision =
	| { kind: "allow" }
	| { kind: "note"; text: string }
	| { kind: "ask"; question: string }
	| { kind: "deny"; reason: string };

export interface HookRule<Ctx = unknown> {
	id: string;
	point: HookPoint;
	order: number;
	decide(ctx: Ctx): HookDecision | Promise<HookDecision>;
}

export interface LoopDetectorConfig {
	/** How many recent tool calls the detectors look at. */
	window: number;
	/** Identical (tool, args) calls within the window that count as a repeat. */
	repeatThreshold: number;
	/** Identical results for identical calls that count as no progress. */
	resultThreshold: number;
	/** A-B-A-B cycles that count as alternation. */
	alternationThreshold: number;
}

export const DEFAULT_LOOP_DETECTOR: LoopDetectorConfig = {
	window: 10,
	repeatThreshold: 3,
	resultThreshold: 3,
	alternationThreshold: 3,
};

export interface ModelRequest {
	turn: number;
	system: string;
	messages: readonly Message[];
	ledger: Ledger;
	tools: readonly ToolSpec[];
	/** Aborted when the user stops the run. Adapters must cancel the in-flight request. */
	signal?: AbortSignal;
	/** Receives reasoning/thinking chunks as they stream, when the provider emits them. */
	onReasoningDelta?: (text: string) => void;
	/** Receives assistant text chunks as they stream, when the provider emits them. */
	onTextDelta?: (text: string) => void;
	/** Continue this server-side conversation. `messages` is then only the delta the conversation has not seen. */
	conversation?: { id: string };
}

export interface ModelResponse {
	text: string;
	toolCalls: ToolCall[];
	usage?: Usage;
	/** Final reasoning/thinking text for the turn, when the provider emits it. */
	reasoning?: string;
	responseId?: string;
	providerItems?: ProviderItems;
}

/** Server-side conversation support. The loop binds, sends deltas, and resets; the port only creates the conversation. */
export interface ConversationPort {
	readonly provider: string;
	readonly model: string;
	create(): Promise<string>;
}

/** What a transport adapter can do. Selection inputs for behavior profiles — never the transport kind alone. */
export interface AdapterCapabilities {
	wire: "cline" | "responses" | "chat" | "conversations";
	/** The endpoint keeps server-side conversation state. */
	serverConversations: boolean;
	/** Provider output items replay (reasoning, compaction) is supported. */
	reasoningItems: boolean;
	/** Responses `store` flag is on. */
	store: boolean;
}

export interface ModelPort {
	complete(request: ModelRequest): Promise<ModelResponse>;
	/** Present when the endpoint keeps server-side conversations. Absent means every request carries the full projection. */
	readonly conversations?: ConversationPort;
	/** Request lifecycle override (e.g. a server-side conversation bind/delta/sync). Absent → the stateless projection strategy. */
	readonly strategy?: RequestStrategy;
	/** Declared adapter capabilities; behavior profiles select on these. */
	readonly capabilities?: AdapterCapabilities;
}

export interface ToolPort {
	specs(): readonly ToolSpec[];
	execute(name: string, input: unknown, callId?: string): Promise<ToolResult>;
}

/** Acceptance check for a task. The harness calls it before accepting a `done` transition. */
export interface VerifierPort {
	check(task: Task): Promise<{ ok: boolean; detail: string }>;
}

