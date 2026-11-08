import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

import { copyFileSync, mkdirSync } from "node:fs";

const ctx = await esbuild.context({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node22",
	outfile: "dist/extension.js",
	external: ["vscode", "better-sqlite3"],
	sourcemap: !production,
	minify: production,
	logLevel: "info",
});

if (watch) {
	await ctx.watch();
} else {
	await ctx.rebuild();
	// sql.js wasm binary for the Kronyx store
	mkdirSync("dist", { recursive: true });
	copyFileSync("node_modules/sql.js/dist/sql-wasm.wasm", "dist/sql-wasm.wasm");
	await ctx.dispose();
}
