import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@cline/shared";
import { computeHunks, formatHunks } from "../diff/hunks";
import { adaptIndentation, findMatches, lineNumberAt, mostSimilarRegion } from "./matching";
import { IGNORED_DIRS, WorkspaceGuard } from "./workspace";

export type FileChangeKind = "created" | "modified";

export interface FileToolOptions {
	root: string;
	/** Returns true when the file has unsaved changes in the editor. */
	isDirty?: (absPath: string) => boolean;
	onFileChanged?: (absPath: string, kind: FileChangeKind, stats?: { added: number; removed: number; diff: string }) => void;
	/** Called once before the first write to a file, with its prior content (null for new files). */
	onBeforeWrite?: (absPath: string, before: string | null) => void;
	/** Executes a shell command; return null to fall back to local execution in root. */
	execCommand?: (command: string) => Promise<string | null>;
	planDir?: () => string;
	maxReadLines?: number;
}

export const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "append_file", "insert_lines", "run_command"]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface EditInput {
	old_text: string;
	new_text: string;
	replace_all?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: tool inputs vary per tool
export function createFileTools(options: FileToolOptions): AgentTool<any, string>[] {
	const guard = new WorkspaceGuard(options.root);
	const maxReadLines = options.maxReadLines ?? 2000;

	const assertWritable = (abs: string) => {
		if (options.isDirty?.(abs)) {
			throw new Error(
				`${guard.relative(abs)} has unsaved changes in the editor. Ask the user to save or revert it first.`,
			);
		}
	};

	const readText = async (abs: string): Promise<string> => {
		const stat = await fs.stat(abs).catch(() => undefined);
		if (!stat) throw new Error(`File not found: ${guard.relative(abs)}`);
		if (stat.isDirectory()) throw new Error(`${guard.relative(abs)} is a directory. Use list_files.`);
		if (stat.size > MAX_FILE_BYTES) throw new Error(`${guard.relative(abs)} is larger than 2 MB.`);
		const buffer = await fs.readFile(abs);
		if (buffer.includes(0)) throw new Error(`${guard.relative(abs)} looks like a binary file.`);
		return buffer.toString("utf8");
	};

	const writeText = async (abs: string, text: string) => {
		const existed = await exists(abs);
		let before: string | null = null;
		if (options.onBeforeWrite || options.onFileChanged) {
			before = existed ? (await fs.readFile(abs)).toString("utf8") : null;
		}
		if (options.onBeforeWrite) options.onBeforeWrite(abs, before);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, text, "utf8");
		if (options.onFileChanged) {
			let added = 0;
			let removed = 0;
			const hunks = computeHunks(before ?? "", text);
			for (const hunk of hunks) {
				added += hunk.newLines.length;
				removed += hunk.oldLines.length;
			}
			options.onFileChanged(abs, existed ? "modified" : "created", {
				added,
				removed,
				diff: formatHunks(hunks),
			});
		}
		return existed;
	};

	const readFile: AgentTool<{ path: string; start_line?: number; end_line?: number }, string> = {
		name: "read_file",
		description:
			"Read a text file from the workspace. Returns lines prefixed with their line number and a '|' separator. " +
			"The prefix is not part of the file: never include it in edit_file old_text. Use start_line/end_line for large files.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path relative to the workspace root." },
				start_line: { type: "integer", minimum: 1, description: "First line to return (1-based)." },
				end_line: { type: "integer", minimum: 1, description: "Last line to return (inclusive)." },
			},
			required: ["path"],
		},
		async execute(input) {
			const abs = guard.resolve(input.path);
			const text = normalizeEol(await readText(abs));
			const lines = text.split("\n");
			if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
			const start = Math.max(1, input.start_line ?? 1);
			const requestedEnd = Math.min(lines.length, input.end_line ?? lines.length);
			const end = Math.min(requestedEnd, start + maxReadLines - 1);
			const width = String(end).length;
			const body = lines
				.slice(start - 1, end)
				.map((line, i) => `${String(start + i).padStart(width)}| ${line}`)
				.join("\n");
			const more = end < lines.length ? ` More lines follow; call again with start_line=${end + 1}.` : "";
			return `${guard.relative(abs)} (lines ${start}-${end} of ${lines.length}).${more}\n${body}`;
		},
	};

	const writeFile: AgentTool<{ path: string; content: string }, string> = {
		name: "write_file",
		description:
			"Create a new file or completely replace an existing one. Prefer edit_file for changes to existing files.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path relative to the workspace root." },
				content: { type: "string", description: "The full file content." },
			},
			required: ["path", "content"],
		},
		async execute(input) {
			const abs = guard.resolve(input.path);
			assertWritable(abs);
			const existed = await writeText(abs, input.content);
			return `${existed ? "Overwrote" : "Created"} ${guard.relative(abs)} (${countLines(input.content)} lines).`;
		},
	};

	const editFile: AgentTool<{ path: string; edits: EditInput[] }, string> = {
		name: "edit_file",
		description:
			"Edit an existing file by replacing text. Each edit's old_text must match the file (copy it from read_file without the line-number prefix) " +
			"and should include enough surrounding lines to be unique. Indentation and whitespace differences are tolerated. " +
			"Edits are applied in order and all-or-nothing.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path relative to the workspace root." },
				edits: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						properties: {
							old_text: { type: "string", description: "Existing text to replace." },
							new_text: { type: "string", description: "Replacement text." },
							replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
						},
						required: ["old_text", "new_text"],
					},
				},
			},
			required: ["path", "edits"],
		},
		async execute(input) {
			const abs = guard.resolve(input.path);
			assertWritable(abs);
			const original = await readText(abs);
			const eol = original.includes("\r\n") ? "\r\n" : "\n";
			let text = normalizeEol(original);
			const report: string[] = [];

			input.edits.forEach((edit, index) => {
				const label = `Edit ${index + 1}`;
				const oldText = normalizeEol(edit.old_text ?? "");
				const newText = normalizeEol(edit.new_text ?? "");
				if (oldText.trim() === "") throw new Error(`${label}: old_text is empty. Use insert_lines or append_file to add text.`);
				const matches = findMatches(text, oldText);
				if (matches.length === 0) throw new Error(noMatchMessage(label, guard.relative(abs), text, oldText));
				if (matches.length > 1 && !edit.replace_all) {
					const lines = matches.map((m) => lineNumberAt(text, m.start)).join(", ");
					throw new Error(
						`${label}: old_text matches ${matches.length} places (lines ${lines}). Add surrounding lines to make it unique, or set replace_all.`,
					);
				}
				const firstLine = lineNumberAt(text, matches[0].start);
				for (const match of [...matches].reverse()) {
					const replacement =
						match.strategy === "exact" ? newText : adaptIndentation(text.slice(match.start, match.end), oldText, newText);
					text = text.slice(0, match.start) + replacement + text.slice(match.end);
				}
				report.push(`${label}: replaced ${matches.length} match(es) at line ${firstLine} (${matches[0].strategy}).`);
			});

			await writeText(abs, eol === "\n" ? text : text.replace(/\n/g, "\r\n"));
			return `Edited ${guard.relative(abs)}.\n${report.join("\n")}`;
		},
	};

	const appendFile: AgentTool<{ path: string; content: string }, string> = {
		name: "append_file",
		description: "Append text to the end of a file. Creates the file when it does not exist.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path relative to the workspace root." },
				content: { type: "string", description: "Text to append." },
			},
			required: ["path", "content"],
		},
		async execute(input) {
			const abs = guard.resolve(input.path);
			assertWritable(abs);
			const current = (await exists(abs)) ? await readText(abs) : "";
			const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
			await writeText(abs, current + separator + input.content);
			return `Appended ${countLines(input.content)} line(s) to ${guard.relative(abs)}.`;
		},
	};

	const insertLines: AgentTool<{ path: string; line: number; content: string }, string> = {
		name: "insert_lines",
		description:
			"Insert text before the given 1-based line number. Use line = (number of lines + 1) to insert at the end.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path relative to the workspace root." },
				line: { type: "integer", minimum: 1, description: "Line number to insert before." },
				content: { type: "string", description: "Text to insert." },
			},
			required: ["path", "line", "content"],
		},
		async execute(input) {
			const abs = guard.resolve(input.path);
			assertWritable(abs);
			const original = await readText(abs);
			const eol = original.includes("\r\n") ? "\r\n" : "\n";
			const lines = normalizeEol(original).split("\n");
			const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
			if (trailingNewline) lines.pop();
			if (input.line > lines.length + 1) {
				throw new Error(`Line ${input.line} is past the end of the file (${lines.length} lines).`);
			}
			const inserted = normalizeEol(input.content).replace(/\n$/, "").split("\n");
			lines.splice(input.line - 1, 0, ...inserted);
			const text = lines.join("\n") + (trailingNewline ? "\n" : "");
			await writeText(abs, eol === "\n" ? text : text.replace(/\n/g, "\r\n"));
			return `Inserted ${inserted.length} line(s) at line ${input.line} of ${guard.relative(abs)}.`;
		},
	};

	const listFiles: AgentTool<{ path?: string; recursive?: boolean; max_entries?: number }, string> = {
		name: "list_files",
		description: "List files and folders. Folders end with '/'. Skips .git, node_modules and build output.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Folder relative to the workspace root. Defaults to the root." },
				recursive: { type: "boolean", description: "List sub-folders too. Defaults to false." },
				max_entries: { type: "integer", minimum: 1, description: "Maximum entries to return. Defaults to 500." },
			},
		},
		async execute(input) {
			const abs = guard.resolve(input.path ?? ".");
			const limit = input.max_entries ?? 500;
			const entries: string[] = [];
			let truncated = false;
			for await (const entry of walk(abs, input.recursive ?? false)) {
				if (entries.length >= limit) {
					truncated = true;
					break;
				}
				entries.push(guard.relative(entry.path) + (entry.dir ? "/" : ""));
			}
			if (entries.length === 0) return `${guard.relative(abs)} is empty.`;
			return entries.join("\n") + (truncated ? `\n... truncated at ${limit} entries.` : "");
		},
	};

	const searchFiles: AgentTool<
		{ pattern: string; path?: string; regex?: boolean; file_glob?: string; max_results?: number },
		string
	> = {
		name: "search_files",
		description: "Search file contents. Returns matching lines as path:line: text.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Text or regular expression to find." },
				path: { type: "string", description: "Folder to search, relative to the root. Defaults to the root." },
				regex: { type: "boolean", description: "Treat pattern as a regular expression. Defaults to false." },
				file_glob: { type: "string", description: "Only search files whose path matches this glob, e.g. '**/*.ts'." },
				max_results: { type: "integer", minimum: 1, description: "Maximum matches. Defaults to 100." },
			},
			required: ["pattern"],
		},
		async execute(input) {
			const abs = guard.resolve(input.path ?? ".");
			const matcher = input.regex ? new RegExp(input.pattern) : undefined;
			const glob = input.file_glob ? globToRegExp(input.file_glob) : undefined;
			const limit = input.max_results ?? 100;
			const results: string[] = [];
			for await (const entry of walk(abs, true)) {
				if (entry.dir) continue;
				const rel = guard.relative(entry.path);
				if (glob && !glob.test(rel)) continue;
				const stat = await fs.stat(entry.path);
				if (stat.size > MAX_FILE_BYTES) continue;
				const buffer = await fs.readFile(entry.path);
				if (buffer.includes(0)) continue;
				const lines = normalizeEol(buffer.toString("utf8")).split("\n");
				for (let i = 0; i < lines.length; i++) {
					const hit = matcher ? matcher.test(lines[i]) : lines[i].includes(input.pattern);
					if (!hit) continue;
					results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
					if (results.length >= limit) return `${results.join("\n")}\n... stopped at ${limit} matches.`;
				}
			}
			return results.length > 0 ? results.join("\n") : "No matches.";
		},
	};

	const memoryWrite: AgentTool<{ fact: string }, string> = {
		name: "memory_write",
		description:
			"Record a durable fact about this project for future runs (build/test commands, conventions, gotchas). Appends to .kronyx/memory/facts.md.",
		inputSchema: {
			type: "object",
			properties: {
				fact: { type: "string", description: "One concise fact to remember." },
			},
			required: ["fact"],
		},
		async execute(input) {
			const { appendFact } = await import("../agent/memory");
			await appendFact(options.root, input.fact);
			return "Fact recorded.";
		},
	};

	const runCommand: AgentTool<{ command: string }, string> = {
		name: "run_command",
		description:
			"Run a shell command (build, test, install, etc). Executes in the configured sandbox when enabled, else in the workspace root. Returns exit code and output.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run." },
			},
			required: ["command"],
		},
		async execute(input) {
			if (options.execCommand) {
				const out = await options.execCommand(input.command);
				if (out !== null) return out;
			}
			const { exec } = await import("node:child_process");
			return new Promise((resolve) => {
				exec(input.command, { cwd: options.root, timeout: 60_000 }, (error, stdout, stderr) => {
					const out = `${stdout}${stderr}`.trim();
					resolve(`exit ${error ? 1 : 0}\n${out.length > 8000 ? `${out.slice(0, 8000)}\n... (truncated)` : out}`);
				});
			});
		},
	};

	const savePlan: AgentTool<{ content: string; slug?: string }, string> = {
		name: "save_plan",
		description:
			"Save the implementation plan to .kronyx/plans/<slug>.md. Only usable in Plan mode. Ends the planning phase — the user reviews the plan and starts implementation.",
		inputSchema: {
			type: "object",
			properties: {
				content: { type: "string", description: "The plan as markdown: summary, numbered steps, files to modify, verification." },
				slug: { type: "string", description: "Optional filename slug for the plan file (no extension)." },
			},
			required: ["content"],
		},
		async execute(input) {
			const slug = (input.slug || "plan").replace(/[^\w-]+/g, "-").slice(0, 60) || "plan";
			const rel = `${(options.planDir?.() ?? ".kronyx/plans").replace(/\/+$/, "")}/${slug}.md`;
			const abs = path.join(options.root, rel);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, input.content, "utf8");
			options.onFileChanged?.(abs, (await exists(abs)) ? "modified" : "created", { added: 0, removed: 0, diff: "" });
			return `Plan saved to ${rel}`;
		},
	};

	return [readFile, writeFile, editFile, appendFile, insertLines, listFiles, searchFiles, memoryWrite, runCommand, savePlan];
}

