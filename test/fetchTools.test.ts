import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchTools, htmlToText } from "../src/tools/fetchTools";

const tool = createFetchTools()[0];
const exec = (input: { url: string; max_chars?: number }) => tool.execute(input, {} as never);

const mockFetch = (impl: (...args: unknown[]) => Promise<Response>) => {
	const fn = vi.fn(impl);
	vi.stubGlobal("fetch", fn);
	return fn;
};
const okResponse = (body: string, ct = "text/html") =>
	new Response(body, { status: 200, headers: { "content-type": ct } });

afterEach(() => vi.unstubAllGlobals());

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
		mockFetch(async () => new Response("nope", { status: 429, statusText: "Too Many Requests" }));
		const out = await exec({ url: "https://deepwiki.com/x" });
		expect(out).toContain("HTTP 429");
		expect(out).toContain("rate-limited");
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
