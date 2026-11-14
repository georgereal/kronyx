import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AgentTool } from "@cline/shared";

/** Diagnostic sink — controller wires this to memory_events (op "ide_context"). */
export type IdeReport = (d: Record<string, unknown>) => void;

const TIMEOUT_MS = 10_000;
const MAX_SYMBOLS = 50;
const MAX_REFS = 30;
const MAX_DIAG_FILES = 50;
const MAX_DIAG_PER_FILE = 10;
const MAX_CODE_ACTIONS_MARKER = 50;
const MAX_FORMAT_RESULTS_MARKER = 30;
const MAX_DIAG_RESULT_MARKER = 10;
const TRUNC_MARKER = "...";
const MAX_HOVER_CHARS = 1_500;

async function withTimeout<T>(p: Promise<T> | Thenable<T>, what: string): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(p),
			new Promise<undefined>((res) => {
				timer = setTimeout(() => res(undefined), TIMEOUT_MS);
			}),
		]);
	} catch {
		return undefined; // provider absent, language server cold, or virtual fs
	} finally {
		clearTimeout(timer);
	}
}

const SEVERITY = ["error", "warning", "info", "hint"] as const;
const MAX_CODE_ACTIONS = 50;
const MAX_FORMAT_RESULTS = 30;

interface IdeToolOptions {
	root: string;
	report?: IdeReport;
	/** Snapshot a file before an LSP edit touches it (diff review). */
	onBeforeWrite?: (abs: string, before: string) => void;
	/** Notify that an LSP edit changed a file on disk. */
	onFileChanged?: (abs: string) => void;
}

/**
 * IDE-context tools: language-service queries (symbols, refs, hover,
 * diagnostics) so the agent doesn't grep/read files the IDE already
 * understands. Extension-only — cloud runs never see these tools.
 */
