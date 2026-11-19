import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { createMcpTools, expandEnv } from "../src/tools/mcpTools";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fakeMcpServer.mjs");

describe("expandEnv", () => {
	it("substitutes ${VAR} and reports the value as a secret", () => {
		process.env.MCP_TEST_KEY = "s3cret";
		const secrets: string[] = [];
		expect(expandEnv("token=${MCP_TEST_KEY}", (v) => secrets.push(v))).toBe("token=s3cret");
		expect(secrets).toEqual(["s3cret"]);
		expect(expandEnv("${MISSING_VAR:-dflt}")).toBe("dflt");
		expect(expandEnv("${MISSING_VAR}")).toBe("");
	});
});

describe("createMcpTools", () => {
	it("connects to a stdio server and exposes mcp_<server>_<tool>", async () => {
		const set = await createMcpTools({
			servers: [{ name: "fake", command: process.execPath, args: [fixture] }],
		});
		try {
			const names = set.tools.map((t) => t.name).sort();
			expect(names).toEqual(["mcp_fake_echo", "mcp_fake_explode"]);
			const echo = set.tools.find((t) => t.name === "mcp_fake_echo")!;
			expect(await echo.execute({ text: "hi" }, {} as never)).toBe("echo:hi");
		} finally {
			await set.close();
		}
	}, 30_000);

	it("survives a dead server — zero tools, no throw", async () => {
		const logs: string[] = [];
		const set = await createMcpTools({
			servers: [{ name: "bad", command: "/nonexistent/binary-xyz" }],
			log: (m) => logs.push(m),
		});
		try {
			expect(set.tools).toEqual([]);
			expect(logs.some((l) => l.includes('"bad"'))).toBe(true);
		} finally {
			await set.close();
		}
	}, 30_000);
});
