/**
 * Harness contracts (vscode-free): session events, task ledger entries, the
 * ports the loop depends on, and validators for the on-disk / wire format.
 */

import type { Ledger } from "./taskLedger";
import type { Message } from "./projections";

export const TASK_STATUSES = ["pending", "in_progress", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = ["pending", "in_progress", "blocked", "done"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Machine-checkable acceptance. `none` means the harness accepts the task once its steps are covered; `reviewer` is reserved and not enabled. */
export type Acceptance = { kind: "command"; command: string } | { kind: "reviewer"; rubric: string } | { kind: "none" };

/** Auto-completion hint: the step is done when a matching tool call finishes ok. `path` is a repo-relative glob. */
export interface StepSignal {
	tool: string;
	path?: string;
}

export interface Step {
	id: string;
	text: string;
	status: StepStatus;
	/** Tool-call ids that prove the step is done. Must all have finished ok before the step can be done. */
	callIds: string[];
	signal?: StepSignal;
}

export interface Task {
	id: string;
	title: string;
	acceptance: Acceptance;
	dependsOn: string[];
	status: TaskStatus;
	steps: Step[];
	evidence: string[];
	/** The run that owns this task — plans are per-run; tasks cross runs only via task.adopted. */
	runId?: string;
	/** The run this task was adopted from, when it crossed runs. */
	adoptedFrom?: string;
}

export interface ToolCall {
	callId: string;
	name: string;
	input: unknown;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
}

export const RUN_STATUSES = ["running", "completed", "paused", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const LOOP_LEVELS = ["none", "warn", "block", "strip", "pause"] as const;
export type LoopLevel = (typeof LOOP_LEVELS)[number];

/** Durable facts about a session. Everything else the harness knows is a projection of these. */
export type EventBody =
	| { type: "user.input"; text: string; images?: ImageInput[] }
	| { type: "model.response"; turn: number; text: string; toolCalls: ToolCall[]; usage?: Usage; reasoning?: string }
	| { type: "tool.requested"; callId: string; name: string; input: unknown }
	| { type: "tool.finished"; callId: string; name: string; ok: boolean; output: string; usage?: Usage }
	| { type: "task.created"; task: Task; usage?: Usage }
	| { type: "task.updated"; id: string; to: TaskStatus; reason?: string }
	| { type: "task.removed"; id: string }
	| { type: "task.adopted"; id: string }
	| { type: "step.added"; taskId: string; step: Step }
	| { type: "step.updated"; taskId: string; stepId: string; to: StepStatus; callIds: string[] }
	| { type: "verifier.result"; taskId: string; ok: boolean; detail: string }
	| { type: "stop.refused"; openTaskIds: string[] }
	| { type: "budget.warning"; kind: "input_tokens"; used: number; limit: number }
	| { type: "steer.note"; rule: string; text: string }
	| { type: "context.recap"; covers: number; text: string; usage?: Usage }
	| { type: "context.cleared" }
	| { type: "loop.verdict"; level: LoopLevel; fingerprint: string; reason?: string }
	| { type: "run.status"; status: RunStatus; reason?: string };

/** An attached image, base64 in the log so recovery keeps it. */
export interface ImageInput {
	mediaType: string;
	base64: string;
}

export type EventType = EventBody["type"];

export interface EventMeta {
	seq: number;
	at: number;
	runId: string;
}

export type SessionEvent = EventBody & EventMeta;
/** What callers hand to the log; the log stamps `seq` and `at`. */
export type NewEvent = EventBody & { runId: string };

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
}

export interface ModelResponse {
	text: string;
	toolCalls: ToolCall[];
	usage?: Usage;
	/** Final reasoning/thinking text for the turn, when the provider emits it. */
	reasoning?: string;
}

export interface ModelPort {
	complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ToolPort {
	specs(): readonly ToolSpec[];
	execute(name: string, input: unknown): Promise<ToolResult>;
}

/** Acceptance check for a task. The harness calls it before accepting a `done` transition. */
export interface VerifierPort {
	check(task: Task): Promise<{ ok: boolean; detail: string }>;
}

export class SchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SchemaError";
	}
}

export const expectObject = (value: unknown, path: string): Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SchemaError(`${path}: expected an object`);
	return value as Record<string, unknown>;
};

export const expectString = (value: unknown, path: string, { allowEmpty = false } = {}): string => {
	if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
		throw new SchemaError(`${path}: expected a ${allowEmpty ? "" : "non-empty "}string`);
	}
	return value;
};

export const expectBoolean = (value: unknown, path: string): boolean => {
	if (typeof value !== "boolean") throw new SchemaError(`${path}: expected a boolean`);
	return value;
};

export const expectOptionalString = (value: unknown, path: string): string | undefined =>
	value === undefined ? undefined : expectString(value, path);

export const expectStringArray = (value: unknown, path: string): string[] => {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new SchemaError(`${path}: expected an array of strings`);
	return value as string[];
};

