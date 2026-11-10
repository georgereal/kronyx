import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { dbg } from "./lib/log";
import { routes } from "./routes";

try {
	process.loadEnvFile?.(".env");
} catch {}

const PORT = Number(process.env.BACKEND_PORT ?? 4000);

// Transient Mongo/network errors must not kill the process — the driver
// retries; a crash strands claimed jobs and drops SSE clients.
process.on("unhandledRejection", (err) => {
	console.error("[backend] unhandled rejection (kept alive):", err);
});
process.on("uncaughtException", (err) => {
	console.error("[backend] uncaught exception (kept alive):", err);
});

async function toRequest(req: IncomingMessage): Promise<Request> {
	const host = req.headers.host ?? `localhost:${PORT}`;
	const url = `http://${host}${req.url ?? "/"}`;
	const method = req.method ?? "GET";
	if (method === "GET" || method === "HEAD") {
		return new Request(url, { method, headers: req.headers as HeadersInit });
	}
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	return new Request(url, {
		method,
		headers: req.headers as HeadersInit,
		body: chunks.length ? Buffer.concat(chunks) : undefined,
	});
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
	res.statusCode = response.status;
	response.headers.forEach((v, k) => res.setHeader(k, v));
	if (!response.body) {
		res.end();
		return;
	}
	for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
		res.write(chunk);
	}
	res.end();
}

const server = createServer((req, res) => {
	void (async () => {
		const started = Date.now();
		const request = await toRequest(req);
		const url = new URL(request.url);
		for (const r of routes) {
			if (r.method !== request.method) continue;
			const params = r.match(url.pathname);
			if (!params) continue;
			const response = await r.handler(request, params);
			dbg("http", `${request.method} ${url.pathname} → ${response.status} ${Date.now() - started}ms`);
			await sendResponse(res, response);
			return;
		}
		dbg("http", `${request.method} ${url.pathname} → 404`);
		res.statusCode = 404;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ error: "not_found" }));
	})().catch((error) => {
		console.error("[backend] unhandled:", error);
		if (!res.headersSent) {
			res.statusCode = 500;
			res.setHeader("content-type", "application/json");
		}
		res.end(JSON.stringify({ error: "internal" }));
	});
});

server.listen(PORT, () => console.log(`[backend] listening on :${PORT}`));

// Embedded mode: run the job worker in-process (dev convenience).
// Separate `npm run worker` process remains the robust production topology.
if (process.env.BACKEND_RUN_WORKER === "1") {
	const { startWorker } = await import("./worker/loop");
	void startWorker();
}
