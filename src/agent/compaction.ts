import type {
	AgentMessage,
	AgentRuntimePrepareTurnContext,
	AgentRuntimePrepareTurnResult,
	AgentToolResultPart,
} from "@cline/shared";

const SOFT_TRIGGER_FRACTION = 0.4;
const TRIGGER_FRACTION = 0.7;
const TARGET_FRACTION = 0.55;
const KEEP_RECENT_RESULTS = 6;
const MAX_RESULT_CHARS = 12_000;
const HEAD_CHARS = 6_000;
const TAIL_CHARS = 2_000;
const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const PATH_KEYS = ["path", "file", "filePath", "rel"];

export interface CompactStats {
	stubbed: number;
	clamped: number;
	estTokensBefore: number;
	estTokensAfter: number;
	forced: boolean;
	soft: boolean;
}

export interface PrepareTurnOptions {
	/** Fallback context window when the runtime's model info lacks one. */
	contextWindow?: number;
	onCompact?: (stats: CompactStats) => void;
}

const stubText = (part: AgentToolResultPart) =>
	`[output elided by context compaction — call recall_context with toolCallId "${part.toolCallId}" to retrieve]`;

const resultText = (part: AgentToolResultPart): string =>
	typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? "");

function estimateTokens(messages: readonly AgentMessage[], systemPrompt?: string, tools?: unknown): number {
	let chars = (systemPrompt?.length ?? 0) + (tools ? JSON.stringify(tools).length : 0);
	for (const m of messages) chars += JSON.stringify(m.content).length;
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Head+tail clamp for a single oversized tool-result part. Returns the new part or undefined. */
function clampResult(part: AgentToolResultPart): AgentToolResultPart | undefined {
	const text = resultText(part);
	if (text.length <= MAX_RESULT_CHARS) return undefined;
	const elided = text.length - HEAD_CHARS - TAIL_CHARS;
	const trimmed = `${text.slice(0, HEAD_CHARS)}\n…[${elided} chars elided]…\n${text.slice(-TAIL_CHARS)}`;
	return { ...part, output: trimmed };
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
	return (ctx: AgentRuntimePrepareTurnContext): AgentRuntimePrepareTurnResult | undefined => {
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
		const forced = ctx.overflowRecovery === true;
		const soft = !forced && estBefore >= window * SOFT_TRIGGER_FRACTION && estBefore < window * TRIGGER_FRACTION;
		if (!forced && estBefore < window * SOFT_TRIGGER_FRACTION) {
			return clamped ? { messages } : undefined;
		}

		// toolCallId → supersession key (same tool+target, else exact input).
		const callKeys = new Map<string, string>();
		for (const m of messages) {
			for (const p of m.content) {
				if (p.type === "tool-call") callKeys.set(p.toolCallId, targetKey(p.toolName, p.input));
			}
		}

		// Collect stub candidates outside the keep-recent window.
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
		const ordered = candidates
			.map((c, i) => ({ ...c, i, r: rank(c, i) }))
			.sort((a, b) => a.r - b.r || a.i - b.i);

		let stubbed = 0;
		let est = estBefore;
		const target = window * TARGET_FRACTION;
		const mutable = messages.map((m) => ({ ...m, content: [...m.content] }));
		for (const c of ordered) {
			if (soft) {
				if (c.r === 2) break; // soft tier: errors + superseded only
			} else if (est <= target) break;
			const part = mutable[c.mi].content[c.pi] as AgentToolResultPart;
			const stub = stubText(part);
			if (typeof part.output === "string" && part.output === stub) continue;
			est -= Math.max(0, Math.ceil((resultText(part).length - stub.length) / CHARS_PER_TOKEN));
			mutable[c.mi].content[c.pi] = { ...part, output: stub };
			stubbed++;
		}

		if (!stubbed && !clamped) return undefined;
		const stats: CompactStats = { stubbed, clamped, estTokensBefore: estBefore, estTokensAfter: est, forced, soft };
		opts.onCompact?.(stats);
		ctx.emitStatusNotice?.(
			`context compacted: stubbed ${stats.stubbed} tool result(s)${clamped ? `, clamped ${clamped} large output(s)` : ""} (~${Math.round(estBefore / 1000)}k → ~${Math.round(est / 1000)}k est. tokens)`,
			{ kind: "context_compaction", stubbed, clamped, forced, soft },
		);
		return { messages: mutable };
	};
}
