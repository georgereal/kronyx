import * as esbuild from "esbuild";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(rootDir, "web");
const shimDir = path.join(rootDir, "src", "sessionView", "shims");

/**
 * Builds the Agent Mode session view: the REAL web session page
 * (web/app/(app)/sessions/[id]/page.tsx) compiled for the VS Code webview.
 * Web source stays untouched — Next/Firebase imports are remapped to shims,
 * so the IDE and dashboard ship literally the same session UI code.
 */
const sessionViewShims = {
	name: "session-view-shims",
	setup(build) {
		build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: path.join(shimDir, "nextNavigation.ts") }));
		build.onResolve({ filter: /^next\/link$/ }, () => ({ path: path.join(shimDir, "nextLink.tsx") }));
		build.onResolve({ filter: /^@\/lib\/api$/ }, () => ({ path: path.join(shimDir, "kronyxApi.ts") }));
		build.onResolve({ filter: /^@\/lib\/firebase$/ }, () => ({ path: path.join(shimDir, "firebaseStub.ts") }));
		build.onResolve({ filter: /^firebase\// }, () => ({ path: path.join(shimDir, "firebaseStub.ts") }));
		// Pin react to web/node_modules — the entry lives in src/, so default
		// resolution can walk into a PARENT dir's node_modules and bundle a
		// second React copy (null dispatcher → "reading 'useState'" crash).
		build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => {
			const target = path.join(webRoot, "node_modules", args.path);
			for (const cand of [target, `${target}.js`, `${target}.ts`, `${target}/index.js`, `${target}/client.js`]) {
				if (existsSync(cand) && statSync(cand).isFile()) return { path: cand };
			}
			return { path: target };
		});
		// "@/x" → "web/x" (web/tsconfig paths: "@/*" -> "./*"); plugin-returned
		// paths don't get extension resolution, so probe for the real file.
		build.onResolve({ filter: /^@\// }, (args) => {
			const base = path.join(webRoot, args.path.slice(2));
			for (const cand of [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`, `${base}.css`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
				if (existsSync(cand) && statSync(cand).isFile()) return { path: cand };
			}
			return { path: base };
		});
	},
};

const shared = {
	sourcemap: !production,
	minify: production,
	logLevel: "info",
};

const ctx = await esbuild.context({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node22",
	outfile: "dist/extension.js",
	external: ["vscode", "better-sqlite3", "playwright-core"],
	...shared,
});

// media/sessionPage.js (+ sessionPage.css from the imported globals.css)
const sessionCtx = await esbuild.context({
	entryPoints: ["src/sessionView/sessionViewEntry.tsx"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	outfile: "media/sessionPage.js",
	jsx: "automatic",
	nodePaths: [path.join(webRoot, "node_modules")],
	plugins: [sessionViewShims],
	...shared,
});

// media/highlight.js — syntax highlighting for file-change cards in the local session webview
const highlightCtx = await esbuild.context({
	entryPoints: ["src/ui/webviewHighlight.ts"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	outfile: "media/highlight.js",
	...shared,
});

if (watch) {
	await Promise.all([ctx.watch(), sessionCtx.watch(), highlightCtx.watch()]);
} else {
	await Promise.all([ctx.rebuild(), sessionCtx.rebuild(), highlightCtx.rebuild()]);
	// sql.js wasm binary for the Kronyx store
	mkdirSync("dist", { recursive: true });
	copyFileSync("node_modules/sql.js/dist/sql-wasm.wasm", "dist/sql-wasm.wasm");
	await Promise.all([ctx.dispose(), sessionCtx.dispose(), highlightCtx.dispose()]);
}
