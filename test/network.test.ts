import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { checkUrl, isAllowedHost, isPrivateAddress, isPrivateName, safeGet } from "../src/tools/network";

describe("isPrivateAddress", () => {
	it("flags loopback, private, link-local, CGNAT, and reserved IPv4", () => {
		for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
			expect(isPrivateAddress(ip), ip).toBe(true);
		}
		for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
	});

	it("flags IPv6 loopback, unspecified, ULA, link-local, and mapped IPv4 forms", () => {
		for (const ip of ["::1", "[::1]", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1"]) {
			expect(isPrivateAddress(ip), ip).toBe(true);
		}
		for (const ip of ["2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
	});

	it("flags private hostnames without DNS", () => {
		expect(isPrivateName("localhost")).toBe(true);
		expect(isPrivateName("api.localhost")).toBe(true);
		expect(isPrivateName("metadata.google.internal")).toBe(true);
		expect(isPrivateName("[::1]")).toBe(true);
		expect(isPrivateName("example.com")).toBe(false);
	});
});

describe("isAllowedHost", () => {
	const u = (s: string) => new URL(s);
	it("matches host, host:port, and wildcard entries", () => {
		expect(isAllowedHost(u("http://localhost:3000/app"), ["localhost:3000"])).toBe(true);
		expect(isAllowedHost(u("http://localhost:4000/"), ["localhost:3000"])).toBe(false);
		expect(isAllowedHost(u("http://localhost:4000/"), ["localhost"])).toBe(true);
		expect(isAllowedHost(u("https://api.corp.internal/x"), ["*.corp.internal"])).toBe(true);
		expect(isAllowedHost(u("https://corp.internal/x"), ["*.corp.internal"])).toBe(false);
		expect(isAllowedHost(u("https://example.com/"), [])).toBe(false);
	});
});

describe("checkUrl", () => {
	it("refuses non-http schemes and private literals before any request", async () => {
		expect(await checkUrl(new URL("file:///etc/passwd"))).toMatch(/only http\/https/);
		expect(await checkUrl(new URL("http://127.0.0.1:8080/"))).toMatch(/private\/loopback/);
		expect(await checkUrl(new URL("http://[::1]:8080/"))).toMatch(/private\/loopback/);
		expect(await checkUrl(new URL("http://169.254.169.254/latest/meta-data"))).toMatch(/private\/loopback/);
		expect(await checkUrl(new URL("http://localhost:3000/"))).toMatch(/allowHosts/);
	});

	it("lets allowlisted private hosts through", async () => {
		expect(await checkUrl(new URL("http://localhost:3000/"), ["localhost:3000"])).toBeUndefined();
		expect(await checkUrl(new URL("http://127.0.0.1:9/"), ["127.0.0.1"])).toBeUndefined();
	});
});

describe("safeGet connect-time check", () => {
	let server: Server;
	let port: number;

	beforeAll(async () => {
		server = createServer((_req, res) => res.end("hi from local"));
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	it("blocks a hostname whose resolved address is private, even when checkUrl was skipped", async () => {
		await expect(safeGet(new URL(`http://localhost:${port}/`), { timeoutMs: 5000, maxBytes: 1000 })).rejects.toThrow(/blocked/);
	});

	it("connects and reads the body once the host is allowlisted", async () => {
		const res = await safeGet(new URL(`http://localhost:${port}/`), { timeoutMs: 5000, maxBytes: 1000, allowHosts: ["localhost"] });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hi from local");
	});
});
