import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { applyHunk, computeHunks, revertHunk, type Hunk } from "../diff/hunks";

export const ORIGINAL_SCHEME = "kronyx-original";

export interface HunkCommandArgs {
	absPath: string;
	hunk: Hunk;
}

/**
 * Snapshots files before the agent first writes to them. Provides:
 * - a `kronyx-original://` scheme so `vscode.diff` shows original vs current
 * - CodeLens "Accept hunk" / "Revert hunk" actions per changed hunk in the editor
 * - file-level accept/reject helpers
 * One registry is shared across sessions — the run lock means only one run writes at a time.
 */
export class DiffReview implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
	private readonly originals = new Map<string, string | null>();
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly lensEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	readonly onDidChangeCodeLenses = this.lensEmitter.event;
	private readonly watcher: vscode.Disposable;

	constructor() {
		this.watcher = vscode.workspace.onDidChangeTextDocument((event) => {
			if (this.originals.has(event.document.uri.fsPath)) this.lensEmitter.fire();
		});
	}

	dispose(): void {
		this.watcher.dispose();
	}

	/** Called before a tool writes a file. Records the pre-change content once. */
	record(absPath: string, before: string | null): void {
		if (!this.originals.has(absPath)) this.originals.set(absPath, before);
		this.lensEmitter.fire();
	}

	has(absPath: string): boolean {
		return this.originals.has(absPath);
	}

	changedFiles(): string[] {
		return [...this.originals.keys()];
	}

	clear(): void {
		this.originals.clear();
		this.lensEmitter.fire();
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.originals.get(decodeURIComponent(uri.path)) ?? "";
	}

	async openReview(absPath: string, relPath: string): Promise<void> {
		if (!this.originals.has(absPath)) {
			void vscode.window.showInformationMessage(`Kronyx: no recorded changes for ${relPath}`);
			return;
		}
		const original = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: encodeURIComponent(absPath) });
		const current = vscode.Uri.file(absPath);
		await vscode.commands.executeCommand("vscode.diff", original, current, `${relPath} — Kronyx changes`, {
			preview: true,
		});
	}

	// ---------- file level ----------

	accept(absPath: string): void {
		this.originals.delete(absPath);
		this.lensEmitter.fire();
	}

	async reject(absPath: string): Promise<void> {
		const before = this.originals.get(absPath);
		if (before === undefined) return;
		if (before === null) await fs.rm(absPath, { force: true });
		else await fs.writeFile(absPath, before);
		this.originals.delete(absPath);
		this.lensEmitter.fire();
	}

	// ---------- hunk level ----------

	private hunksFor(absPath: string, currentText: string): Hunk[] {
		const before = this.originals.get(absPath);
		if (before === undefined) return [];
		return computeHunks(before ?? "", currentText);
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (document.uri.scheme !== "file" || !this.originals.has(document.uri.fsPath)) return [];
		const absPath = document.uri.fsPath;
		const lenses: vscode.CodeLens[] = [];
		for (const hunk of this.hunksFor(absPath, document.getText())) {
			const range = new vscode.Range(hunk.afterStart, 0, hunk.afterStart, 0);
			lenses.push(
				new vscode.CodeLens(range, {
					title: "$(check) Accept hunk",
					command: "kronyx.acceptHunk",
					arguments: [{ absPath, hunk } satisfies HunkCommandArgs],
				}),
				new vscode.CodeLens(range, {
					title: "$(discard) Revert hunk",
					command: "kronyx.rejectHunk",
					arguments: [{ absPath, hunk } satisfies HunkCommandArgs],
				}),
			);
		}
		return lenses;
	}

	/** Mark one hunk as baseline: apply it to the stored original so it stops showing. */
	async acceptHunk({ absPath, hunk }: HunkCommandArgs): Promise<void> {
		const before = this.originals.get(absPath);
		if (before === undefined) return;
		const merged = applyHunk(before ?? "", hunk);
		const current = await this.readCurrent(absPath);
		if (current === undefined) return;
		if (computeHunks(merged, current).length === 0) this.originals.delete(absPath);
		else this.originals.set(absPath, merged);
		this.lensEmitter.fire();
	}

	/** Revert one hunk in the working file back to the original lines. */
	async rejectHunk({ absPath, hunk }: HunkCommandArgs): Promise<void> {
		const before = this.originals.get(absPath);
		if (before === undefined) return;
		const current = await this.readCurrent(absPath);
		if (current === undefined) return;
		const reverted = revertHunk(current, hunk);
		if (reverted === current) return;
		await fs.writeFile(absPath, reverted);
		if (computeHunks(before ?? "", reverted).length === 0) this.originals.delete(absPath);
		this.lensEmitter.fire();
	}

	private async readCurrent(absPath: string): Promise<string | undefined> {
		return fs.readFile(absPath, "utf8").catch(() => undefined);
	}
}
