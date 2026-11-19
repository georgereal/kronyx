// Fake MCP server for mcpTools tests — one echo tool over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake", version: "0.0.1" });
server.registerTool(
	"echo",
	{
		description: "Echoes the input text",
		inputSchema: { text: z.string() },
	},
	async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
);
server.registerTool("explode", { description: "Always fails", inputSchema: {} }, async () => {
	throw new Error("boom");
});
await server.connect(new StdioServerTransport());
