import type { AgentTool } from "@cline/shared";
import { checkUrl, isAllowedHost, isPrivateName, safeGet, type SafeResponse } from "./network";

const MAX_CHARS = 60_000;
const MAX_FOLLOW = 5;
const MAX_LINKS = 40;
const MAX_BYTES = 5_000_000;
const TIMEOUT_MS = 20_000;
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", apos: "'" };
const decodeEntities = (s: string): string => s.replace(/&(#39|amp|lt|gt|quot|nbsp|apos);/g, (m, e) => ENTITIES[e] ?? m);
/** Strip tags + decode entities, no block spacing — for inline fragments (anchors, code, headings). */
const decodeFrag = (s: string): string => decodeEntities(s.replace(/<[^>]+>/g, ""));

/** Crude HTML→text: drop scripts/styles, tags to newlines, decode common entities. */
export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|pre|blockquote|table|ul|ol|br|hr)>/gi, "\n")
			.replace(/<(br|hr)[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n\n")
		.trim();
}

/** HTML→light markdown: headings, list items, fenced code, blockquotes survive. */
export function htmlToMd(html: string): string {
	return decodeEntities(
		html
			.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, c: string) => `\n\`\`\`\n${decodeFrag(c)}\n\`\`\`\n`)
			.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c: string) => `\`${decodeFrag(c)}\``)
			.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, c: string) => `\n\n${"#".repeat(Number(n))} ${decodeFrag(c)}\n`)
			.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, c: string) => `\n- ${decodeFrag(c)}`)
			.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, c: string) => `\n> ${decodeFrag(c)}`)
			.replace(/<a\b[^>]*?href\s*=\s*["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, c: string) => decodeFrag(c))
			.replace(/<\/(p|div|section|article|header|footer|tr|table|ul|ol|br|hr)>/gi, "\n")
			.replace(/<(br|hr)[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n+/g, "\n\n")
		.trim();
}

const A_RE = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/** Page links the model can traverse — resolved against the base, http(s) only, deduped. */
export function extractLinks(html: string, base: URL, limit = MAX_LINKS, allowHosts: readonly string[] = []): { text: string; url: string }[] {
	const out: { text: string; url: string }[] = [];
	const seen = new Set<string>();
	for (const m of html.matchAll(A_RE)) {
		const raw = m[1].trim();
		if (!raw || raw.startsWith("#") || /^[a-z]+:/i.test(raw) && !/^https?:/i.test(raw)) continue;
		let u: URL;
		try {
			u = new URL(raw, base);
		} catch {
			continue;
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") continue;
		if (isPrivateName(u.hostname) && !isAllowedHost(u, allowHosts)) continue;
		u.hash = "";
		const href = u.toString();
		if (seen.has(href)) continue;
		seen.add(href);
		const text = decodeFrag(m[2]).replace(/\s+/g, " ").trim().slice(0, 80) || u.pathname.split("/").pop() || href;
		out.push({ text, url: href });
		if (out.length >= limit) break;
	}
	return out;
}

const HEADERS = {
	"User-Agent": UA,
	Accept: "text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5",
	"Accept-Language": "en-US,en;q=0.9",
};

/** Fetch one URL → readable markdown-ish text + its outgoing links, or an error string. */
async function fetchPage(start: URL, allowHosts: readonly string[] = []): Promise<{ text: string; links: { text: string; url: string }[]; error?: string }> {
	// Manual redirect handling — every hop runs the network policy again,
	// otherwise a public URL could redirect into a private address.
	const get = async (): Promise<SafeResponse | string> => {
		let current = start;
		for (let hop = 0; hop <= 5; hop++) {
			const refused = await checkUrl(current, allowHosts);
			if (refused) return refused;
			let r: SafeResponse;
			try {
				r = await safeGet(current, { headers: HEADERS, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, allowHosts });
			} catch (e) {
				return `request failed — ${e instanceof Error ? e.message : String(e)}`;
			}
			if (![301, 302, 303, 307, 308].includes(r.status)) return r;
			const loc = r.headers.get("location");
			if (!loc) return r;
			try {
				current = new URL(loc, current);
			} catch {
				return `redirect to an invalid URL (${loc.slice(0, 120)})`;
			}
		}
		return "too many redirects (>5).";
	};
	let res = await get();
	if (typeof res === "string") return { text: "", links: [], error: res };
	// One bounded retry on 429 — parallel agent fetches and origin
	// rate-limiters both trip on bursts; honor Retry-After, capped.
	if (res.status === 429) {
		const ra = Number(res.headers.get("retry-after") ?? "");
		const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 4000 + Math.random() * 2000;
		await new Promise((r) => setTimeout(r, wait));
		res = await get();
		if (typeof res === "string") return { text: "", links: [], error: res };
	}
	if (!res.ok) {
		const hint = res.status === 429 ? " (rate-limited — the site is blocking automated fetches)" : res.status === 403 ? " (forbidden — likely a bot block)" : "";
		return { text: "", links: [], error: `HTTP ${res.status} ${res.statusText}${hint}` };
	}
	const ct = (res.headers.get("content-type") ?? "").toLowerCase();
	if (ct && !/text|json|xml|markdown|javascript|html/.test(ct))
		return { text: "", links: [], error: `unsupported content type ${ct} — this tool reads text pages only.` };

	const raw = await res.text().catch(() => "");
	const isHtml = ct.includes("html") || /^<!doctype html|<html[\s>]/i.test(raw.slice(0, 500));
	const finalUrl = res.url ? new URL(res.url) : start;
	return { text: isHtml ? htmlToMd(raw) : raw, links: isHtml ? extractLinks(raw, finalUrl, MAX_LINKS, allowHosts) : [] };
}

export interface WebSearchConfig {
	provider?: "tavily" | "brave" | "duckduckgo";
	/** May contain ${ENV_VAR} references — expanded at call time. */
	apiKey?: string;
}

interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

const expandEnvRef = (v: string): string =>
	v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, n: string, d?: string) => process.env[n] ?? d ?? "");

async function tavilySearch(query: string, key: string, max: number): Promise<SearchHit[] | string> {
	try {
		const r = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: "basic" }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!r.ok) return `tavily HTTP ${r.status}`;
		const data = (await r.json()) as { results?: { title?: string; url?: string; content?: string }[] };
		return (data.results ?? []).map((x) => ({ title: x.title ?? "", url: x.url ?? "", snippet: x.content ?? "" }));
	} catch (e) {
		return `tavily request failed — ${e instanceof Error ? e.message : String(e)}`;
	}
}

