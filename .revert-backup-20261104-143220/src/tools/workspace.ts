import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";

export const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"out",
	"build",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".turbo",
	"coverage",
]);

export class WorkspaceGuard {
	readonly root: string;

	constructor(root: string) {
		this.root = realpathSync(path.resolve(root));
	}

	resolve(input: string): string {
		if (!input || typeof input !== "string") {
			throw new Error("A file path is required.");
		}
		const abs = path.resolve(this.root, input);
		this.assertInside(abs, input);
		this.assertInside(realpathSync(nearestExistingAncestor(abs)), input);
		return abs;
	}

	relative(abs: string): string {
		return path.relative(this.root, abs).split(path.sep).join("/") || ".";
	}

	private assertInside(abs: string, input: string): void {
		const rel = path.relative(this.root, abs);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`Path is outside the workspace: ${input}`);
		}
	}
}

function nearestExistingAncestor(abs: string): string {
	let current = abs;
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return current;
}