export const expectInteger = (value: unknown, path: string, min = 0): number => {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw new SchemaError(`${path}: expected an integer >= ${min}`);
	return value;
};

export const expectOneOf = <T extends string>(value: unknown, options: readonly T[], path: string): T => {
	if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
		throw new SchemaError(`${path}: expected one of ${options.join(", ")}`);
	}
	return value as T;
};

export function parseAcceptance(value: unknown, path = "acceptance"): Acceptance {
	const o = expectObject(value, path);
	if (o.kind === "command") return { kind: "command", command: expectString(o.command, `${path}.command`) };
	if (o.kind === "reviewer") return { kind: "reviewer", rubric: expectString(o.rubric, `${path}.rubric`) };
	if (o.kind === "none") return { kind: "none" };
	throw new SchemaError(`${path}.kind: expected command, reviewer or none`);
}

export function parseSignal(value: unknown, path: string): StepSignal | undefined {
	if (value === undefined) return undefined;
	const o = expectObject(value, path);
	const pathGlob = o.path === undefined ? undefined : expectString(o.path, `${path}.path`);
	return { tool: expectString(o.tool, `${path}.tool`), ...(pathGlob === undefined ? {} : { path: pathGlob }) };
}

export function parseStep(value: unknown, path = "step"): Step {
	const o = expectObject(value, path);
	const signal = parseSignal(o.signal, `${path}.signal`);
	return {
		id: expectString(o.id, `${path}.id`),
		text: expectString(o.text, `${path}.text`),
		status: expectOneOf(o.status, STEP_STATUSES, `${path}.status`),
		callIds: expectStringArray(o.callIds, `${path}.callIds`),
		...(signal ? { signal } : {}),
	};
}

export function parseTask(value: unknown, path = "task"): Task {
	const o = expectObject(value, path);
	return {
		id: expectString(o.id, `${path}.id`),
		title: expectString(o.title, `${path}.title`),
		acceptance: parseAcceptance(o.acceptance, `${path}.acceptance`),
		dependsOn: expectStringArray(o.dependsOn, `${path}.dependsOn`),
		status: expectOneOf(o.status, TASK_STATUSES, `${path}.status`),
		steps: Array.isArray(o.steps) ? o.steps.map((s, i) => parseStep(s, `${path}.steps[${i}]`)) : (() => { throw new SchemaError(`${path}.steps: expected an array`); })(),
		evidence: expectStringArray(o.evidence, `${path}.evidence`),
		...(o.runId === undefined ? {} : { runId: expectString(o.runId, `${path}.runId`) }),
		...(o.adoptedFrom === undefined ? {} : { adoptedFrom: expectString(o.adoptedFrom, `${path}.adoptedFrom`) }),
	};
}

export function parseToolCall(value: unknown, path = "toolCall"): ToolCall {
	const o = expectObject(value, path);
	return { callId: expectString(o.callId, `${path}.callId`), name: expectString(o.name, `${path}.name`), input: o.input };
}

function parseUsage(value: unknown, path: string): Usage {
	const o = expectObject(value, path);
	return {
		inputTokens: expectInteger(o.inputTokens, `${path}.inputTokens`),
		outputTokens: expectInteger(o.outputTokens, `${path}.outputTokens`),
		cachedTokens: expectInteger(o.cachedTokens, `${path}.cachedTokens`),
	};
}

const EVENT_TYPES: readonly EventType[] = [
	"user.input",
	"model.response",
	"tool.requested",
	"tool.finished",
	"task.created",
	"task.updated",
	"task.removed",
	"task.adopted",
	"step.added",
	"step.updated",
	"verifier.result",
	"stop.refused",
	"budget.warning",
	"steer.note",
	"context.recap",
	"context.cleared",
	"loop.verdict",
	"run.status",
];

function parseImages(value: unknown): ImageInput[] {
	if (!Array.isArray(value)) throw new SchemaError("event.images: expected an array");
	return value.map((v, i) => {
		const o = expectObject(v, `event.images[${i}]`);
		return { mediaType: expectString(o.mediaType, `event.images[${i}].mediaType`), base64: expectString(o.base64, `event.images[${i}].base64`) };
	});
}

