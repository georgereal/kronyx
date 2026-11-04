import * as vscode from "vscode";

const AUTHOR = { name: "Kronyx", iconPath: undefined };

/**
 * Leaves a comment thread on each file the agent changed during a run.
 * Threads are cleared when a new run starts and on "Kronyx: Dismiss comments".
 */
export class RunComments implements vscode.Disposable {
	private readonly controller: vscode.CommentController;
	private threads: vscode.CommentThread[] = [];

	constructor() {
		this.controller = vscode.comments.createCommentController("kronyx", "Kronyx");
		this.controller.options = { prompt: "Reply to Kronyx…", placeHolder: "Reply" };
	}

	dispose(): void {
		this.clear();
		this.controller.dispose();
	}

	clear(): void {
		for (const thread of this.threads) thread.dispose();
		this.threads = [];
	}

	noteChangedFile(absPath: string, kind: string, task: string): void {
		const uri = vscode.Uri.file(absPath);
		const label = kind === "created" ? "created" : "modified";
		const thread = this.controller.createCommentThread(
			uri,
			new vscode.Range(0, 0, 0, 0),
			[
				{
					body: new vscode.MarkdownString(`_${label} by run "${task.slice(0, 120)}"_`),
					mode: vscode.CommentMode.Preview,
					author: AUTHOR,
				},
			],
		);
		thread.label = "Kronyx";
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
		thread.canReply = false;
		this.threads.push(thread);
	}
}
