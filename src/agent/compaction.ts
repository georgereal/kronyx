import type {
	AgentMessage,
	AgentRuntimePrepareTurnContext,
	AgentRuntimePrepareTurnResult,
	AgentToolResultPart,
} from "@cline/shared";
import { countTokens } from "./tokenize";

const SOFT_TRIGGER_FRACTION = 0.4;
const TRIGGER_FRACTION = 0.7;
const TARGET_FRACTION = 0.55;
const KEEP_RECENT_RESULTS = 6;
const KEEP_RECENT_MESSAGES = 8;
const MAX_RESULT_CHARS = 12_000;
const HEAD_CHARS = 6_000;
const TAIL_CHARS = 2_000;
const CALL_INPUT_CAP = 600;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const PATH_KEYS = ["path", "file", "filePath", "rel"];
const ATTACH_RE = /^--- attached file: (.+?) ---\n[\s\S]*?--- end \1 ---$/;

/** Tools whose successful call mutates a path — later writes supersede every
 *  earlier result on that path (stale reads AND earlier write results). */
const PATH_WRITE_TOOLS = new Set(["write_file", "edit_file", "append_file", "insert_lines"]);
const FILE_EDITOR_WRITE_COMMANDS = new Set(["create", "str_replace", "insert", "undo_edit", "replace_function"]);

const isPathWrite = (toolName: string, input: unknown): boolean => {
	if (PATH_WRITE_TOOLS.has(toolName)) return true;
	if (toolName !== "file_editor") return false;
	const cmd = (input as { command?: string } | undefined)?.command;
	return !!cmd && FILE_EDITOR_WRITE_COMMANDS.has(cmd);
};

/** Per-tool clamp policy — one size fits badly. run_command keeps the tail
 *  (errors/build output land at the end); search/list results cap small. */
const CLAMPS: Record<string, { max: number; head: number; tail: number }> = {
	run_command: { max: 9_000, head: 1_500, tail: 6_000 },
	search_files: { max: 4_000, head: 3_000, tail: 800 },
	list_files: { max: 4_000, head: 3_000, tail: 800 },
};
const DEFAULT_CLAMP = { max: MAX_RESULT_CHARS, head: HEAD_CHARS, tail: TAIL_CHARS };

/** Provider-specific tuning. Anthropic requires the thinking block that
 *  precedes a tool call to stay in the transcript; other providers never
 *  receive reasoning back, so pruning it unconditionally is free savings. */
const isAnthropicProvider = (providerId?: string, modelId?: string): boolean =>
	/anthropic|claude/i.test(`${providerId ?? ""} ${modelId ?? ""}`);

export interface CompactStats {
	stubbed: number;
	clamped: number;
	reasoningPruned: number;
	attachmentsStubbed: number;
	callsElided: number;
	superseded: number;
	summarized: boolean;
	estTokensBefore: number;
	estTokensAfter: number;
	forced: boolean;
	soft: boolean;
}

export interface PrepareTurnOptions {
	/** Fallback context window when the runtime's model info lacks one. */
	contextWindow?: number;
	/** Provider/model identity — tunes provider-specific projections (reasoning retention). */
	providerId?: string;
	modelId?: string;
	/**
	 * Optional LLM recap: called with the oldest messages when stubbing alone
	 * can't reach the target. Returns the summary text, or undefined to skip.
	 */
	summarize?: (messages: readonly AgentMessage[]) => Promise<string | undefined>;
	onCompact?: (stats: CompactStats) => void;
}

const stubText = (part: AgentToolResultPart) =>
	`[output elided by context compaction — call recall_context with toolCallId "${part.toolCallId}" to retrieve]`;

const resultText = (part: AgentToolResultPart): string =>
	typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");

function estimateTokens(messages: readonly AgentMessage[], systemPrompt?: string, tools?: unknown): number {
	let tokens = countTokens(systemPrompt ?? "") + (tools ? countTokens(JSON.stringify(tools)) : 0);
	for (const m of messages) tokens += countTokens(JSON.stringify(m.content));
	return tokens;
}

