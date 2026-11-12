import { globToRe } from "./permissions";

/**
 * Multi-agent decomposition: a planner pass splits one task into bounded
 * slices, each executed by its own agent in an isolated git worktree.
 */

export interface SliceSpec {
	index: number;
	title: string;
	task: string;
	/** Path globs (repo-relative) this slice may write to. Everything else is refused. */
	owns: string[];
	/** Planner hint that this slice needs a different sandbox image (phase 2). */
	env?: { template?: string; reason?: string } | null;
}

/**
 * Root-level shared manifests are coordinator-owned — slices must defer
 * dependency/tooling changes instead of editing these directly (the classic
 * merge-collision class path guards can't express per-module).
 */
export const SHARED_MANIFESTS = [
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"Cargo.toml",
	"Cargo.lock",
	"go.mod",
	"go.sum",
	"pyproject.toml",
	"requirements*.txt",
	"tsconfig.json",
];

export function isSharedManifest(rel: string): boolean {
	const norm = rel.replace(/^\.\//, "").replace(/^\//, "");
	// Only the repo-root copy is reserved — nested package.json files inside a
	// slice's owns set (e.g. packages/web/package.json) belong to the slice.
	if (norm.includes("/")) return false;
	return SHARED_MANIFESTS.some((p) => globToRe(p, true).test(norm));
}

/** True when `relPath` (repo-relative) matches any of the `owns` globs. */
export function ownsMatch(owns: string[], relPath: string): boolean {
	const norm = relPath.replace(/^\.\//, "").replace(/^\//, "");
	// Never let a boundary check bless a traversal — `**` must not match
	// paths that escape the worktree (`../repo/...`, `a/../../b`).
	if (norm.split("/").includes("..")) return false;
	return owns.some((g) => {
		const pat = g.replace(/^\.\//, "").replace(/^\//, "");
		// A bare directory prefix ("src/api") means "everything under it".
		const glob = pat.endsWith("**") || pat.includes("*") || pat.includes("?") ? pat : `${pat}/**`;
		return globToRe(glob, true).test(norm) || globToRe(pat, true).test(norm);
	});
}

export const DECOMPOSE_PROMPT = (task: string, treeSummary: string, maxSlices: number): string => `You are decomposing a coding task for parallel execution by ${maxSlices > 1 ? `up to ${maxSlices}` : "one"} independent agents working simultaneously in separate git worktrees of the same repository.

TASK: ${task.slice(0, 2000)}

REPOSITORY STRUCTURE (partial):
${treeSummary.slice(0, 6000)}

Rules:
- Split into 2-${maxSlices} slices ONLY if the work genuinely parallelizes (independent files/modules). If it doesn't, return a single slice.
- Each slice gets "owns": path globs it may write — disjoint sets. A slice may READ anything but may WRITE only its owns paths.
- These root files are coordinator-owned and must NOT appear in any slice's owns: ${SHARED_MANIFESTS.join(", ")}. If a slice needs dependency/manifest changes, say so in its task text — the coordinator applies them at merge.
- Nested manifests (e.g. packages/foo/package.json) CAN be owned by the slice owning that package.
- Set "env" only when a slice needs tooling the base VM lacks (e.g. a database service, GUI stack); leave null otherwise.
- Keep slice tasks self-contained: full instructions, file paths, expected behavior — the slice agent sees only its task, not this conversation.

Reply with JSON only, no prose:
{"slices":[{"index":1,"title":"short label","task":"full instructions","owns":["src/api/**"],"env":null}]}`;

/** Planner output after validation: runnable slices + work that couldn't be
 *  safely bounded (unbounded/missing owns, overflow past the cap). Dropped
 *  slices go to the post-merge coordinator instead of being lost. */
export interface ParsedSlices {
	slices: SliceSpec[];
	dropped: { title: string; task: string; reason: string }[];
}

/**
 * Parse the planner's JSON reply. Returns validated slices (index-renumbered,
 * owns normalized, shared manifests stripped) or null when unusable.
 */
export function parseSlices(raw: string, maxSlices: number): ParsedSlices | null {
	// Models wrap JSON in prose/fences — extract the first {...} block greedily.
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let doc: { slices?: unknown };
	try {
		doc = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!Array.isArray(doc.slices) || !doc.slices.length) return null;
	const out: SliceSpec[] = [];
	const dropped: ParsedSlices["dropped"] = [];
	for (const s of doc.slices) {
		const rec = (s ?? {}) as Record<string, unknown>;
		const title = String(rec.title ?? "").trim() || `Slice ${out.length + dropped.length + 1}`;
		const task = String(rec.task ?? "").trim();
		if (!task) {
			dropped.push({ title, task: "(empty task)", reason: "no task text" });
			continue;
		}
		const owns = (Array.isArray(rec.owns) ? rec.owns : [])
			.map((o) => String(o).replace(/^\.\//, "").replace(/^\//, "").replace(/\/+$/, ""))
			// `**`/`*` means "write anywhere" — an unbounded slice overlaps every
			// sibling and can escape via `../`, so it's dropped like a manifest.
			.filter((o) => o && o !== "**" && o !== "*" && !SHARED_MANIFESTS.some((m) => globToRe(m, true).test(o)) && !isSharedManifest(o));
		const env = rec.env && typeof rec.env === "object" ? (rec.env as SliceSpec["env"]) : null;
		if (!owns.length) {
			// No usable owns → can't safely bound a worktree. Deferred to the
			// coordinator (owns **) rather than widening the boundary.
			dropped.push({ title, task, reason: "no bounded owns" });
			continue;
		}
		out.push({ index: out.length + 1, title, task, owns, env });
	}
	// Overflow past the cap: deferred to the coordinator as well — its work is
	// planned, just not parallelizable within MAX_SLICES.
	while (out.length > maxSlices) {
		const s = out.pop()!;
		dropped.push({ title: s.title, task: s.task, reason: "over slice cap" });
	}
	return out.length ? { slices: out, dropped } : null;
}
