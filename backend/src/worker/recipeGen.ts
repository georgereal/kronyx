import { swallow } from "../lib/log";

export const REPO_DIR = "/home/user/repo";

/** Manifest basenames the scanner recognizes. */
export const MANIFEST_FILES = [
	"package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".nvmrc",
	"requirements.txt", "pyproject.toml", "Pipfile", ".python-version",
	"go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts",
	"Dockerfile", "docker-compose.yml", "README.md",
];
const MANIFEST_SET = new Set(MANIFEST_FILES);

export interface StackPart {
	stack: string;
	tools: string[];
	commands: string[];
	verify?: string;
	/** Toolchain major version + whether it came from a manifest (vs default). */
	ver?: { major: number; explicit: boolean };
}

export interface ProjectScan {
	/** "" for repo root, else the subdir path. */
	dir: string;
	stacks: string[];
	tools: string[];
	found: string[];
	needsCustom?: boolean;
	deps?: { prod: { name: string; version: string }[]; dev: { name: string; version: string }[] };
	scripts?: Record<string, string>;
	parts: StackPart[];
}

export interface GeneratedRecipe {
	name: string;
	commands: string;
	verify?: string;
	tools: string[];
	description: string;
	needsCustom?: boolean;
}

const cd = (dir: string) => `cd ${REPO_DIR}${dir ? `/${dir}` : ""}`;

/**
 * Per-stack emitters. `has(f)` tells whether manifest f exists in the dir —
 * detected mode passes a real lookup, catalog mode passes () => true and the
 * install steps degrade to existence-checked conditionals.
 */
