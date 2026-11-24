import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLocalBrowserTools } from "../src/tools/localBrowserTools";

describe("browser_screenshot path guard", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "kronyx-shot-"));
	const shot = createLocalBrowserTools({ root }).tools.find((t) => t.name === "browser_screenshot")!;

	it("refuses absolute and parent-relative paths outside the workspace before launching a browser", async () => {
		const outside = path.join(os.tmpdir(), "escape.png");
		expect(await shot.execute({ path: outside }, {} as never)).toMatch(/outside the workspace/);
		expect(await shot.execute({ path: "../escape.png" }, {} as never)).toMatch(/outside the workspace/);
	});
});