async function braveSearch(query: string, key: string, max: number): Promise<SearchHit[] | string> {
	try {
		const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, {
			headers: { "X-Subscription-Token": key, Accept: "application/json", "User-Agent": UA },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!r.ok) return `brave HTTP ${r.status}`;
		const data = (await r.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
		return (data.web?.results ?? []).map((x) => ({ title: decodeEntities(x.title ?? ""), url: x.url ?? "", snippet: decodeEntities(x.description ?? "") }));
	} catch (e) {
		return `brave request failed — ${e instanceof Error ? e.message : String(e)}`;
	}
}

/** Keyless fallback — DDG lite HTML results. Best effort; breaks when they change markup. */
async function duckduckgoSearch(query: string, max: number): Promise<SearchHit[] | string> {
	try {
		const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
			headers: { "User-Agent": UA, Accept: "text/html" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!r.ok) return `duckduckgo HTTP ${r.status}`;
		const html = await r.text();
		const hits: SearchHit[] = [];
		// Result anchors carry class="result-link"; the snippet lives in the next row's result-snippet cell.
		const re = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:result-snippet[^>]*>([\s\S]*?)<\/td>)?/gi;
		for (const m of html.matchAll(re)) {
			let url = m[1];
			const uddg = url.match(/uddg=([^&]+)/);
			if (uddg) url = decodeURIComponent(uddg[1]);
			try {
				const u = new URL(url);
				if (u.protocol !== "http:" && u.protocol !== "https:") continue;
			} catch {
				continue;
			}
			hits.push({ title: decodeFrag(m[2]).replace(/\s+/g, " ").trim(), url, snippet: decodeFrag(m[3] ?? "").replace(/\s+/g, " ").trim() });
			if (hits.length >= max) break;
		}
		return hits.length ? hits : "duckduckgo returned no parseable results — consider configuring a tavily/brave apiKey.";
	} catch (e) {
		return `duckduckgo request failed — ${e instanceof Error ? e.message : String(e)}`;
	}
}

/**
 * Worker-side URL reader — the agent's only way to fetch web pages/docs the
 * user shares. Runs on the backend host (not the sandbox), so it works in
 * ask/plan modes too and avoids E2B datacenter-IP rate limits.
 */