const EMITTERS: Record<string, (has: (f: string) => boolean, m: Record<string, string>, dir: string, v?: Record<string, string>) => StackPart | null> = {
	node: (has, m, dir, v) => {
		if (!has("package.json") && !v?.node) return null;
		let engines: string | undefined;
		try { engines = (JSON.parse(m["package.json"] ?? "{}") as { engines?: { node?: string } }).engines?.node; } catch { /* malformed */ }
		const nvmrc = m[".nvmrc"]?.trim().replace(/^v/, "").match(/^\d+/)?.[0];
		const engine = engines?.match(/\d+/)?.[0];
		const nodeVer = v?.node ?? nvmrc ?? engine ?? "22";
		const install = has("pnpm-lock.yaml")
			? `npm i -g pnpm >/dev/null && ${cd(dir)} && pnpm install --frozen-lockfile`
			: has("yarn.lock")
				? `${cd(dir)} && yarn install --frozen-lockfile`
				: has("package-lock.json")
					? `${cd(dir)} && npm ci --no-audit --no-fund`
					: `${cd(dir)} && if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; elif [ -f pnpm-lock.yaml ]; then npm i -g pnpm >/dev/null && pnpm install --frozen-lockfile; elif [ -f package.json ]; then npm install --no-audit --no-fund; fi`;
		return {
			stack: "node",
			tools: [`Node ${nodeVer}.x`, has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm"],
			commands: [
				`curl -fsSL https://deb.nodesource.com/setup_${nodeVer}.x | sudo -E bash - >/dev/null`,
				"sudo apt-get install -y --no-install-recommends nodejs >/dev/null",
				install,
			],
			verify: "node -v && npm -v",
			ver: { major: Number(nodeVer), explicit: !!(nvmrc || engine) },
		};
	},
	python: (has, _m, dir) => {
		if (!has("requirements.txt") && !has("pyproject.toml") && !has("Pipfile")) return null;
		const install = has("requirements.txt")
			? `${cd(dir)} && pip3 install --break-system-packages -r requirements.txt`
			: has("pyproject.toml")
				? `${cd(dir)} && pip3 install --break-system-packages .`
				: `pip3 install --break-system-packages pipenv && ${cd(dir)} && pipenv install --system`;
		return {
			stack: "python",
			tools: ["Python 3", "pip"],
			commands: ["sudo apt-get install -y --no-install-recommends python3 python3-pip python3-venv >/dev/null", install],
			verify: "python3 --version",
		};
	},
	go: (has, m, dir, v) => {
		if (!has("go.mod") && !v?.go) return null;
		const goVer = v?.go ?? m["go.mod"]?.match(/^go (\d+\.\d+)/m)?.[1] ?? "1.22";
		return {
			stack: "go",
			tools: [`Go ${goVer}`],
			commands: [
				`curl -fsSL https://go.dev/dl/go${goVer}.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz`,
				"sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go",
				`${cd(dir)} && go mod download`,
			],
			verify: "go version",
			ver: { major: Number(goVer.replace(".", "")), explicit: true },
		};
	},
	rust: (has, _m, dir) => {
		if (!has("Cargo.toml")) return null;
		return {
			stack: "rust",
			tools: ["Rust"],
			commands: [
				"curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable >/dev/null",
				`export PATH=$HOME/.cargo/bin:$PATH && ${cd(dir)} && cargo fetch`,
			],
			verify: "$HOME/.cargo/bin/cargo --version",
		};
	},
	ruby: (has, _m, dir) => {
		if (!has("Gemfile")) return null;
		return {
			stack: "ruby",
			tools: ["Ruby", "Bundler"],
			commands: [
				"sudo apt-get install -y --no-install-recommends ruby-full build-essential >/dev/null",
				`gem install bundler && ${cd(dir)} && bundle install`,
			],
			verify: "ruby -v && bundle -v",
		};
	},
	java: (has, _m, dir) => {
		if (!has("pom.xml") && !has("build.gradle") && !has("build.gradle.kts")) return null;
		const maven = has("pom.xml");
		return {
			stack: "java",
			tools: ["JDK", maven ? "Maven" : "Gradle"],
			commands: [
				`sudo apt-get install -y --no-install-recommends default-jdk ${maven ? "maven" : "gradle"} >/dev/null`,
				maven ? `${cd(dir)} && mvn -q -DskipTests dependency:resolve` : `${cd(dir)} && gradle --no-daemon dependencies >/dev/null`,
			],
			verify: "java -version",
		};
	},
};

/** Public stack catalog for the pick-a-stack mode (no repo needed). */
export const STACK_CATALOG = Object.keys(EMITTERS).map((key) => ({
	key,
	label: { node: "Node.js", python: "Python", go: "Go", rust: "Rust", ruby: "Ruby", java: "Java" }[key] ?? key,
	expects: {
		node: ["package.json", "package-lock.json | yarn.lock | pnpm-lock.yaml"],
		python: ["requirements.txt | pyproject.toml", "Pipfile (pipenv)"],
		go: ["go.mod", "go.sum"],
		rust: ["Cargo.toml", "Cargo.lock"],
		ruby: ["Gemfile", "Gemfile.lock"],
		java: ["pom.xml | build.gradle"],
	}[key] as string[],
}));

/** Generic catalog recipe part — every manifest treated as present. */
export function catalogPart(stack: string, versions?: Record<string, string>): StackPart | null {
	const emit = EMITTERS[stack];
	return emit ? emit(() => true, {}, "", versions) : null;
}

/** Merge stack parts into one recipe script: apt update once, one toolchain
 *  install per stack (explicit version beats the default, higher major wins),
 *  dep installs kept per project dir. */
export function mergeParts(parts: StackPart[]): { commands: string; verify: string; tools: string[] } {
	// Collapse same-stack parts: the winning part contributes toolchain +
	// install; losers contribute only their repo-dir install steps.
	const byStack = new Map<string, StackPart[]>();
	for (const p of parts) (byStack.get(p.stack) ?? byStack.set(p.stack, []).get(p.stack)!).push(p);
	const kept: string[] = [];
	const verify: string[] = [];
	const tools: string[] = [];
	for (const group of byStack.values()) {
		const ranked = [...group].sort((a, b) => Number(b.ver?.explicit ?? false) - Number(a.ver?.explicit ?? false) || (b.ver?.major ?? 0) - (a.ver?.major ?? 0));
		const [winner, ...losers] = ranked;
		kept.push(...winner.commands);
		for (const l of losers) kept.push(...l.commands.filter((c) => c.includes("cd ")));
		if (winner.verify) verify.push(winner.verify);
		tools.push(...winner.tools);
	}
	return { commands: ["sudo apt-get update -qq", ...new Set(kept)].join(" && "), verify: verify.join(" && "), tools: [...new Set(tools)] };
}

/**
 * Recipe script → Dockerfile for the durable template-build path.
 * Generated recipes join steps on top-level `&&` — split there, one RUN per
 * step. `USER root` for privileged installs, `USER user` for $HOME-relative
 * ones (rustup/cargo, playwright cache); repo `cd`s are harmless at build.
 */
export function toDockerfile(commands: string, verify?: string): string {
	// Toolchain-only template: steps that touch the cloned repo (dep installs)
	// are dropped — the build context has no repo, and code/deps belong to the
	// snapshot layer anyway.
	const raw = commands.split(/\s*&&\s*/).map((s) => s.trim()).filter(Boolean);
	// Re-join `cd dir` with its command so repo-relative steps stay one unit.
	const joined: string[] = [];
	for (const s of raw) {
		if (/^cd\s+\S+$/.test(s)) joined.push(s);
		else if (joined.length && /^cd\s+\S+$/.test(joined[joined.length - 1])) joined[joined.length - 1] += ` && ${s}`;
		else joined.push(s);
	}
	const steps = joined.filter((s) => !s.includes(REPO_DIR) && !/^cd\s+\S+$/.test(s));
	const needsUser = (s: string) => /\$HOME|rustup|\.cargo|playwright install\b/.test(s);
	const lines = ["FROM e2bdev/base", "USER root"];
	let user = "root";
	for (const s of steps) {
		const env = /^export\s+(\w+)=(.+)$/.exec(s);
		if (env) { lines.push(`ENV ${env[1]}=${env[2]}`); continue; }
		const want = needsUser(s) ? "user" : "root";
		if (want !== user) { lines.push(`USER ${want}`); user = want; }
		lines.push(`RUN ${s.replace(/^sudo\s+/gm, "")}`);
	}
	if (verify?.trim()) {
		if (user !== "user") lines.push("USER user");
		lines.push(`RUN ${verify.trim().replace(/^sudo\s+/gm, "")}`);
	}
	lines.push("USER user");
	return lines.join("\n");
}

/* ─────────────────────────── repo scanning ─────────────────────────── */

const ghHeaders = (token: string) => {
	const h: Record<string, string> = { Accept: "application/vnd.github+json" };
	if (token) h.Authorization = `Bearer ${token}`;
	return h;
};

const ghFile = async (repo: string, path: string, ref: string | undefined, headers: Record<string, string>): Promise<string | undefined> => {
	const r = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, {
		headers,
		signal: AbortSignal.timeout(10_000),
	}).catch(() => null);
	if (!r?.ok) return undefined;
	const d = (await r.json().catch(() => null)) as { content?: string; encoding?: string } | null;
	return d?.encoding === "base64" && d.content ? Buffer.from(d.content, "base64").toString("utf8").slice(0, 8192) : undefined;
};

