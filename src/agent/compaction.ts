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
	const text = resultText(part);
	if (text.length <= MAX_RESULT_CHARS) return undefined;
	const elided = text.length - HEAD_CHARS - TAIL_CHARS;
	const trimmed = `${text.slice(0, HEAD_CHARS)}\n…[${elided} chars elided]…\n${text.slice(-TAIL_CHARS)}`;
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

		// toolCallId → supersession key (same tool+target, else exact input).
		const callKeys = new Map<string, string>();
		for (const m of messages) {
			for (const p of m.content) {
				if (p.type === "tool-call") callKeys.set(p.toolCallId, targetKey(p.toolName, p.input));
			}
		}

		// Stub candidates outside the keep-recent-results window.
		const resultPositions: { mi: number; pi: number }[] = [];
		messages.forEach((m, mi) =>
			m.content.forEach((p, pi) => {
				if (p.type === "tool-result") resultPositions.push({ mi, pi });
			}),
		);
		const candidates = resultPositions.slice(0, Math.max(0, resultPositions.length - KEEP_RECENT_RESULTS));
		const keyLastIndex = new Map<string, number>();
		candidates.forEach((c, i) => {
			const part = messages[c.mi].content[c.pi] as AgentToolResultPart;
			keyLastIndex.set(callKeys.get(part.toolCallId) ?? part.toolName, i);
		});
		const rank = (c: { mi: number; pi: number }, i: number): number => {
			const part = messages[c.mi].content[c.pi] as AgentToolResultPart;
			if (part.isError) return 0;
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
		// Reasoning is kept on tool-call turns (some providers require the
		// thinking block that preceded a tool call) and on the last turn.
		let reasoningPruned = 0;
		let attachmentsStubbed = 0;
		mutable.forEach((m, mi) => {
			if (mi >= recentFloor) return;
			m.content = m.content.filter((p) => {
				if (p.type === "reasoning" && !m.content.some((q) => q.type === "tool-call")) {
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