/** Head+tail clamp for a single oversized tool-result part. Returns the new part or undefined. */
function clampResult(part: AgentToolResultPart): AgentToolResultPart | undefined {
	const clamp = CLAMPS[part.toolName] ?? DEFAULT_CLAMP;
	const text = resultText(part);
	if (text.length <= clamp.max) return undefined;
	const elided = text.length - clamp.head - clamp.tail;
	const trimmed = `${text.slice(0, clamp.head)}\n…[${elided} chars elided]…\n${text.slice(-clamp.tail)}`;
	return { ...part, output: trimmed };
}

/**
 * Project a stale tool-call input down to a pointer: keep the target (path or
 * command head) so the model knows what the call did, drop the payload —
 * write_file/edit_file args carry whole file contents re-sent every turn.
 */
function elideCallInput(input: unknown): unknown {
	const rec = (input ?? {}) as Record<string, unknown>;
	const keep: Record<string, unknown> = { _argsElided: "full args retrievable via recall_context toolCallId" };
	for (const k of PATH_KEYS) {
		if (typeof rec[k] === "string" && rec[k]) keep[k] = rec[k];
	}
	if (typeof rec.command === "string") keep.command = rec.command.slice(0, 80);
	return keep;
}

/** Supersession key for a tool call: same tool on the same target path, else exact input. */
function targetKey(toolName: string, input: unknown): string {
	const rec = (input ?? {}) as Record<string, unknown>;
	for (const k of PATH_KEYS) {
		if (typeof rec[k] === "string" && rec[k]) return `${toolName}:${k}=${rec[k]}`;
	}
	return `${toolName}:${JSON.stringify(input ?? {})}`;
}

/** Tool-agnostic path identity — lets a write supersede reads from any tool. */
function pathKeyOf(input: unknown): string | undefined {
	const rec = (input ?? {}) as Record<string, unknown>;
	for (const k of PATH_KEYS) {
		if (typeof rec[k] === "string" && rec[k]) return rec[k];
	}
	return undefined;
}

/**
 * Host-side `prepareTurn` for AgentRuntime. Two tiers, projection-only:
 * - always: clamp individual oversized tool outputs (head+tail kept);
 * - soft tier (~40% of window): stub only failed and superseded tool results
 *   beyond the keep-recent window — near-pure noise;
 * - hard tier (~70% or provider-rejected overflow): also stub remaining results
 *   oldest-first until ~55%.
 * The canonical transcript is untouched; stubs point the model at recall_context.
 */