export function createFetchTools(search?: WebSearchConfig, net?: { allowHosts?: readonly string[] }): AgentTool<any, string>[] {
	const allowHosts = net?.allowHosts ?? [];
	const fetchUrl: AgentTool<{ url: string; max_chars?: number; follow?: number }, string> = {
		name: "fetch_url",
		description:
			"Fetch a web page or document (docs, blog posts, API references) and return readable markdown-ish text plus a 'links:' list of the page's URLs for traversal. " +
			"Use follow to also fetch the first N same-site links (bounded crawl). Returns the HTTP status when a site refuses — report blocks honestly instead of retrying forever.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "Full http(s) URL to fetch." },
				max_chars: {
					type: "integer",
					minimum: 1000,
					maximum: MAX_CHARS,
					description: `Total character budget across all fetched pages, default ${MAX_CHARS}.`,
				},
				follow: {
					type: "integer",
					minimum: 0,
					maximum: MAX_FOLLOW,
					description: `Also fetch up to this many same-site links from the page, 0-${MAX_FOLLOW} (default 0).`,
				},
			},
			required: ["url"],
		},
		async execute(input) {
			let parsed: URL;
			try {
				parsed = new URL(String(input.url ?? ""));
			} catch {
				return `fetch_url: invalid URL ${JSON.stringify(input.url)}`;
			}
			const refused = await checkUrl(parsed, allowHosts);
			if (refused) return `fetch_url: ${refused}`;

			const cap = Math.min(Math.max(1000, input.max_chars ?? MAX_CHARS), MAX_CHARS);
			const page = await fetchPage(parsed, allowHosts);
			if (page.error) return `fetch_url: ${page.error}`;
			const parts: string[] = [];
			// The links list rides free — it's the traversal map, not page content.
			const linkBlock = (ls: { text: string; url: string }[]) =>
				ls.length ? `\n\nlinks:\n${ls.map((l) => `- ${l.text} — ${l.url}`).join("\n")}` : "";
			const mainText = page.text.slice(0, cap) || "(empty page)";
			const mainTrunc = page.text.length > cap ? `\n\n[truncated — page is ${page.text.length} chars, showing first ${cap}]` : "";
			parts.push(mainText + mainTrunc + linkBlock(page.links));
			let budget = cap - mainText.length;

			const n = Math.min(Math.max(0, input.follow ?? 0), MAX_FOLLOW);
			const sameSite = page.links.filter((l) => new URL(l.url).origin === parsed.origin).slice(0, n);
			for (const link of sameSite) {
				if (budget <= 500) break;
				const p = await fetchPage(new URL(link.url), allowHosts);
				if (p.error) {
					parts.push(`\n\n=== ${link.url} ===\nfetch_url: ${p.error}`);
					continue;
				}
				const slice = p.text.slice(0, budget);
				parts.push(`\n\n=== ${link.url} ===\n${slice}${p.text.length > budget ? " [truncated]" : ""}`);
				budget -= slice.length;
			}
			return parts.join("");
		},
	};

	const webSearch: AgentTool<{ query: string; max_results?: number }, string> = {
		name: "web_search",
		description:
			"Search the web for a query and return ranked results (title, url, snippet). Follow promising hits with fetch_url — including its follow/links traversal — to read the actual pages.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query." },
				max_results: { type: "integer", minimum: 1, maximum: 10, description: "Results to return, default 5." },
			},
			required: ["query"],
		},
		async execute(input) {
			const query = String(input.query ?? "").trim();
			if (!query) return "web_search: empty query.";
			const max = Math.min(Math.max(1, input.max_results ?? 5), 10);
			const provider = search?.provider ?? (search?.apiKey ? "tavily" : "duckduckgo");
			const key = expandEnvRef(search?.apiKey ?? "").trim();
			const out =
				provider === "tavily"
					? key ? await tavilySearch(query, key, max) : "web_search: provider tavily needs an apiKey (set webSearch.apiKey or fall back to duckduckgo)."
					: provider === "brave"
						? key ? await braveSearch(query, key, max) : "web_search: provider brave needs an apiKey (set webSearch.apiKey or fall back to duckduckgo)."
						: await duckduckgoSearch(query, max);
			if (typeof out === "string") return `web_search: ${out}`;
			return out.map((h, i) => `${i + 1}. ${h.title} — ${h.url}\n   ${h.snippet}`).join("\n");
		},
	};
	return [fetchUrl, webSearch];
}