function parseBody(o: Record<string, unknown>, type: EventType): EventBody {
	switch (type) {
		case "user.input": {
			const images = o.images === undefined ? undefined : parseImages(o.images);
			return { type, text: expectString(o.text, "event.text", { allowEmpty: true }), ...(images ? { images } : {}) };
		}
		case "model.response": {
			const usage = o.usage === undefined ? undefined : parseUsage(o.usage, "event.usage");
			if (!Array.isArray(o.toolCalls)) throw new SchemaError("event.toolCalls: expected an array");
			const reasoning = o.reasoning === undefined ? undefined : expectString(o.reasoning, "event.reasoning", { allowEmpty: true });
			return {
				type,
				turn: expectInteger(o.turn, "event.turn", 1),
				text: expectString(o.text, "event.text", { allowEmpty: true }),
				toolCalls: o.toolCalls.map((c, i) => parseToolCall(c, `event.toolCalls[${i}]`)),
				...(usage ? { usage } : {}),
				...(reasoning ? { reasoning } : {}),
			};
		}
		case "tool.requested":
			return { type, callId: expectString(o.callId, "event.callId"), name: expectString(o.name, "event.name"), input: o.input };
		case "tool.finished": {
			const usage = o.usage === undefined ? undefined : parseUsage(o.usage, "event.usage");
			return {
				type,
				callId: expectString(o.callId, "event.callId"),
				name: expectString(o.name, "event.name"),
				ok: expectBoolean(o.ok, "event.ok"),
				output: expectString(o.output, "event.output", { allowEmpty: true }),
				...(usage ? { usage } : {}),
			};
		}
		case "task.created": {
			const usage = o.usage === undefined ? undefined : parseUsage(o.usage, "event.usage");
			return { type, task: parseTask(o.task, "event.task"), ...(usage ? { usage } : {}) };
		}
		case "task.updated":
			return {
				type,
				id: expectString(o.id, "event.id"),
				to: expectOneOf(o.to, TASK_STATUSES, "event.to"),
				...(o.reason === undefined ? {} : { reason: expectString(o.reason, "event.reason") }),
			};
		case "task.removed":
			return { type, id: expectString(o.id, "event.id") };
		case "task.adopted":
			return { type, id: expectString(o.id, "event.id") };
		case "step.added":
			return { type, taskId: expectString(o.taskId, "event.taskId"), step: parseStep(o.step, "event.step") };
		case "step.updated":
			return {
				type,
				taskId: expectString(o.taskId, "event.taskId"),
				stepId: expectString(o.stepId, "event.stepId"),
				to: expectOneOf(o.to, STEP_STATUSES, "event.to"),
				callIds: expectStringArray(o.callIds, "event.callIds"),
			};
		case "verifier.result":
			return {
				type,
				taskId: expectString(o.taskId, "event.taskId"),
				ok: expectBoolean(o.ok, "event.ok"),
				detail: expectString(o.detail, "event.detail", { allowEmpty: true }),
			};
		case "stop.refused":
			return { type, openTaskIds: expectStringArray(o.openTaskIds, "event.openTaskIds") };
		case "budget.warning":
			if (o.kind !== "input_tokens") throw new SchemaError("event.kind: expected input_tokens");
			return { type, kind: "input_tokens", used: expectInteger(o.used, "event.used"), limit: expectInteger(o.limit, "event.limit", 1) };
		case "steer.note":
			return { type, rule: expectString(o.rule, "event.rule"), text: expectString(o.text, "event.text") };
		case "context.recap": {
			const usage = o.usage === undefined ? undefined : parseUsage(o.usage, "event.usage");
			return { type, covers: expectInteger(o.covers, "event.covers", 1), text: expectString(o.text, "event.text"), ...(usage ? { usage } : {}) };
		}
		case "context.cleared":
			return { type };
		case "loop.verdict":
			return {
				type,
				level: expectOneOf(o.level, LOOP_LEVELS, "event.level"),
				fingerprint: expectString(o.fingerprint, "event.fingerprint"),
				...(o.reason === undefined ? {} : { reason: expectString(o.reason, "event.reason") }),
			};
		case "run.status":
			return {
				type,
				status: expectOneOf(o.status, RUN_STATUSES, "event.status"),
				...(o.reason === undefined ? {} : { reason: expectString(o.reason, "event.reason") }),
			};
		default: {
			const unreachable: never = type;
			throw new SchemaError(`event.type: unknown type ${String(unreachable)}`);
		}
	}
}

/** Validates one persisted event. Throws SchemaError with the offending path. */
export function parseSessionEvent(value: unknown): SessionEvent {
	const o = expectObject(value, "event");
	const type = expectOneOf(o.type, EVENT_TYPES, "event.type");
	return {
		...parseBody(o, type),
		seq: expectInteger(o.seq, "event.seq", 1),
		at: expectInteger(o.at, "event.at"),
		runId: expectString(o.runId, "event.runId"),
	};
}

export function parseLoopDetectorConfig(value: unknown): LoopDetectorConfig {
	const o = expectObject(value, "loopDetector");
	const config = {
		window: expectInteger(o.window, "loopDetector.window", 2),
		repeatThreshold: expectInteger(o.repeatThreshold, "loopDetector.repeatThreshold", 2),
		resultThreshold: expectInteger(o.resultThreshold, "loopDetector.resultThreshold", 2),
		alternationThreshold: expectInteger(o.alternationThreshold, "loopDetector.alternationThreshold", 2),
	};
	if (config.alternationThreshold * 2 > config.window) {
		throw new SchemaError("loopDetector.alternationThreshold: needs 2x this many calls within window");
	}
	return config;
}
