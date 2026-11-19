import { describe, expect, it } from "vitest";
import { ToolPipeline, type PreVerdict } from "../src/agent/pipeline";

const call = { name: "write_file", input: { path: "a.ts" } };

describe("ToolPipeline.runPre", () => {
	it("defaults to ask on an empty chain", async () => {
		const v = await new ToolPipeline().runPre(call);
		expect(v).toEqual({ kind: "ask" });
	});

	it("runs listeners in registration order via next()", async () => {
		const order: string[] = [];
		const p = new ToolPipeline();
		p.pre(async (_c, next) => {
			order.push("a");
			return next();
		});
		p.pre(async (_c, next) => {
			order.push("b");
			return next();
		});
		await p.runPre(call);
		expect(order).toEqual(["a", "b"]);
	});

	it("short-circuits on the first non-delegating verdict", async () => {
		const order: string[] = [];
		const p = new ToolPipeline();
		p.pre(async () => {
			order.push("deny");
			return { kind: "deny", reason: "no" } as PreVerdict;
		});
		p.pre(async (_c, next) => {
			order.push("never");
			return next();
		});
		const v = await p.runPre(call);
		expect(v).toEqual({ kind: "deny", reason: "no" });
		expect(order).toEqual(["deny"]);
	});

	it("delegation reaches the default ask verdict", async () => {
		const p = new ToolPipeline();
		p.pre(async (_c, next) => next());
		expect(await p.runPre(call)).toEqual({ kind: "ask" });
	});

	it("dispose removes the listener", async () => {
		const p = new ToolPipeline();
		const d = p.pre(async () => ({ kind: "deny", reason: "no" }));
		d();
		expect(await p.runPre(call)).toEqual({ kind: "ask" });
	});
});

describe("ToolPipeline.runAround", () => {
	it("wraps execution in order, outermost first", async () => {
		const log: string[] = [];
		const p = new ToolPipeline();
		p.around(async (_c, run) => {
			log.push("a>");
			const r = await run();
			log.push("<a");
			return r;
		});
		p.around(async (_c, run) => {
			log.push("b>");
			const r = await run();
			log.push("<b");
			return r;
		});
		const out = await p.runAround(call, async () => {
			log.push("body");
			return 42;
		});
		expect(out).toBe(42);
		expect(log).toEqual(["a>", "b>", "body", "<b", "<a"]);
	});

	it("propagates body results and errors", async () => {
		const p = new ToolPipeline();
		await expect(p.runAround(call, async () => "x")).resolves.toBe("x");
		await expect(
			p.runAround(call, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});

describe("ToolPipeline.runPost", () => {
	it("passes result through untouched when no listeners", async () => {
		const r = await new ToolPipeline().runPost(call, "out");
		expect(r).toBe("out");
	});

	it("lets a listener replace the result via next(replacement)", async () => {
		const p = new ToolPipeline();
		p.post<string>(async (_c, result, next) => next(`${result}!`));
		p.post<string>(async (_c, result) => result);
		expect(await p.runPost(call, "out")).toBe("out!");
	});

	it("returning without next() short-circuits with the current result", async () => {
		const p = new ToolPipeline();
		p.post<string>(async (_c, result) => `seen:${result}`);
		p.post<string>(async (_c, result, next) => next(`${result}?`));
		expect(await p.runPost(call, "out")).toBe("seen:out");
	});
});