/**
 * Recursive scan: list the repo tree once, pick manifest paths (depth ≤ 4),
 * fetch their contents, group by directory → per-project manifest maps.
 * Falls back to a root-only probe when the tree API fails or truncates.
 */
export async function scanRepo(repo: string, token: string, ref?: string): Promise<Map<string, Record<string, string>>> {
	const headers = ghHeaders(token);
	let branch = ref;
	if (!branch) {
		const r = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
		branch = r?.ok ? (((await r.json().catch(() => null)) as { default_branch?: string }).default_branch ?? undefined) : undefined;
	}
	const byDir = new Map<string, Record<string, string>>();
	const put = (path: string, content: string) => {
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		const base = path.slice(path.lastIndexOf("/") + 1);
		(byDir.get(dir) ?? byDir.set(dir, {}).get(dir)!)[base] = content;
	};

	const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch ?? "HEAD")}?recursive=1`, {
		headers,
		signal: AbortSignal.timeout(15_000),
	}).catch(() => null);
	const tree = treeRes?.ok ? ((await treeRes.json().catch(() => null)) as { tree?: { path?: string }[]; truncated?: boolean }) : null;

	if (tree?.tree?.length && !tree.truncated) {
		const paths = tree.tree
			.map((t) => t.path ?? "")
			.filter((p) => {
				const depth = p.split("/").length - 1;
				return depth <= 4 && MANIFEST_SET.has(p.slice(p.lastIndexOf("/") + 1)) && !/(^|\/)(node_modules|vendor|dist|target|\.git)\//.test(p);
			})
			.slice(0, 24);
		const contents = await Promise.all(paths.map(async (p) => [p, await ghFile(repo, p, ref ?? branch, headers)] as const));
		for (const [p, c] of contents) if (c !== undefined) put(p, c);
	} else {
		// Root-only fallback (original behavior).
		const root = await Promise.all(MANIFEST_FILES.map(async (f) => [f, await ghFile(repo, f, ref, headers)] as const));
		for (const [f, c] of root) if (c !== undefined) put(f, c);
	}
	return byDir;
}

/** Detect stacks in one project directory's manifest map. */
export function detectProject(dir: string, m: Record<string, string>, versions?: Record<string, string>): ProjectScan | null {
	const has = (f: string) => m[f] !== undefined;
	const parts = Object.keys(EMITTERS).map((k) => EMITTERS[k](has, m, dir, versions)).filter((p): p is StackPart => !!p);
	const found = Object.keys(m);
	if (!parts.length && !found.length) return null;
	let deps: ProjectScan["deps"];
	let scripts: Record<string, string> | undefined;
	if (m["package.json"]) {
		try {
			const pkg = JSON.parse(m["package.json"]) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
			const list = (d?: Record<string, string>) => Object.entries(d ?? {}).slice(0, 40).map(([name, version]) => ({ name, version: String(version).slice(0, 30) }));
			deps = { prod: list(pkg.dependencies), dev: list(pkg.devDependencies) };
			scripts = pkg.scripts;
		} catch { /* malformed */ }
	}
	return {
		dir,
		stacks: parts.map((p) => p.stack),
		tools: [...new Set(parts.flatMap((p) => p.tools))],
		found,
		needsCustom: !!(m["Dockerfile"] || m["docker-compose.yml"]) || undefined,
		deps,
		scripts,
		parts,
	};
}

const slug = (repo: string) => repo.split("/")[1]?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 30) || "repo";

/** Full scan result → merged recipe + project list for the API response. */
export function scanResult(repo: string, byDir: Map<string, Record<string, string>>, versions?: Record<string, string>): { projects: ProjectScan[]; recipe: GeneratedRecipe | null } {
	const projects = [...byDir.entries()]
		.map(([dir, m]) => detectProject(dir, m, versions))
		.filter((p): p is ProjectScan => !!p && p.parts.length > 0)
		.slice(0, 8);
	const allParts = projects.flatMap((p) => p.parts);
	if (!allParts.length) return { projects, recipe: null };
	const merged = mergeParts(allParts);
	return {
		projects,
		recipe: {
			name: `${slug(repo)}-env`,
			commands: merged.commands,
			verify: merged.verify || undefined,
			tools: merged.tools,
			description: `${merged.tools.join(" + ")} environment derived from ${repo} (${projects.length} project${projects.length > 1 ? "s" : ""}).`,
			needsCustom: projects.some((p) => p.needsCustom) || undefined,
		},
	};
}

/**
 * LLM fallback for stacks the rules don't cover. One cheap chat call against
 * the user's provider; returns a validated draft or null.
 */
export async function llmRecipe(
	repo: string,
	m: Record<string, string>,
	provider: { baseUrl?: string; apiKey?: string; modelId?: string },
): Promise<GeneratedRecipe | null> {
	if (!provider.baseUrl || !provider.apiKey || !provider.modelId) return null;
	const found = Object.keys(m).join(", ") || "none detected";
	const snippets = Object.entries(m)
		.filter(([f]) => f !== "README.md")
		.map(([f, c]) => `--- ${f} ---\n${c.slice(0, 1200)}`)
		.join("\n\n")
		.slice(0, 9000);
	const prompt = `Draft an E2B sandbox image recipe for the repo "${repo}". The sandbox is stock Ubuntu; the repo will be cloned to ${REPO_DIR} before the commands run.

