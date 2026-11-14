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
	/** Persist a durable fact (memory_write). Absent outside the extension. */
	onMemoryFact?: (fact: string) => Promise<void>;
}

export const WRITE_TOOL_NAMES = new Set([
	"write_file",
	"edit_file",
	"append_file",
	"insert_lines",
	"run_command",
	"file_editor",
	"rename_symbol",
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CMD_HEAD_CHARS = 2_000;
const CMD_TAIL_CHARS = 5_000;

/** Errors live at the tail: keep head for context, tail for the failure. */
const clampCmdOut = (out: string): string =>
	out.length <= CMD_HEAD_CHARS + CMD_TAIL_CHARS
		? out
		: `${out.slice(0, CMD_HEAD_CHARS)}\n…[${out.length - CMD_HEAD_CHARS - CMD_TAIL_CHARS} chars elided]…\n${out.slice(-CMD_TAIL_CHARS)}`;

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
		executionMode: "parallel",
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
			// Unbounded reads page at 400 lines; explicit ranges get maxReadLines.
			const page = input.end_line === undefined ? Math.min(maxReadLines, 400) : maxReadLines;
			const end = Math.min(requestedEnd, start + page - 1);
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
		executionMode: "parallel",
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
		executionMode: "parallel",
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
		executionMode: "parallel",
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
			if (!options.onMemoryFact) return "Memory is unavailable in this environment.";
			await options.onMemoryFact(input.fact);
			return "Fact recorded.";
		},
	};

	const runCommand: AgentTool<{ command: string; timeout_seconds?: number }, string> = {
		name: "run_command",
		description:
			"Run a shell command (build, test, install, etc). Executes in the configured sandbox when enabled, else in the workspace root. Returns exit code and output. " +
			"Set timeout_seconds generously for slow work — package installs, builds, test suites can take 5–20 minutes. Do NOT give up on a command just because it is slow.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run." },
				timeout_seconds: {
					type: "integer",
					minimum: 1,
					maximum: 1800,
					description:
						"Max seconds to wait (default 300, max 1800). Use a higher value for installs/builds (e.g. 600–1200), a lower one for quick checks.",
				},
			},
			required: ["command"],
		},
		async execute(input) {
			if (options.execCommand) {
				const out = await options.execCommand(input.command);
				if (out !== null) return out;
			}
			const timeout = Math.min(Math.max(input.timeout_seconds ?? 300, 1), 1800) * 1000;
			const { exec } = await import("node:child_process");
			return new Promise((resolve) => {
				exec(input.command, { cwd: options.root, timeout }, (error, stdout, stderr) => {
					const out = `${stdout}${stderr}`.trim();
					resolve(`exit ${error ? 1 : 0}\n${clampCmdOut(out)}`);
				});
			});
		},
	};

	const undoStack = new Map<string, (string | null)[]>();

	interface FileEditorInput {
		command: "view" | "create" | "str_replace" | "insert" | "undo_edit" | "symbols" | "replace_function";
		path: string;
		file_text?: string;
		old_str?: string;
		new_str?: string;
		name?: string;
		insert_line?: number;
		view_range?: [number, number];
	}

	const SYMBOL_RE =
		/^\s*(?:export\s+|async\s+|static\s+|public\s+|private\s+|protected\s+|abstract\s+|const\s+|let\s+|var\s+)*\s*(?:function\s+|async\s+function\s+|class\s+|interface\s+|type\s+|enum\s+|struct\s+|def\s+|func\s+|impl\s+|fn\s+|const\s+|let\s+|var\s+|public\s+|private\s+|func\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:\(|=|:|\{|\s*=>\s*)/;

	/** Find the declaration line index and end index of a named block (brace- or indent-scoped). */
	const findSymbolBlock = (lines: string[], name: string): { start: number; end: number } | null => {
		const decl = lines.findIndex((l) => {
			const m = l.match(SYMBOL_RE);
			return m?.[1] === name;
		});
		if (decl < 0) return null;
		const line = lines[decl];
		// Brace-scoped: count { } from decl line until balanced close.
		const braceDelta = (s: string) => s.replace(/['"`].*?['"`]/g, "").split("").reduce((n, c) => n + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
		if (line.includes("{")) {
			let depth = 0;
			for (let i = decl; i < lines.length; i++) {
				depth += braceDelta(lines[i]);
				if (depth <= 0 && i > decl) return { start: decl, end: i };
			}
			return { start: decl, end: lines.length - 1 };
		}
		// Indent-scoped (Python/YAML): ends at first non-blank line with indent ≤ decl indent.
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		let end = decl;
		for (let i = decl + 1; i < lines.length; i++) {
			const l = lines[i];
			if (l.trim() === "") { end = i; continue; }
			const ind = l.match(/^\s*/)?.[0].length ?? 0;
			if (ind <= indent) break;
			end = i;
		}
		return { start: decl, end };
	};

	const fileEditor: AgentTool<FileEditorInput, string> = {
		name: "file_editor",
		description:
			"Unified file editor. Commands: view (numbered lines, optional view_range), create (new file; fails if exists), " +
			"str_replace (exact unique match old_str→new_str), insert (new_str after insert_line), undo_edit (restore last write), " +
			"symbols (list function/class/type declarations with line numbers), replace_function (replace a named function/class block with new_str). " +
			"Prefer this over raw edit_file for structured edits.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", enum: ["view", "create", "str_replace", "insert", "undo_edit", "symbols", "replace_function"] },
				path: { type: "string", description: "Path relative to workspace root." },
				file_text: { type: "string", description: "Full content for create." },
				old_str: { type: "string", description: "Exact text to replace (str_replace)." },
				new_str: { type: "string", description: "Replacement text (str_replace/insert/replace_function)." },
				name: { type: "string", description: "Symbol name (replace_function)." },
				insert_line: { type: "integer", description: "Insert after this line (1-based; 0 = top of file)." },
				view_range: { type: "array", items: { type: "integer" }, description: "[start, end] line range (view)." },
			},
			required: ["command", "path"],
		},
		async execute(input) {
			const abs = guard.resolve(input.path);
			const cmd = input.command;
			const snapshot = async () => {
				const stack = undoStack.get(abs) ?? [];
				stack.push((await exists(abs)) ? await readText(abs) : null);
				undoStack.set(abs, stack);
			};
			switch (cmd) {
				case "view": {
					const text = normalizeEol(await readText(abs));
					const lines = text.split("\n");
					const [s, e] = input.view_range ?? [1, lines.length];
					const start = Math.max(1, s);
					const end = Math.min(lines.length, e);
					return lines
						.slice(start - 1, end)
						.map((l, i) => `${start + i}| ${l}`)
						.join("\n");
				}
				case "symbols": {
					const lines = normalizeEol(await readText(abs)).split("\n");
					const out: string[] = [];
					lines.forEach((l, i) => {
						const m = l.match(SYMBOL_RE);
						if (m?.[1] && !/^(if|for|while|return|new|else|switch|catch|await|yield|import|from)$/.test(m[1]))
							out.push(`${i + 1}| ${l.trim().slice(0, 120)}`);
					});
					return out.length ? out.join("\n") : "No declarations found.";
				}
				case "create": {
					if (await exists(abs)) throw new Error(`${guard.relative(abs)} already exists. Use str_replace to modify it.`);
					assertWritable(abs);
					await snapshot();
					await writeText(abs, normalizeEol(input.file_text ?? ""));
					return `Created ${guard.relative(abs)}`;
				}
				case "str_replace": {
					const text = normalizeEol(await readText(abs));
					const oldText = normalizeEol(input.old_str ?? "");
					if (!oldText) throw new Error("old_str is empty.");
					const matches = findMatches(text, oldText);
					if (matches.length === 0)
						throw new Error(
							noMatchMessage("str_replace", guard.relative(abs), text, oldText) +
								` Next: view the region, retry with exact text; or replace_function "${input.name ?? "<name>"}" for a whole-function swap; or write_file for a full rewrite.`,
						);
					if (matches.length > 1 && matches[0].strategy === "exact")
						throw new Error(
							`old_str matched ${matches.length} locations — add more surrounding context, or split into separate str_replace calls.`,
						);
					const match = matches[0];
					const newText = normalizeEol(input.new_str ?? "");
					const replacement = match.strategy === "exact" ? newText : adaptIndentation(text.slice(match.start, match.end), oldText, newText);
					assertWritable(abs);
					await snapshot();
					await writeText(abs, text.slice(0, match.start) + replacement + text.slice(match.end));
					return `Edited ${guard.relative(abs)} (lines ${lineNumberAt(text, match.start)}+).`;
				}
				case "insert": {
					const text = normalizeEol(await readText(abs));
					const lines = text.split("\n");
					const at = Math.max(0, Math.min(lines.length, input.insert_line ?? lines.length));
					assertWritable(abs);
					await snapshot();
					lines.splice(at, 0, ...(input.new_str ?? "").split("\n"));
					await writeText(abs, lines.join("\n"));
					return `Inserted after line ${at} in ${guard.relative(abs)}`;
				}
				case "replace_function": {
					const text = normalizeEol(await readText(abs));
					const lines = text.split("\n");
					const block = findSymbolBlock(lines, input.name ?? "");
					if (!block)
						throw new Error(
							`No declaration named "${input.name}" in ${guard.relative(abs)} — run file_editor symbols to list declarations, or fall back to str_replace with the exact text.`,
						);
					assertWritable(abs);
					await snapshot();
					const indent = lines[block.start].match(/^\s*/)?.[0] ?? "";
					const replacement = (input.new_str ?? "")
						.split("\n")
						.map((l) => (l.trim() ? indent + l.replace(/^\s+/, "") : l))
						.join("\n");
					lines.splice(block.start, block.end - block.start + 1, replacement);
					await writeText(abs, lines.join("\n"));
					return `Replaced ${input.name} (lines ${block.start + 1}-${block.end + 1}) in ${guard.relative(abs)}`;
				}
				case "undo_edit": {
					const stack = undoStack.get(abs);
					if (!stack?.length) throw new Error(`Nothing to undo for ${guard.relative(abs)}.`);
					const prev = stack.pop()!;
					assertWritable(abs);
					if (prev === null) {
						await fs.rm(abs, { force: true });
						options.onFileChanged?.(abs, "modified", { added: 0, removed: 0, diff: "" });
						return `Undid creation of ${guard.relative(abs)}`;
					}
					await writeText(abs, prev);
					return `Undid last edit in ${guard.relative(abs)}`;
				}
				default:
					throw new Error(`Unknown command "${cmd}"`);
			}
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

	const plansDir = (): string => path.join(options.root, (options.planDir?.() ?? ".kronyx/plans").replace(/\/+$/, ""));
	const listPlans: AgentTool<Record<string, never>, string> = {
		name: "list_plans",
		description: "List plans saved earlier — slugs, one per line. Read one with read_plan.",
		inputSchema: { type: "object", properties: {} },
		async execute() {
			const names = await fs.readdir(plansDir()).catch(() => [] as string[]);
			const slugs = names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3));
			return slugs.length ? slugs.join("\n") : "No saved plans.";
		},
	};
	const readPlan: AgentTool<{ slug: string }, string> = {
		name: "read_plan",
		description: "Read a plan saved earlier (see list_plans for slugs). Returns the plan markdown.",
		inputSchema: {
			type: "object",
			properties: { slug: { type: "string", description: "Plan slug, e.g. from list_plans." } },
			required: ["slug"],
		},
		async execute(input) {
			const slug = String(input.slug ?? "").replace(/[^\w-]+/g, "-").slice(0, 60);
			if (!slug) return "read_plan: a slug is required.";
			const content = await fs.readFile(path.join(plansDir(), `${slug}.md`), "utf8").catch(() => null);
			return content ?? `No plan named "${slug}".`;
		},
	};

	return [readFile, writeFile, editFile, appendFile, insertLines, listFiles, searchFiles, memoryWrite, runCommand, fileEditor, savePlan, listPlans, readPlan];
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
