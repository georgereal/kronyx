import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchTools, htmlToText } from "../src/tools/fetchTools";
import { safeGet } from "../src/tools/network";

// Transport seam: page requests go through safeGet (connect-time address check).
// Tests stub it with Response objects; the literal-IP policy in checkUrl stays real.
vi.mock("../src/tools/network", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/tools/network")>();
	return { ...actual, safeGet: vi.fn() };
});

const tool = createFetchTools()[0];
const exec = (input: { url: string; max_chars?: number }) => tool.execute(input, {} as never);

const mockFetch = (impl: (...args: unknown[]) => Promise<Response>) => {
	const fn = vi.fn(async (url: URL, init?: unknown) => {
		const res = await impl(url.toString(), init);
		return { status: res.status, statusText: res.statusText, ok: res.ok, url: url.toString(), headers: res.headers, text: () => res.text() };
	});
	vi.mocked(safeGet).mockImplementation(fn as never);
	return fn;
};
const okResponse = (body: string, ct = "text/html") =>
	new Response(body, { status: 200, headers: { "content-type": ct } });

afterEach(() => vi.mocked(safeGet).mockReset());

describe("htmlToText", () => {
	it("strips scripts/styles/tags and decodes entities", () => {
		const html = `<html><head><style>body{color:red}</style><script>var x=1</script></head>
			<body><h1>Title</h1><p>Hello &amp; welcome&nbsp;back</p><ul><li>one</li><li>two</li></ul></body></html>`;
		const text = htmlToText(html);
		expect(text).toContain("Title");
		expect(text).toContain("Hello & welcome back");
		expect(text).toContain("one");
		expect(text).not.toContain("color:red");
		expect(text).not.toContain("var x");
		expect(text).not.toContain("<p>");
	});
});

describe("fetch_url", () => {
	it("returns text for an HTML page", async () => {
		mockFetch(async () => okResponse("<p>Docs &lt;here&gt;</p>", "text/html"));
		const out = await exec({ url: "https://example.com/docs" });
		expect(out).toBe("Docs <here>");
	});

	it("passes markdown/plain through unstripped", async () => {
		mockFetch(async () => okResponse("# Heading\n\nsome `code`", "text/markdown"));
		expect(await exec({ url: "https://x.test/a.md" })).toBe("# Heading\n\nsome `code`");
	});

	it("reports HTTP errors with status", async () => {
		mockFetch(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }));
		const out = await exec({ url: "https://deepwiki.com/x" });
		expect(out).toContain("HTTP 503");
	});

	it("retries once on 429 honoring Retry-After, then reports honestly", async () => {
		const spy = mockFetch(async () => new Response("nope", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "0.01" } }));
		const out = await exec({ url: "https://deepwiki.com/x" });
		expect(spy).toHaveBeenCalledTimes(2);
		expect(out).toContain("HTTP 429");
		expect(out).toContain("rate-limited");
	});

	it("returns the retried 200 after an initial 429", async () => {
		let calls = 0;
		const spy = mockFetch(async () => {
			calls++;
			return calls === 1
				? new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } })
				: okResponse("page content", "text/plain");
		});
		expect(await exec({ url: "https://x.test/doc" })).toBe("page content");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("rejects non-http schemes", async () => {
		expect(await exec({ url: "file:///etc/passwd" })).toContain("only http/https");
		expect(await exec({ url: "not a url" })).toContain("invalid URL");
	});

	it("rejects private/loopback hosts without calling fetch", async () => {
		const spy = mockFetch(async () => okResponse("x"));
		for (const url of ["http://localhost:3000", "http://127.0.0.1/x", "http://192.168.1.5/x", "http://10.0.0.4/x"])
			expect(await exec({ url })).toContain("private/loopback");
		expect(spy).not.toHaveBeenCalled();
	});

	it("rejects binary content types", async () => {
		mockFetch(async () => okResponse("PK\x03\x04", "application/zip"));
		expect(await exec({ url: "https://x.test/a.zip" })).toContain("unsupported content type");
	});

	it("truncates at the char cap with a notice", async () => {
		mockFetch(async () => okResponse("y".repeat(5000), "text/plain"));
		const out = await exec({ url: "https://x.test/big", max_chars: 2000 });
		expect(out).toContain("truncated");
		expect(out.length).toBeLessThan(2300);
	});

	it("follows redirects but re-validates each hop's host", async () => {
		mockFetch(async (input) => {
			const url = String((input as URL).href ?? input);
			if (url.includes("first")) return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } });
			return okResponse("final");
		});
		expect(await exec({ url: "https://x.test/first" })).toContain("private/loopback");
	});

	it("follows a safe redirect chain", async () => {
		mockFetch(async (input) => {
			const url = String((input as URL).href ?? input);
			if (url.endsWith("/a")) return new Response(null, { status: 301, headers: { location: "https://x.test/b" } });
			return okResponse("final page", "text/plain");
		});
		expect(await exec({ url: "https://x.test/a" })).toBe("final page");
	});

	it("reports request failures", async () => {
		mockFetch(async () => {
			throw new Error("ENOTFOUND");
		});
		expect(await exec({ url: "https://gone.invalid" })).toContain("request failed");
	});
});

describe("extractLinks / htmlToMd / follow", () => {
	it("extracts deduped http(s) links with anchor text", async () => {
		const { extractLinks } = await import("../src/tools/fetchTools");
		const html = `<a href="/docs">Docs</a><a href="https://x.test/a">A</a><a href="#frag">x</a>
			<a href="javascript:void(0)">j</a><a href="http://localhost:1/x">priv</a><a href="/docs">dup</a>`;
		const links = extractLinks(html, new URL("https://site.test/p"));
		expect(links.map((l) => l.url)).toEqual(["https://site.test/docs", "https://x.test/a"]);
		expect(links[0].text).toBe("Docs");
	});

	it("htmlToMd keeps headings, list items and code", async () => {
		const { htmlToMd } = await import("../src/tools/fetchTools");
		const md = htmlToMd(`<h2>Setup</h2><ul><li>first</li></ul><pre>npm i\nnpm run dev</pre><code>inline()</code>`);
		expect(md).toContain("## Setup");
		expect(md).toContain("- first");
		expect(md).toContain("```\nnpm i\nnpm run dev\n```");
		expect(md).toContain("`inline()`");
	});

	it("appends a links: section to fetched HTML", async () => {
		mockFetch(async () => okResponse(`<p>hi</p><a href="/more">More</a>`));
		const out = await exec({ url: "https://a.test/" });
		expect(out).toContain("links:");
		expect(out).toContain("More — https://a.test/more");
	});

	it("follow fetches same-site links within the shared budget", async () => {
		const fetchFn = mockFetch(async (u) =>
			String(u).includes("/next") ? okResponse("<p>next page</p>") : okResponse(`<p>root</p><a href="/next">N</a><a href="https://other.test/x">X</a>`),
		);
		const out = await exec({ url: "https://a.test/", follow: 3 } as never);
		expect(out).toContain("=== https://a.test/next ===");
		expect(out).toContain("next page");
		// Cross-site link is never followed.
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
});
