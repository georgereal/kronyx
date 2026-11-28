/**
 * Session event schema (vscode-free). Durable facts about a session — everything
 * else the harness knows is a projection of these. One schema for the UI,
 * persistence, replay and resume across every provider.
 */

import { expectBoolean, expectInteger, expectObject, expectOneOf, expectString, expectStringArray, SchemaError } from "./parse";
import { parseStep, parseTask, STEP_STATUSES, TASK_STATUSES } from "./tasks";
import type { Step, StepStatus, Task, TaskStatus } from "./tasks";
import type { LoopDetectorConfig } from "./ports";

export interface ToolCall {
	callId: string;
	name: string;
	input: unknown;
}

/** Provider output items of one response, replayed verbatim (reasoning, compaction) only to the model that produced them. */
export interface ProviderItems {
	providerId: string;
	modelId: string;
	items: unknown[];
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
	| { type: "model.response"; turn: number; text: string; toolCalls: ToolCall[]; usage?: Usage; reasoning?: string; providerItems?: ProviderItems }
	| { type: "tool.requested"; callId: string; name: string; input: unknown }
	| { type: "tool.finished"; callId: string; name: string; ok: boolean; output: string; usage?: Usage }
	| { type: "task.created"; task: Task; usage?: Usage }
	| { type: "task.updated"; id: string; to: TaskStatus; reason?: string }
	| { type: "task.removed"; id: string }
	| { type: "task.adopted"; id: string }
	| { type: "step.added"; taskId: string; step: Step }
	| { type: "step.updated"; taskId: string; stepId: string; to: StepStatus; callIds: string[]; reason?: string }
	| { type: "verifier.result"; taskId: string; ok: boolean; detail: string; command?: string }
	| { type: "stop.refused"; openTaskIds: string[] }
	| { type: "budget.warning"; kind: "input_tokens"; used: number; limit: number }
	| { type: "steer.note"; rule: string; text: string }
	| { type: "user.question"; questions: Array<{ question: string; options?: string[] }> }
	| { type: "context.recap"; covers: number; text: string; usage?: Usage }
	| { type: "context.cleared" }
	| { type: "loop.verdict"; level: LoopLevel; fingerprint: string; reason?: string }
	| { type: "run.status"; status: RunStatus; reason?: string }
	/** A server-side conversation was created for this session. Bound to one provider and model. */
	| { type: "conversation.bound"; conversationId: string; provider: string; model: string }
	/** A request is about to go to the conversation. Logged before the call, so a crash mid-request is detectable. */
	| { type: "conversation.sent"; throughSeq: number }
	/** The conversation holds every event up to `throughSeq`, including the response just logged. */
	| { type: "conversation.synced"; throughSeq: number; responseId?: string; boardHash?: string }
	/** The conversation is dropped; the next request binds a new one and replays the log. */
	| { type: "conversation.reset"; reason: string };

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
	"user.question",
	"context.recap",
	"context.cleared",
	"loop.verdict",
	"run.status",
	"conversation.bound",
	"conversation.sent",
	"conversation.synced",
	"conversation.reset",
];

function parseProviderItems(value: unknown, path: string): ProviderItems {
	const o = expectObject(value, path);
	if (!Array.isArray(o.items)) throw new SchemaError(`${path}.items: expected an array`);
	return { providerId: expectString(o.providerId, `${path}.providerId`), modelId: expectString(o.modelId, `${path}.modelId`), items: o.items };
}

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
			const providerItems = o.providerItems === undefined ? undefined : parseProviderItems(o.providerItems, "event.providerItems");
			return {
				type,
				turn: expectInteger(o.turn, "event.turn", 1),
				text: expectString(o.text, "event.text", { allowEmpty: true }),
				toolCalls: o.toolCalls.map((c, i) => parseToolCall(c, `event.toolCalls[${i}]`)),
				...(usage ? { usage } : {}),
				...(reasoning ? { reasoning } : {}),
				...(providerItems ? { providerItems } : {}),
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
				...(o.reason === undefined ? {} : { reason: expectString(o.reason, "event.reason") }),
			};
		case "verifier.result":
			return {
				type,
				taskId: expectString(o.taskId, "event.taskId"),
				ok: expectBoolean(o.ok, "event.ok"),
				detail: expectString(o.detail, "event.detail", { allowEmpty: true }),
				...(o.command === undefined ? {} : { command: expectString(o.command, "event.command") }),
			};
		case "stop.refused":
			return { type, openTaskIds: expectStringArray(o.openTaskIds, "event.openTaskIds") };
		case "budget.warning":
			if (o.kind !== "input_tokens") throw new SchemaError("event.kind: expected input_tokens");
			return { type, kind: "input_tokens", used: expectInteger(o.used, "event.used"), limit: expectInteger(o.limit, "event.limit", 1) };
		case "steer.note":
			return { type, rule: expectString(o.rule, "event.rule"), text: expectString(o.text, "event.text") };
		case "user.question": {
			if (!Array.isArray(o.questions)) throw new SchemaError("event.questions: expected an array");
			const questions = o.questions.map((q: unknown, i: number) => {
				const item = expectObject(q, `event.questions[${i}]`);
				return {
					question: expectString(item.question, `event.questions[${i}].question`),
					...(item.options === undefined ? {} : { options: expectStringArray(item.options, `event.questions[${i}].options`) }),
				};
			});
			if (!questions.length) throw new SchemaError("event.questions: expected at least one question");
			return { type, questions };
		}
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
		case "conversation.bound":
			return {
				type,
				conversationId: expectString(o.conversationId, "event.conversationId"),
				provider: expectString(o.provider, "event.provider"),
				model: expectString(o.model, "event.model"),
			};
		case "conversation.sent":
			return { type, throughSeq: expectInteger(o.throughSeq, "event.throughSeq") };
		case "conversation.synced":
			return {
				type,
				throughSeq: expectInteger(o.throughSeq, "event.throughSeq", 1),
				...(o.responseId === undefined ? {} : { responseId: expectString(o.responseId, "event.responseId") }),
				...(o.boardHash === undefined ? {} : { boardHash: expectString(o.boardHash, "event.boardHash") }),
			};
		case "conversation.reset":
			return { type, reason: expectString(o.reason, "event.reason") };
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
