/**
 * read_files on the harness path (vscode-free). One call reads several files —
 * for models that emit a single tool call per turn, this turns N serial read
 * round-trips into one. Fans out to the wrapped port's read_file, so permission
 * checks and hidden-mode filtering apply per file. Output is capped per file
 * and in total; anything elided is recoverable through the session log.
 */

import type { ToolPort, ToolResult, ToolSpec } from "./contracts";

export const READ_FILES = "read_files";
const MAX_FILES = 8;
const CONCURRENCY = 4;
const PER_FILE_CAP = 6000;
const TOTAL_CAP = 30000;

const SPEC: ToolSpec = {
	name: READ_FILES,
	description:
		"Read several files in one call. Preferred over repeated read_file calls: pass an array of {path, start_line?, end_line?} (max 8). Each section is capped; use read_file for a single file or a large range.",
	inputSchema: {
		type: "object",
		properties: {
			files: {
				type: "array",
				maxItems: MAX_FILES,
				items: {
					type: "object",
					properties: {
						path: { type: "string", description: "Path relative to the workspace root." },
						start_line: { type: "integer", minimum: 1 },
						end_line: { type: "integer", minimum: 1 },
					},
					required: ["path"],
				},
			},
		},
		required: ["files"],
	},
	parallel: true,
};

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text);

interface FileRequest {
	path: string;
	start_line?: number;
	end_line?: number;
}

export function withBatchReads(base: ToolPort): ToolPort {
	const offersRead = () => base.specs().some((s) => s.name === "read_file");
	return {
		specs: () => {
			const offered = base.specs().filter((s) => s.name !== READ_FILES);
			return offersRead() ? [...offered, SPEC] : offered;
		},
		async execute(name, input): Promise<ToolResult> {
			if (name !== READ_FILES) return base.execute(name, input);
			if (!offersRead()) return { ok: false, output: "read_files is unavailable: read_file is not offered in this run." };
			const files = (input as { files?: unknown } | null)?.files;
			if (!Array.isArray(files) || files.length === 0) return { ok: false, output: "read_files needs a non-empty files array." };
			const requests: FileRequest[] = [];
			for (const f of files.slice(0, MAX_FILES)) {
				const r = f as FileRequest | null;
				if (r && typeof r.path === "string" && r.path) {
					requests.push({
						path: r.path,
						...(Number.isInteger(r.start_line) ? { start_line: r.start_line } : {}),
						...(Number.isInteger(r.end_line) ? { end_line: r.end_line } : {}),
					});
				}
			}
			if (!requests.length) return { ok: false, output: "read_files needs entries with a path string." };
			const results: ToolResult[] = new Array(requests.length);
			let next = 0;
			await Promise.all(
				Array.from({ length: Math.min(CONCURRENCY, requests.length) }, async () => {
					while (next < requests.length) {
						const i = next++;
						const req = requests[i]!;
						try {
							results[i] = await base.execute("read_file", req);
						} catch (err) {
							results[i] = { ok: false, output: `tool error: ${err instanceof Error ? err.message : String(err)}` };
						}
					}
				}),
			);
			const sections = requests.map((req, i) => {
				const r = results[i]!;
				const body = cap(r.output, PER_FILE_CAP);
				return `### ${req.path}${r.ok ? "" : " (failed)"}\n${body}`;
			});
			const joined = sections.join("\n\n");
			const ok = results.every((r) => r.ok);
			return { ok, output: cap(joined, TOTAL_CAP) };
		},
	};
}