Detected manifest files: ${found}
${snippets ? `\nManifest contents:\n${snippets}` : ""}

Return ONLY JSON: {"name":"kebab-name-env","commands":"shell script joined with &&","verify":"one shell check","tools":["Node 20","pip"],"description":"one line"}
commands install the toolchain + deps (apt-get/pip/npm as needed, quiet output). verify is a single non-zero-on-failure check. name: 3-40 lowercase chars/digits/hyphens.`;
	const base = provider.baseUrl.replace(/\/+$/, "");
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
		body: JSON.stringify({ model: provider.modelId, messages: [{ role: "user", content: prompt }], max_tokens: 1200, temperature: 0 }),
		signal: AbortSignal.timeout(20_000),
	}).catch(swallow("recipeGen", "op", null));
	if (!res?.ok) return null;
	const body = (await res.json().catch(swallow("recipeGen", "op", null))) as { choices?: { message?: { content?: string } }[] } | null;
	const raw = body?.choices?.[0]?.message?.content ?? "";
	const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
	let draft: GeneratedRecipe;
	try { draft = JSON.parse(jsonText) as GeneratedRecipe; } catch { return null; }
	if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(draft.name ?? "") || typeof draft.commands !== "string" || !draft.commands.trim()) return null;
	return {
		name: draft.name,
		commands: draft.commands.slice(0, 8000),
		verify: typeof draft.verify === "string" ? draft.verify.slice(0, 1000) : undefined,
		tools: Array.isArray(draft.tools) ? draft.tools.filter((t): t is string => typeof t === "string").slice(0, 10) : [],
		description: typeof draft.description === "string" ? draft.description : `Generated for ${repo}`,
	};
}
