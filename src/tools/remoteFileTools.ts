import type { AgentTool } from "@cline/shared";
import type { SandboxHandle } from "../sandbox/provider";
import { adaptIndentation, findMatches, mostSimilarRegion } from "./matching";

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

export interface RemoteToolOptions {
	/** Absolute directory for save_plan output; defaults to "<workdir>/.kronyx/plans". */
	planDir?: string;
	/** Live stdout/stderr chunks from the run_command tool (UI streaming). */
	onCommandOutput?: (chunk: string) => void;
}

/**
 * File tools that execute inside a remote sandbox: reads/writes via the
 * provider handle, edits by fetching the file and applying the local
 * matching engine.
 */
export function createRemoteFileTools(sandbox: SandboxHandle, workdir: string, opts: RemoteToolOptions = {}): AgentTool<any, string>[] {
	const run = (command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
		sandbox.run(command, { cwd: workdir, timeoutMs: 60_000 });

	// Agents sometimes pass absolute paths — resolve them instead of
	// double-prefixing workdir ("/home/user/repo//home/user/repo/x" → 404).
	const abs = (rel: string): string => (rel.startsWith("/") ? rel : `${workdir}/${rel}`);

	const readText = async (rel: string): Promise<string> => {
		const content = await sandbox.readFile(abs(rel)).catch(() => {
			throw new Error(`File not found or unreadable: ${rel}`);
		});
		if (content.length > MAX_FILE_BYTES) throw new Error(`${rel} is larger than 2 MB.`);
		return content.replace(/\r\n/g, "\n");
	};

	const writeText = async (rel: string, text: string): Promise<boolean> => {
		const existed = await exists(rel);
		await sandbox.writeFile(abs(rel), text);
		return existed;
	};

	const exists = async (rel: string): Promise<boolean> => {
		const r = await run(`test -e "${abs(rel)}"`);
		return r.exitCode === 0;
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
			const lines = (await readText(input.path)).split("\n");
			if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
			const start = Math.max(1, input.start_line ?? 1);
			const requestedEnd = Math.min(lines.length, input.end_line ?? lines.length);
			// Unbounded reads page at 400 lines; explicit ranges get up to 2000.
			const page = input.end_line === undefined ? 399 : 1999;
			const end = Math.min(requestedEnd, start + page);
			const width = String(end).length;
			const body = lines
				.slice(start - 1, end)
				.map((line, i) => `${String(start + i).padStart(width)}| ${line}`)
				.join("\n");
			const more = end < lines.length ? ` More lines follow; call again with start_line=${end + 1}.` : "";
			return `${input.path} (lines ${start}-${end} of ${lines.length}).${more}\n${body}`;
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
			const existed = await writeText(input.path, input.content);
			return `${existed ? "Overwrote" : "Created"} ${input.path} (${input.content.split("\n").length} lines).`;
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
			const original = await readText(input.path);
			const eol = original.includes("\r\n") ? "\r\n" : "\n";
			let text = original.replace(/\r\n/g, "\n");
			const report: string[] = [];
			input.edits.forEach((edit, index) => {
				const label = `Edit ${index + 1}`;
				const oldText = (edit.old_text ?? "").replace(/\r\n/g, "\n");
				const newText = (edit.new_text ?? "").replace(/\r\n/g, "\n");
				if (oldText.trim() === "") throw new Error(`${label}: old_text is empty.`);
				const matches = findMatches(text, oldText);
				if (matches.length === 0) {
					const region = mostSimilarRegion(text, oldText);
					throw new Error(
						`${label}: old_text was not found in ${input.path}.` +
							(region && region.score > 0.5 ? ` Most similar text (${Math.round(region.score * 100)}%) is at line ${region.startLine}. Re-read the file.` : " Re-read the file with read_file."),
					);
				}
				if (matches.length > 1 && !edit.replace_all) {
					throw new Error(`${label}: old_text matches ${matches.length} places. Add surrounding lines to make it unique, or set replace_all.`);
				}
				for (const match of [...matches].reverse()) {
					const replacement =
						match.strategy === "exact" ? newText : adaptIndentation(text.slice(match.start, match.end), oldText, newText);
					text = text.slice(0, match.start) + replacement + text.slice(match.end);
				}
				report.push(`${label}: replaced ${matches.length} match(es).`);
			});
			await writeText(input.path, eol === "\n" ? text : text.replace(/\n/g, "\r\n"));
			return `Edited ${input.path}.\n${report.join("\n")}`;
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
			const current = (await exists(input.path)) ? await readText(input.path) : "";
			const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
			await writeText(input.path, current + sep + input.content);
			return `Appended to ${input.path}.`;
		},
	};

	const insertLines: AgentTool<{ path: string; line: number; content: string }, string> = {
		name: "insert_lines",
		description: "Insert text before the given 1-based line number.",
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
			const original = await readText(input.path);
			const lines = original.split("\n");
			const trailing = lines.length > 1 && lines[lines.length - 1] === "";
			if (trailing) lines.pop();
			if (input.line > lines.length + 1) throw new Error(`Line ${input.line} is past the end (${lines.length} lines).`);
			const inserted = input.content.replace(/\n$/, "").split("\n");
			lines.splice(input.line - 1, 0, ...inserted);
			await writeText(input.path, lines.join("\n") + (trailing ? "\n" : ""));
			return `Inserted ${inserted.length} line(s) at line ${input.line} of ${input.path}.`;
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
			const depth = input.recursive ? "" : " -maxdepth 1";
			const limit = input.max_entries ?? 500;
			// One round trip: -printf marks dirs with a trailing slash.
			const r = await run(
				`find "${input.path ?? "."}"${depth} \\( -name .git -o -name node_modules -o -name dist \\) -prune -o \\( -type d -printf '%p/\\n' -o -type f -print \\) | head -${limit}`,
			);
			if (r.exitCode !== 0 && !r.stdout.trim()) {
				return `Error listing files: ${(r.stderr || `exit ${r.exitCode}`).slice(0, 300)}`;
			}
			const lines = r.stdout
				.split("\n")
				.filter((l) => l && l !== input.path && l !== `${input.path}/`)
				.map((l) => l.replace(/^\.\//, ""));
			return lines.slice(0, limit).join("\n") || "Empty.";
		},
	};

	const searchFiles: AgentTool<{ pattern: string; path?: string; file_glob?: string; max_results?: number }, string> = {
		name: "search_files",
		executionMode: "parallel",
		description: "Search file contents. Returns matching lines as path:line: text.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Text or regular expression to find." },
				path: { type: "string", description: "Folder to search, relative to the root. Defaults to the root." },
				file_glob: { type: "string", description: "Only search files matching this glob, e.g. '**/*.ts'." },
				max_results: { type: "integer", minimum: 1, description: "Maximum matches. Defaults to 100." },
			},
			required: ["pattern"],
		},
		async execute(input) {
			const dir = input.path ?? ".";
			const glob = input.file_glob ? `--include='${input.file_glob.replace(/\*\*\//, "")}'` : "";
			const limit = input.max_results ?? 100;
			const r = await run(
				`grep -rIn ${glob} --exclude-dir=.git --exclude-dir=node_modules -- ${JSON.stringify(input.pattern)} "${dir}" 2>/dev/null | head -${limit}`,
			);
			// grep exits 1 on no matches; >1 means a real error (missing dir, bad flags).
			if (r.exitCode > 1) return `Error searching: ${(r.stderr || `exit ${r.exitCode}`).slice(0, 300)}`;
			const out = r.stdout
				.split("\n")
				.filter(Boolean)
				.map((l) => l.replace(/^\.\//, "").slice(0, 300));
			return out.length > 0 ? out.join("\n") : "No matches.";
		},
	};

	const runCommand: AgentTool<{ command: string; timeout_seconds?: number }, string> = {
		name: "run_command",
		description:
			"Run a shell command in the cloud workspace (build, test, install, git). Returns exit code and output. " +
			"The command keeps running while the tool polls it — set timeout_seconds generously for installs/builds/test suites (they can take 5–30 minutes). Do NOT give up on a command just because it is slow.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run." },
				timeout_seconds: {
					type: "integer",
					minimum: 1,
					maximum: 3600,
					description:
						"Total seconds to wait before killing the command (default 1800, max 3600). Short for quick checks, 600–1800 for installs/builds.",
				},
			},
			required: ["command"],
		},
		async execute(input) {
			// Detached execution + polling: a single blocking run() hits the
			// provider's request deadline on long commands. The command runs in
			// its own session writing to a log + exit file; we poll every 10s,
			// stream new output live, and only kill at the real deadline.
			const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
			const base = `/tmp/kronyx-cmd-${stamp}`;
			const script = `${base}.sh`, logF = `${base}.log`, exitF = `${base}.exit`, pidF = `${base}.pid`;
			await sandbox.writeFile(
				script,
				`#!/bin/bash\necho $$ > ${JSON.stringify(pidF)}\ncd ${JSON.stringify(workdir)}\n{ ${input.command}\n} > ${JSON.stringify(logF)} 2>&1\necho $? > ${JSON.stringify(exitF)}\n`,
			);
			await sandbox.run(`setsid bash ${JSON.stringify(script)} >/dev/null 2>&1 < /dev/null &`, { cwd: "/", timeoutMs: 15_000 });
			const budgetMs = Math.min(Math.max(input.timeout_seconds ?? 1800, 1), 3600) * 1000;
			const deadline = Date.now() + budgetMs;
			const poll = (cmd: string) => sandbox.run(cmd, { cwd: "/", timeoutMs: 15_000 }).catch(() => null);
			// Tail-biased fetch for oversized logs — the failure is at the end.
			const fetchLog = async (size: number): Promise<string> => {
				if (size <= 16_000) return (await poll(`head -c 16000 ${JSON.stringify(logF)}`))?.stdout ?? "";
				const [head, tail] = await Promise.all([
					poll(`head -c 2000 ${JSON.stringify(logF)}`),
					poll(`tail -c 14000 ${JSON.stringify(logF)}`),
				]);
				return `${head?.stdout ?? ""}\n…[log truncated]…\n${tail?.stdout ?? ""}`;
			};
			let offset = 0;
			for (;;) {
				await new Promise((r) => setTimeout(r, 10_000));
				const state = await poll(`cat ${JSON.stringify(exitF)} 2>/dev/null; echo __SIZE__; stat -c %s ${JSON.stringify(logF)} 2>/dev/null || echo 0`);
				const [exitCode = "", , sizeS = "0"] = (state?.stdout ?? "\n__SIZE__\n0").split("\n");
				const size = Number(sizeS) || 0;
				if (size > offset) {
					const chunk = await poll(`tail -c +${offset + 1} ${JSON.stringify(logF)} | head -c 20000`);
					if (chunk?.stdout) opts.onCommandOutput?.(chunk.stdout);
					offset = size;
				}
				if (exitCode.trim() !== "") {
					const log = await fetchLog(size);
					await poll(`rm -f ${JSON.stringify(base)}.*`);
					return `exit ${exitCode.trim()}\n${clampCmdOut(log.trim())}`;
				}
				if (Date.now() > deadline) {
					// setsid made the script a process-group leader — kill the group.
					await poll(`kill -TERM -- -$(cat ${JSON.stringify(pidF)} 2>/dev/null) 2>/dev/null; sleep 1; kill -KILL -- -$(cat ${JSON.stringify(pidF)} 2>/dev/null) 2>/dev/null`);
					const log = await fetchLog(size);
					await poll(`rm -f ${JSON.stringify(base)}.*`);
					return `timeout after ${Math.round(budgetMs / 1000)}s (killed)\n${clampCmdOut(log.trim())}`;
				}
			}
		},
	};

	const savePlan: AgentTool<{ slug: string; plan: string }, string> = {
		name: "save_plan",
		description:
			"Save the implementation plan to <planDir>/<slug>.md. Only usable in Plan mode. Ends the planning phase — the user reviews the plan and starts implementation.",
		inputSchema: {
			type: "object",
			properties: {
				slug: { type: "string", description: "Short kebab-case file name (no extension)." },
				plan: { type: "string", description: "The full plan as markdown." },
			},
			required: ["slug", "plan"],
		},
		async execute(input) {
			const slug = String(input.slug || "plan").replace(/[^\w-]+/g, "-").slice(0, 60) || "plan";
			const dir = (opts.planDir ?? `${workdir}/.kronyx/plans`).replace(/\/+$/, "");
			await sandbox.run(`mkdir -p ${JSON.stringify(dir)}`, { cwd: workdir });
			await sandbox.writeFile(`${dir}/${slug}.md`, input.plan);
			return `Saved plan to ${dir}/${slug}.md — share it with the user and stop.`;
		},
	};

	return [readFile, writeFile, editFile, appendFile, insertLines, listFiles, searchFiles, runCommand, savePlan];
}
