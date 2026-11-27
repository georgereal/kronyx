/**
 * Read-result cache on the harness path (vscode-free). Read tools are
 * deterministic: an identical call returns an identical result, so a repeat is
 * pure token waste. The cache keys each read call by a stable signature and
 * returns the stored output on a hit — marked so the model knows nothing
 * changed. Any mutating call clears the cache (the filesystem may differ).
 *
 * list_files ignores max_entries in its key: it cannot change a flat listing,
 * and models retry with bigger limits after reading the root.
 */

import { callFingerprint } from "../core/canonical";
import type { ToolPort, ToolResult } from "../core/contracts";

/** Tools whose results may be reused across calls with the same signature. */
export const CACHEABLE_READS: ReadonlySet<string> = new Set([
	"read_file",
	"read_files",
	"list_files",
	"search_files",
	"get_diagnostics",
	"search_symbols",
	"get_file_structure",
	"get_symbol_context",
	"get_call_hierarchy",
	"get_selection_context",
	"list_plans",
	"read_plan",
]);

/** Internal tools (log_slice, recall_context, task_*) neither cached nor invalidating. */
const PASSTHROUGH = /^(log_slice|recall_context|task_|update_progress|finish|explore_codebase|use_tool)$/;

const keyFor = (name: string, input: unknown): string | undefined => {
	if (name === "list_files") {
		const i = (input ?? {}) as { path?: unknown; recursive?: unknown };
		return `list_files:${typeof i.path === "string" && i.path ? i.path : "."}|${i.recursive === true}`;
	}
	return CACHEABLE_READS.has(name) ? callFingerprint(name, input) : undefined;
};

export function withReadCache(base: ToolPort): ToolPort {
	const cache = new Map<string, string>();
	return {
		specs: () => base.specs(),
		async execute(name, input, callId): Promise<ToolResult> {
			const key = keyFor(name, input);
			if (key === undefined) {
				// Mutating and pass-through calls run fresh; mutations invalidate everything.
				const result = await base.execute(name, input, callId);
				if (result.ok && !PASSTHROUGH.test(name)) cache.clear();
				return result;
			}
			const hit = cache.get(key);
			if (hit !== undefined) return { ok: true, output: `${hit}\n\n(cached — identical call already returned this result; nothing changed)` };
			const result = await base.execute(name, input, callId);
			if (result.ok) cache.set(key, result.output);
			return result;
		},
	};
}