// biome-ignore lint/suspicious/noExplicitAny: tool inputs vary per tool
export function createIdeTools(options: IdeToolOptions): AgentTool<any, string>[] {
	const isOutside = (r: string): boolean =>
		!r || r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);
	const rel = (uri: vscode.Uri): string => {
		const r = path.relative(options.root, uri.fsPath);
		return (isOutside(r) ? uri.fsPath : r).split(path.sep).join("/");
	};
	const inWorkspace = (uri: vscode.Uri): boolean =>
		uri.scheme === "file" && !isOutside(path.relative(options.root, uri.fsPath));
	const uriFor = (file: string): vscode.Uri =>
		vscode.Uri.file(path.isAbsolute(file) ? file : path.join(options.root, file));

	const fmtLoc = (l: vscode.Location | vscode.LocationLink): string => {
		const range = l instanceof vscode.Location ? l.range : (l.targetSelectionRange ?? l.targetRange);
		const uri = l instanceof vscode.Location ? l.uri : l.targetUri;
		return `${rel(uri)}:${range.start.line + 1}`;
	};

	const hoverText = (h: vscode.Hover): string =>
		h.contents
			.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : ""))
			.join("\n")
			.trim()
			.slice(0, MAX_HOVER_CHARS);

	const flatSymbols = (symbols: vscode.DocumentSymbol[], depth = 0): string[] => {
		const lines: string[] = [];
		for (const s of symbols.slice(0, MAX_SYMBOLS)) {
			lines.push(`${"  ".repeat(depth)}${s.name}  ${vscode.SymbolKind[s.kind].toLowerCase()}  :${s.range.start.line + 1}-${s.range.end.line + 1}`);
			if (s.children?.length) lines.push(...flatSymbols(s.children, depth + 1));
		}
		return lines;
	};

	const exec = async <T>(cmd: string, ...args: unknown[]): Promise<T | undefined> =>
		withTimeout<T>(vscode.commands.executeCommand<T>(cmd, ...args), cmd);

	return [
		{
			name: "get_diagnostics",
			executionMode: "parallel",
			description:
				"Errors, warnings and hints the IDE's language servers already computed — no build needed. " +
				"Call before editing (baseline) and after (what your change introduced). Optionally scoped to one file.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "Optional workspace-relative file; omit for the whole workspace." },
					severity: { type: "string", enum: ["error", "warning", "info", "hint"], description: "Minimum severity (default: warning)." },
				},
			},
			async execute(input: { path?: string; severity?: string }) {
				const t0 = Date.now();
				const sevIdx = SEVERITY.indexOf((input.severity ?? "warning") as (typeof SEVERITY)[number]);
				const minSev = sevIdx < 0 ? SEVERITY.indexOf("warning") : sevIdx;
				const entries = input.path
					? ([[uriFor(input.path), vscode.languages.getDiagnostics(uriFor(input.path))]] as [vscode.Uri, vscode.Diagnostic[]][])
					: vscode.languages.getDiagnostics().filter(([u]) => inWorkspace(u));
				const lines: string[] = [];
				let files = 0;
				let total = 0;
				for (const [uri, diags] of entries) {
					if (files >= MAX_DIAG_FILES) break;
					const kept = diags.filter((d) => d.severity <= minSev).slice(0, MAX_DIAG_PER_FILE);
					if (!kept.length) continue;
					files++;
					for (const d of kept) {
						total++;
						lines.push(`${rel(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} [${SEVERITY[d.severity]}]${d.source ? ` ${d.source}:` : ""} ${d.message.split("\n")[0]}`);
					}
				}
				options.report?.({ op: "ide_context", tool: "get_diagnostics", files, results: total, tookMs: Date.now() - t0 });
				return lines.length ? lines.join("\n") : "No diagnostics.";
			},
		},
		{
			name: "search_symbols",
			executionMode: "parallel",
			description:
				"Search workspace symbols (classes, functions, methods, interfaces) by name — uses the language server index, " +
				"much faster and more precise than search_files for 'where is X'.",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string", description: "Symbol name or fragment (e.g. PaymentService, processPayment)." } },
				required: ["query"],
			},
			async execute(input: { query?: string }) {
				const t0 = Date.now();
				const syms = await exec<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", String(input.query ?? ""));
				options.report?.({ op: "ide_context", tool: "search_symbols", results: syms?.length ?? 0, tookMs: Date.now() - t0 });
				if (!syms?.length) return "No matching symbols (or no workspace-symbol provider for this language).";
				return syms
					.slice(0, MAX_SYMBOLS)
					.map((s) => `${s.name}  ${vscode.SymbolKind[s.kind].toLowerCase()}${s.containerName ? `  in ${s.containerName}` : ""}  ${fmtLoc(s.location)}`)
					.join("\n");
			},
		},
		{
			name: "get_file_structure",
			executionMode: "parallel",
			description:
				"Hierarchical symbol outline of one file (classes → methods → fields) with line ranges — " +
				"orient on a file's structure without reading it whole.",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string", description: "Workspace-relative file path." } },
				required: ["path"],
			},
			async execute(input: { path?: string }) {
				const t0 = Date.now();
				const result = await exec<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
					"vscode.executeDocumentSymbolProvider",
					uriFor(String(input.path ?? "")),
				);
				options.report?.({ op: "ide_context", tool: "get_file_structure", file: input.path, results: result?.length ?? 0, tookMs: Date.now() - t0 });
				if (!result?.length) return "No symbols (file has none, or no document-symbol provider for this language).";
				if ("children" in (result[0] as vscode.DocumentSymbol) || "range" in (result[0] as vscode.DocumentSymbol)) {
					return flatSymbols(result as vscode.DocumentSymbol[]).slice(0, MAX_SYMBOLS * 2).join("\n");
				}
				return (result as vscode.SymbolInformation[])
					.slice(0, MAX_SYMBOLS * 2)
					.map((s) => `${s.name}  ${vscode.SymbolKind[s.kind].toLowerCase()}  :${s.location.range.start.line + 1}`)
					.join("\n");
			},
		},
		{
			name: "get_symbol_context",
			executionMode: "parallel",
			description:
				"Everything the IDE knows about the symbol at a position: definition, references (callers), " +
				"implementations, type definition, declaration, and hover type/signature — replaces several searches and file reads.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative file containing the symbol." },
					line: { type: "integer", description: "1-based line of the symbol." },
					character: { type: "integer", description: "1-based column of the symbol." },
					want: {
						type: "array",
						items: {
							type: "string",
							enum: ["definition", "references", "implementations", "typeDefinition", "declaration", "hover"],
						},
						description: "Which facets to fetch (default: all).",
					},
				},
				required: ["path", "line", "character"],
			},
			async execute(input: { path?: string; line?: number; character?: number; want?: string[] }) {
				const t0 = Date.now();
				const uri = uriFor(String(input.path ?? ""));
				const pos = new vscode.Position(Math.max(0, (input.line ?? 1) - 1), Math.max(0, (input.character ?? 1) - 1));
				const FACETS = ["definition", "references", "implementations", "typeDefinition", "declaration", "hover"] as const;
				const want = new Set(input.want?.length ? input.want.filter((f) => (FACETS as readonly string[]).includes(f)) : FACETS);
				if (!want.size) return `No valid facets — want must be a subset of: ${FACETS.join(", ")}.`;
				const sections: string[] = [];
				const [defs, refs, impls, typeDefs, decls, hovers] = await Promise.all([
					want.has("definition") ? exec<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", uri, pos) : undefined,
					want.has("references") ? exec<vscode.Location[]>("vscode.executeReferenceProvider", uri, pos, { includeDeclaration: false }) : undefined,
					want.has("implementations") ? exec<(vscode.Location | vscode.LocationLink)[]>("vscode.executeImplementationProvider", uri, pos) : undefined,
					want.has("typeDefinition") ? exec<(vscode.Location | vscode.LocationLink)[]>("vscode.executeTypeDefinitionProvider", uri, pos) : undefined,
					want.has("declaration") ? exec<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDeclarationProvider", uri, pos) : undefined,
					want.has("hover") ? exec<vscode.Hover[]>("vscode.executeHoverProvider", uri, pos) : undefined,
				]);
				const fmtList = (locs: readonly (vscode.Location | vscode.LocationLink)[] | undefined, cap: number) =>
					(locs ?? []).slice(0, cap).map(fmtLoc).join("\n");
				if (defs !== undefined) sections.push(`Definitions:\n${fmtList(defs, 8) || "(none)"}`);
				if (refs !== undefined) {
					sections.push(`References (${refs?.length ?? 0}${(refs?.length ?? 0) > MAX_REFS ? `, first ${MAX_REFS}` : ""}):\n${fmtList(refs, MAX_REFS) || "(none)"}`);
				}
				if (impls !== undefined) sections.push(`Implementations:\n${fmtList(impls, 12) || "(none)"}`);
				if (typeDefs !== undefined) sections.push(`Type definitions:\n${fmtList(typeDefs, 8) || "(none)"}`);
				if (decls !== undefined) sections.push(`Declarations:\n${fmtList(decls, 8) || "(none)"}`);
				if (hovers !== undefined) sections.push(`Hover:\n${(hovers ?? []).map(hoverText).filter(Boolean).join("\n---\n") || "(none)"}`);
				options.report?.({
					op: "ide_context",
					tool: "get_symbol_context",
					file: input.path,
					defs: defs?.length ?? 0,
					refs: refs?.length ?? 0,
					impls: impls?.length ?? 0,
					tookMs: Date.now() - t0,
				});
				return sections.join("\n\n");
			},
		},
		{
			name: "get_call_hierarchy",
			executionMode: "parallel",
			description:
				"Call hierarchy for the function/method at a position: incoming = who calls it, outgoing = what it calls. " +
				"More precise than references for tracing call flow.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative file containing the function." },
					line: { type: "integer", description: "1-based line of the function name." },
					character: { type: "integer", description: "1-based column of the function name." },
					direction: { type: "string", enum: ["incoming", "outgoing"], description: "Callers or callees (default: incoming)." },
				},
				required: ["path", "line", "character"],
			},
			async execute(input: { path?: string; line?: number; character?: number; direction?: string }) {
				const t0 = Date.now();
				const uri = uriFor(String(input.path ?? ""));
				const pos = new vscode.Position(Math.max(0, (input.line ?? 1) - 1), Math.max(0, (input.character ?? 1) - 1));
				const roots = await exec<vscode.CallHierarchyItem[]>("vscode.prepareCallHierarchy", uri, pos);
				const root = roots?.[0];
				if (!root) return "No call hierarchy (symbol isn't callable, or no provider for this language).";
				const direction = input.direction === "outgoing" ? "outgoing" : "incoming";
				const calls =
					direction === "incoming"
						? await exec<vscode.CallHierarchyIncomingCall[]>("vscode.provideIncomingCalls", root)
						: await exec<vscode.CallHierarchyOutgoingCall[]>("vscode.provideOutgoingCalls", root);
				options.report?.({ op: "ide_context", tool: "get_call_hierarchy", file: input.path, direction, results: calls?.length ?? 0, tookMs: Date.now() - t0 });
				if (!calls?.length) return `No ${direction} calls.`;
				const lines = calls.slice(0, MAX_REFS).flatMap((c) => {
					const item = direction === "incoming" ? (c as vscode.CallHierarchyIncomingCall).from : (c as vscode.CallHierarchyOutgoingCall).to;
					const ranges = direction === "incoming" ? (c as vscode.CallHierarchyIncomingCall).fromRanges : [item.range];
					return ranges.map((r) => `${item.name}  ${vscode.SymbolKind[item.kind].toLowerCase()}  ${rel(item.uri)}:${r.start.line + 1}`);
				});
				return lines.join("\n");
			},
		},
		{
			name: "rename_symbol",
			description:
				"Rename the symbol at a position across the whole workspace via the language server — updates every " +
				"reference safely. Prefer this over manual search-and-edit for renames.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "Workspace-relative file containing the symbol." },
					line: { type: "integer", description: "1-based line of the symbol." },
					character: { type: "integer", description: "1-based column of the symbol." },
					new_name: { type: "string", description: "Replacement name." },
				},
				required: ["path", "line", "character", "new_name"],
			},
			async execute(input: { path?: string; line?: number; character?: number; new_name?: string }) {
				const t0 = Date.now();
				const newName = String(input.new_name ?? "").trim();
				if (!newName) return "new_name is empty.";
				const uri = uriFor(String(input.path ?? ""));
				const pos = new vscode.Position(Math.max(0, (input.line ?? 1) - 1), Math.max(0, (input.character ?? 1) - 1));
				const prep = await exec<vscode.Range | { range: vscode.Range; placeholder: string }>("vscode.prepareRename", uri, pos);
				if (!prep) return "Cannot rename here (not a renameable symbol, or no rename provider for this language).";
				const edit = await exec<vscode.WorkspaceEdit>("vscode.executeDocumentRenameProvider", uri, pos, newName);
				if (!edit) return "Rename failed — the language server returned no edit.";
				const files = new Map<string, vscode.Uri>();
				for (const [u] of edit.entries()) {
					if (inWorkspace(u)) files.set(u.fsPath, u);
				}
				if (!files.size) return "Rename produced no in-workspace edits.";
				for (const abs of files.keys()) {
					const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
					const before = doc ? doc.getText() : await fs.readFile(abs, "utf8").catch(() => "");
					options.onBeforeWrite?.(abs, before);
				}
				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) return "Rename failed — the workspace edit was rejected.";
				await Promise.all(
					[...files.values()].map(async (u) => {
						const doc = await vscode.workspace.openTextDocument(u);
						await doc.save();
						options.onFileChanged?.(u.fsPath);
					}),
				);
				const edits = [...files.values()].flatMap((u) =>
					(edit.get(u) ?? []).map((e) => `${rel(u)}:${e.range.start.line + 1}`),
				);
				options.report?.({
					op: "ide_context",
					tool: "rename_symbol",
					file: input.path,
					newName,
					files: files.size,
					edits: edits.length,
					tookMs: Date.now() - t0,
				});
				return `Renamed to "${newName}" — ${edits.length} edit(s) in ${files.size} file(s):\n${edits.slice(0, MAX_REFS).join("\n")}`;
			},
{
			name: "code_action",
			executionMode: "parallel",
			description:
				"Apply a code action suggested by the language server (refactor, quick-fix, or similar). " +
				"Uses vscode.executeCodeActionProvider. The input selects a starting position so the server can propose context-appropriate actions.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "Optional workspace-relative file." },
					position: { type: "object", description: "Position in the file (line, character)." },
				},
				required: ["position"],
			},
			async execute(input: { path?: string; position: { line: number; character: number } }) {
				const uri = input.path ? uriFor(input.path) : undefined;
				const prep = await exec<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, new vscode.Position(input.position.line, input.position.character), vscode.CodeActionKind.All);
				if (!prep) return "No code action provider or no actions returned.";
				const actions = prep.slice(0, MAX_CODE_ACTIONS);
				const out: string[] = [];
				for (const a of actions) {
					const kind = a.kind ? vscode.CodeActionKind[a.kind] : "";
					out.push(`-${a.title} ${kind ? `[${kind}]` : ""}`);
					if (a.edit) {
						const edits = a.edit.get(uri);
						if (edits) {
							for (const e of edits) {
								out.push(`  ${rel(uri)}:${e.range.start.line + 1}:${e.range.start.character + 1} ${e.newText?.slice(0, 80) ?? ""}`);
							}
						}
					}
				}
				options.report?.({ op: "ide_context", tool: "code_action", files: actions.length, tookMs: Date.now() - t0 });
				return out.length ? out.join("\n") : "No code actions.";
			},
		},
		{
			name: "format_document",
			executionMode: "parallel",
			description:
				"Reformat the entire document using the language server. " +
				"Equivalent to VS Code's "format document" command but scoped to the current editor or a given path.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "Optional workspace-relative file." },
				},
			},
			async execute(input: { path?: string }) {
				const uri = input.path ? uriFor(input.path) : vscode.window.activeTextEditor?.document.uri;
				if (!uri) return "No active editor and no path provided.";
				const result = await exec<vscode.TextEdit[]>("vscode.executeDocumentFormatProvider", uri);
				if (!result) return "Format provider returned no edits.";
				const edits = result.slice(0, MAX_FORMAT_RESULTS);
				const out: string[] = [];
				for (const e of edits) {
					out.push(`${rel(uri)}:${e.range.start.line + 1}:${e.range.start.character + 1} -> ${e.newText?.slice(0, 80) ?? ""}`);
				}
				options.report?.({ op: "ide_context", tool: "format_document", tookMs: Date.now() - t0 });
				return out.length ? out.join("\n") : "No formatting edits.";
			},
		},
		{
			name: "get_selection_context",
			executionMode: "parallel",
			description:
				"Return the current editor selection as context text, plus surrounding lines (up to 10 before/after). " +
				"Useful for keeping agent focus on the active region across turns.",
			inputSchema: {
				type: "object",
				properties: {
					extend: { type: "integer", description: "Lines to extend selection by before/after (default: 5)." },
				},
			},
			async execute(input: { extend?: number }) {
				const editor = vscode.window.activeTextEditor;
				if (!editor) return "No active editor.";
				const doc = editor.document;
				const sel = editor.selection;
				const extend = Math.max(0, (input.extend ?? 5));
				const startLine = Math.max(0, sel.start.line - extend);
				const endLine = Math.min(doc.lineCount - 1, sel.end.line + extend);
				const selectedText = doc.getText(new vscode.Range(startLine, 0, endLine + 1, doc.lineAt(endLine).range.end.character));
				const beforeLines = doc.getText(new vscode.Range(startLine, 0, sel.start.line, doc.lineAt(sel.start.line - 1 ? sel.start.line - 1 : 0).range.end.character)).split("\n").slice(0, extend).join("\n");
				const afterLines = doc.getText(new vscode.Range(sel.end.line + 1, 0, endLine + 1, doc.lineAt(endLine).range.end.character)).split("\n").slice(0, extend).join("\n");
				return `Selection (lines ${sel.start.line + 1}-${sel.end.line + 1}):${selectedText ? " " + selectedText : ""}\n\nBefore:${beforeLines ? " " + beforeLines : ""}\n\nAfter:${afterLines ? " " + afterLines : ""}`;
			},
		},
		{
			name: "post_edit_diagnostics",
			executionMode: "parallel",
			description:
				"Compare diagnostics before and after an edit. The controller calls this with a before-snapshot; the tool computes after-diagnostics and returns a diff report.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string", description: "File that was edited." },
					beforeSnapshot: { type: "string", description: "Diagnostics string from before the edit (as returned by get_diagnostics)." },
				},
				required: ["path", "beforeSnapshot"],
			},
			async execute(input: { path: string; beforeSnapshot: string }) {
				const after = await exec(vscode.languages.getDiagnostics, uriFor(input.path));
				const afterLines = after
					.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
					.map((d) => `${rel(uriFor(input.path))}:${d.range.start.line + 1}:${d.range.start.character + 1} [${SEVERITY[d.severity]}] ${d.message.split("\n")[0]}`)
					.slice(0, MAX_DIAG_PER_FILE);
				const before = input.beforeSnapshot.split("\n");
				const afterSet = new Set(afterLines);
				const newDiagnostics = afterLines.filter((l) => !before.some((b) => b.includes(l.split(":")[0])));
				const resolved = afterLines.filter((l) => before.some((b) => b.includes(l.split(":")[0]) && !l.includes("error")));
				const report: string[] = [];
				if (newDiagnostics.length) report.push(`New ${newDiagnostics.length} diagnostics:`);
				report.push(...newDiagnostics.slice(0, 10));
				if (resolved.length) report.push(`\nResolved ${resolved.length} diagnostics:`);
				report.push(...resolved.slice(0, 10));
				options.report?.({ op: "ide_context", tool: "post_edit_diagnostics", path: input.path, newCount: newDiagnostics.length, resolvedCount: resolved.length, tookMs: Date.now() - t0 });
				return report.join("\n") || "No diagnostic changes.";
			},
		},
};
		},
	];
}