function noMatchMessage(label: string, file: string, text: string, oldText: string): string {
	const region = mostSimilarRegion(text, oldText);
	let message = `${label}: old_text was not found in ${file}.`;
	if (region && region.score > 0.5) {
		const numbered = region.text
			.split("\n")
			.map((line, i) => `${region.startLine + i}| ${line}`)
			.join("\n");
		message += ` The most similar text (${Math.round(region.score * 100)}% similar) is:\n${numbered}\nRe-read the file and copy old_text exactly, without line numbers.`;
	} else {
		message += " Re-read the file with read_file before editing.";
	}
	return message;
}

async function* walk(dir: string, recursive: boolean): AsyncGenerator<{ path: string; dir: boolean }> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => {
		throw new Error(`Folder not found: ${dir}`);
	});
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		yield { path: full, dir: entry.isDirectory() };
		if (recursive && entry.isDirectory()) yield* walk(full, true);
	}
}

export function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
			i += glob[i + 2] === "/" ? 2 : 1;
		} else if (c === "*") source += "[^/]*";
		else if (c === "?") source += "[^/]";
		else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

function normalizeEol(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.replace(/\n$/, "").split("\n").length;
}

async function exists(p: string): Promise<boolean> {
	return fs
		.stat(p)
		.then(() => true)
		.catch(() => false);
}
