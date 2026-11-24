import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

export const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"out",
	"build",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".turbo",
	"coverage",
	".devhost",
]);

export class WorkspaceGuard {
	readonly root: string;

	constructor(root: string) {
		this.root = realpathSync(path.resolve(root));
	}

	resolve(input: string): string {
		if (!input || typeof input !== "string") {
			throw new Error("A file path is required.");
		}
		const abs = path.resolve(this.root, input);
		this.assertInside(abs, input);
		this.assertInside(realpathSync(nearestExistingAncestor(abs)), input);
		return abs;
	}

	relative(abs: string): string {
		return path.relative(this.root, abs).split(path.sep).join("/") || ".";
	}

	private assertInside(abs: string, input: string): void {
		const rel = path.relative(this.root, abs);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`Path is outside the workspace: ${input}`);
		}
	}
}

function nearestExistingAncestor(abs: string): string {
	let current = abs;
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return current;
}

/**
 * Files that plausibly hold credentials. Reads return a metadata stub — key
 * names and shape only — so secret values never enter the model's context.
 * The file itself is untouched and stays available to local consumers.
 */
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx|keystore|jks)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*service[-_]?account[^/]*\.json|credentials\.json|client_secret[^/]*\.json|\.(?:npmrc|netrc|pypirc)|[^/]*secrets?[^/]*\.(?:json|ya?ml|toml|env))$/i;

/** Gitignored paths under a root: `dirs` (collapsed, trailing "/") and individual `files`. */
export interface IgnoreIndex {
	dirs: Set<string>;
	files: Set<string>;
}

/** Parse `git ls-files -o -i --exclude-standard --directory -z` output. */
export function parseIgnoreList(out: string): IgnoreIndex {
	const index: IgnoreIndex = { dirs: new Set(), files: new Set() };
	for (const entry of out.split("\0")) {
		if (!entry) continue;
		(entry.endsWith("/") ? index.dirs : index.files).add(entry.replace(/^\.\//, ""));
	}
	return index;
}

export const isIgnored = (index: IgnoreIndex, rel: string): boolean => {
	if (index.files.has(rel)) return true;
	const parts = rel.split("/");
	return parts.some((_, i) => index.dirs.has(`${parts.slice(0, i + 1).join("/")}/`));
};

/** Memoized loader: git runs at most once per TTL, and a failed listing (no git, not a repo) is an empty index. */
export function ignoreIndexLoader(load: () => Promise<string>, ttlMs = 30_000): () => Promise<IgnoreIndex> {
	let cached: { at: number; index: IgnoreIndex } | undefined;
	return async () => {
		if (cached && Date.now() - cached.at < ttlMs) return cached.index;
		const index = parseIgnoreList(await load().catch(() => ""));
		cached = { at: Date.now(), index };
		return index;
	};
}

const localIgnoreLoaders = new Map<string, () => Promise<IgnoreIndex>>();

/** Gitignore index for a local workspace root (per-root cache). */
export function localIgnoreIndex(root: string): () => Promise<IgnoreIndex> {
	let loader = localIgnoreLoaders.get(root);
	if (!loader) {
		loader = ignoreIndexLoader(
			() =>
				new Promise<string>((resolve, reject) =>
					execFile("git", ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], { maxBuffer: 32 << 20, timeout: 10_000 }, (err, stdout) =>
						err ? reject(err) : resolve(stdout),
					),
				),
		);
		localIgnoreLoaders.set(root, loader);
	}
	return loader;
}

/**
 * Credential-named, or gitignored. Vendored/build output (node_modules, dist…)
 * and the harness-owned .kronyx/ folder are never treated as sensitive — they
 * hold code and attachments, not secrets.
 */
export function isSensitivePath(rel: string, index?: IgnoreIndex): boolean {
	if (SECRET_FILE.test(rel)) return true;
	if (!index || rel.startsWith(".kronyx/") || rel.split("/").some((p) => IGNORED_DIRS.has(p))) return false;
	return isIgnored(index, rel);
}

/** Metadata-only stand-in for a secret file's content, or undefined when the path doesn't look secret. */
export function secretFileStub(rel: string, text: string, index?: IgnoreIndex): string | undefined {
	if (!isSensitivePath(rel, index)) return undefined;
	const lineCount = text.trim() ? text.trim().split("\n").length : 0;
	// Surface the shape the model may legitimately need: env-var names or JSON keys, never values.
	const envKeys = [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/gm)].map((m) => m[1]);
	let jsonKeys: string[] = [];
	if (!envKeys.length) {
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object") jsonKeys = Object.keys(parsed);
		} catch {
			/* not json — fine */
		}
	}
	const keys = envKeys.length ? envKeys : jsonKeys;
	const keyList = keys.length ? ` Keys present: ${keys.slice(0, 40).join(", ")}${keys.length > 40 ? ", …" : ""}.` : "";
	const why = SECRET_FILE.test(rel) ? "looks like a credentials/secret file" : "is gitignored, so it is treated as sensitive";
	return `${rel} (${lineCount} lines) ${why} — contents withheld so values never leave the workspace.${keyList} If you only need to reference it, use the file path; if a value is truly required, ask the user.`;
}