export function createPrepareTurn(opts: PrepareTurnOptions = {}) {
	return async (ctx: AgentRuntimePrepareTurnContext): Promise<AgentRuntimePrepareTurnResult | undefined> => {
		const window = ctx.model.info?.contextWindow ?? opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

		// Pass 1 (always): clamp individual oversized tool outputs.
		let clamped = 0;
		const messages = ctx.messages.map((m) => {
			if (!m.content.some((p) => p.type === "tool-result")) return m;
			let changed = false;
			const content = m.content.map((p) => {
				if (p.type !== "tool-result") return p;
				const clampedPart = clampResult(p);
				if (!clampedPart) return p;
				changed = true;
				clamped++;
				return clampedPart;
			});
			return changed ? { ...m, content } : m;
		});

		const estBefore = Math.max(estimateTokens(messages, ctx.systemPrompt, ctx.tools), ctx.previousRequestInputTokens ?? 0);
		const mutable = messages.map((m) => ({ ...m, content: [...m.content] }));
		const recentFloor = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);

		// toolCallId → supersession key (same tool+target, else exact input) and
		// → path key (cross-tool: a read is stale once the file is rewritten).
		const callKeys = new Map<string, string>();
		const callPathKeys = new Map<string, string>();
		const writeCalls: { pathKey: string; toolCallId: string }[] = [];
		for (const m of messages) {
			for (const p of m.content) {
				if (p.type !== "tool-call") continue;
				callKeys.set(p.toolCallId, targetKey(p.toolName, p.input));
				const pathKey = pathKeyOf(p.input);
				if (pathKey) {
					callPathKeys.set(p.toolCallId, pathKey);
					if (isPathWrite(p.toolName, p.input)) writeCalls.push({ pathKey, toolCallId: p.toolCallId });
				}
			}
		}

		// Stub candidates outside the keep-recent-results window.
		const resultPositions: { mi: number; pi: number }[] = [];
		messages.forEach((m, mi) =>
			m.content.forEach((p, pi) => {
				if (p.type === "tool-result") resultPositions.push({ mi, pi });
			}),
		);
		const resultIndexByCallId = new Map<string, number>();
		resultPositions.forEach((c, i) => {
			const part = messages[c.mi].content[c.pi] as AgentToolResultPart;
			resultIndexByCallId.set(part.toolCallId, i);
		});
		// path → result index of its latest SUCCESSFUL write. Failed or
		// interrupted writes don't supersede — their old reads are still true.
		const lastWriteResultIdx = new Map<string, number>();
		for (const w of writeCalls) {
			const ri = resultIndexByCallId.get(w.toolCallId);
			if (ri === undefined) continue;
			const res = messages[resultPositions[ri].mi].content[resultPositions[ri].pi] as AgentToolResultPart;
			if (res.isError) continue;
			lastWriteResultIdx.set(w.pathKey, ri);
		}
		const candidates = resultPositions.slice(0, Math.max(0, resultPositions.length - KEEP_RECENT_RESULTS));
		const keyLastIndex = new Map<string, number>();
		candidates.forEach((c, i) => {
			const part = messages[c.mi].content[c.pi] as AgentToolResultPart;
			keyLastIndex.set(callKeys.get(part.toolCallId) ?? part.toolName, i);
		});
		const rank = (c: { mi: number; pi: number }, i: number): number => {
			const part = messages[c.mi].content[c.pi] as AgentToolResultPart;
			if (part.isError) return 0;
			const writeIdx = lastWriteResultIdx.get(callPathKeys.get(part.toolCallId) ?? "");
			if (writeIdx !== undefined && writeIdx > i) return 1; // superseded by a later write on this path
			if (keyLastIndex.get(callKeys.get(part.toolCallId) ?? part.toolName) !== i) return 1;
			return 2;
		};

		// Always-on projections — dead weight at any transcript size, recoverable
		// via recall_context: stale tool-call inputs (write_file/edit_file carry
		// whole files) and superseded or failed results.
		let callsElided = 0;
		let superseded = 0;
		let saved = 0;
		messages.forEach((m, mi) => {
			m.content.forEach((p, pi) => {
				if (p.type === "tool-call" && mi < recentFloor && JSON.stringify(p.input).length > CALL_INPUT_CAP) {
					const elided = elideCallInput(p.input);
					saved += Math.max(0, countTokens(JSON.stringify(p.input)) - countTokens(JSON.stringify(elided)));
					mutable[mi].content[pi] = { ...p, input: elided };
					callsElided++;
				}
			});
		});
		candidates.forEach((c, i) => {
			const part = mutable[c.mi].content[c.pi] as AgentToolResultPart;
			const r = rank(c, i);
			if (r !== 1 && !(r === 0 && resultText(part).length > 1000)) return;
			const stub = stubText(part);
			if (typeof part.output === "string" && part.output === stub) return;
			saved += Math.max(0, countTokens(resultText(part)) - countTokens(stub));
			mutable[c.mi].content[c.pi] = { ...part, output: stub };
			superseded++;
		});

		const estNow = Math.max(estBefore - saved, 0);
		const forced = ctx.overflowRecovery === true;
		const soft = !forced && estNow >= window * SOFT_TRIGGER_FRACTION && estNow < window * TRIGGER_FRACTION;
		if (!forced && estNow < window * SOFT_TRIGGER_FRACTION) {
			return clamped || superseded || callsElided ? { messages: mutable } : undefined;
		}

		// Prune reasoning + inlined attachments outside the recent window.
		// Anthropic requires the thinking block that preceded a tool call to
		// remain; other providers never receive reasoning back, so it can go.
		const keepReasoningOnCalls = isAnthropicProvider(opts.providerId, opts.modelId);
		let reasoningPruned = 0;
		let attachmentsStubbed = 0;
		mutable.forEach((m, mi) => {
			if (mi >= recentFloor) return;
			m.content = m.content.filter((p) => {
				if (p.type === "reasoning" && !(keepReasoningOnCalls && m.content.some((q) => q.type === "tool-call"))) {
					reasoningPruned++;
					return false;
				}
				return true;
			}).map((p) => {
				if (p.type !== "text") return p;
				const match = ATTACH_RE.exec(p.text.trim());
				if (!match) return p;
				attachmentsStubbed++;
				return {
					...p,
					text: `[attachment "${match[1]}" elided by context compaction — contents at .kronyx/attachments/${match[1]} or via recall_context]`,
				};
			});
		});

		const ordered = candidates
			.map((c, i) => ({ ...c, i, r: rank(c, i) }))
			.sort((a, b) => a.r - b.r || a.i - b.i);

		let stubbed = 0;
		let est = Math.max(estimateTokens(mutable, ctx.systemPrompt, ctx.tools), 0);
		const target = window * TARGET_FRACTION;
		for (const c of ordered) {
			if (soft) {
				if (c.r === 2) break; // soft tier: errors + superseded only
			} else if (est <= target) break;
			const part = mutable[c.mi].content[c.pi] as AgentToolResultPart;
			const stub = stubText(part);
			if (typeof part.output === "string" && part.output === stub) continue;
			est -= Math.max(0, countTokens(resultText(part)) - countTokens(stub));
			mutable[c.mi].content[c.pi] = { ...part, output: stub };
			stubbed++;
		}

		// Last resort (hard tier only): an LLM recap replaces the oldest turns
		// when stubbing alone can't reach the target.
		let summarized = false;
		if (!soft && opts.summarize && est > target && mutable.length > KEEP_RECENT_MESSAGES) {
			const prefix = mutable.slice(0, mutable.length - KEEP_RECENT_MESSAGES);
			const summary = await opts.summarize(prefix).catch(() => undefined);
			if (summary) {
				mutable.splice(0, prefix.length, {
					id: `compact-${Date.now()}`,
					role: "user",
					content: [
						{
							type: "text",
							text: `[Earlier turns in this task were summarized by context compaction — details retrievable with recall_context]\n\n${summary}`,
						},
					],
					createdAt: Date.now(),
				});
				summarized = true;
				est = estimateTokens(mutable, ctx.systemPrompt, ctx.tools);
			}
		}

		if (!stubbed && !clamped && !reasoningPruned && !attachmentsStubbed && !callsElided && !superseded && !summarized)
			return undefined;
		const stats: CompactStats = {
			stubbed,
			clamped,
			reasoningPruned,
			attachmentsStubbed,
			callsElided,
			superseded,
			summarized,
			estTokensBefore: estBefore,
			estTokensAfter: est,
			forced,
			soft,
		};
		opts.onCompact?.(stats);
		ctx.emitStatusNotice?.(
			`context compacted: ${stubbed ? `stubbed ${stubbed} tool result(s), ` : ""}` +
				`${superseded ? `elided ${superseded} stale result(s), ` : ""}` +
				`${callsElided ? `elided ${callsElided} tool-call input(s), ` : ""}` +
				`${clamped ? `clamped ${clamped} large output(s), ` : ""}` +
				`${reasoningPruned ? `pruned ${reasoningPruned} reasoning part(s), ` : ""}` +
				`${attachmentsStubbed ? `stubbed ${attachmentsStubbed} attachment(s), ` : ""}` +
				`${summarized ? "summarized oldest turns, " : ""}` +
				`(~${Math.round(estBefore / 1000)}k → ~${Math.round(est / 1000)}k est. tokens)`,
			{
				kind: "context_compaction",
				stubbed,
				clamped,
				reasoningPruned,
				attachmentsStubbed,
				callsElided,
				superseded,
				summarized,
				forced,
				soft,
				estTokensBefore: estBefore,
				estTokensAfter: est,
			},
		);
		return { messages: mutable };
	};
}
