import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const make = (entry, outfile) =>
	esbuild.context({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		outfile,
		// Native/optional-dep packages stay external — resolved at runtime.
		external: ["mongodb", "firebase-admin", "@firebase/*", "google-*", "better-sqlite3", "ioredis"],
		banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
		sourcemap: !watch,
		logLevel: "info",
	});

const ctxs = [await make("src/index.ts", "dist/index.js"), await make("src/worker/index.ts", "dist/worker.js")];

if (watch) {
	await Promise.all(ctxs.map((c) => c.watch()));
} else {
	await Promise.all(ctxs.map((c) => c.rebuild()));
	await Promise.all(ctxs.map((c) => c.dispose()));
}
