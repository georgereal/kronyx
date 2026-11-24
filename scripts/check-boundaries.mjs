#!/usr/bin/env node
/**
 * Boundary check: vscode-free directories must never import "vscode" —
 * the backend worker bundles src/{agent,tools,sandbox,diff} via esbuild and
 * has no vscode runtime. Exits 1 listing every violation.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FREE_DIRS = ["src/agent", "src/tools", "src/sandbox", "src/diff", "src/harness"];
const PATTERN = /(?:from\s+["']vscode["']|import\s*\(\s*["']vscode["']|require\s*\(\s*["']vscode["'])/;

const violations = [];
const walk = (dir) => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (/\.tsx?$/.test(e.name) && PATTERN.test(readFileSync(p, "utf8"))) violations.push(p);
	}
};
for (const d of FREE_DIRS) walk(d);

if (violations.length) {
	console.error("vscode import found in vscode-free directories:");
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}
console.log(`boundary check: ${FREE_DIRS.length} vscode-free directories clean`);
