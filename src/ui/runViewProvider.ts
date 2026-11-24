import * as vscode from "vscode";
import type { AgentMode, RunViewEvent } from "../agent/runner";
import type { EngineKind } from "../agent/engine";
import type { ModelOption, ProfileCatalog } from "../config";
import { renderPage } from "./pageHtml";

export type { AgentMode, ModelOption };

export type WebviewMessage =
	| { type: "run"; task: string; mode: AgentMode; pick?: { modelId: string; profile: string }; engine?: EngineKind }
	| { type: "resumeRun" }
	| { type: "stop" }
	| { type: "compact" }
	| { type: "clearContext" }
	| { type: "new" }
	| { type: "setApiKey" }
	| { type: "requestState" }
	| { type: "setEngine"; engine: EngineKind }
	| { type: "setMode"; mode: AgentMode }
	| { type: "setModel"; modelId: string; profile?: string }
	| { type: "attach"; kind: "file" | "directory" | "upload" }
	| { type: "newSession" }
	| { type: "switchSession"; name: string }
	| { type: "closeSession"; name: string }
	| { type: "openSettings" }
	| { type: "review"; path: string }
	| { type: "acceptChange"; path: string }
	| { type: "rejectChange"; path: string }
	| { type: "showHistory" }
	| { type: "permissionResponse"; id: string; decision: "allow" | "always" | "deny" | "alwaysTool" | "alwaysRule" }
	| { type: "openFile"; path: string }
	| { type: "implementPlan"; path: string }
	| { type: "runInTerminal"; command: string }
	| { type: "signIn" }
	| { type: "runCloud"; task: string; mode: AgentMode }
	| { type: "fixSetup"; key: string }
	| { type: "githubPat" }
	| { type: "githubCancel" }
	| { type: "githubOpen"; url: string };

export interface ViewState {
	mode: AgentMode;
	modelId: string;
	models: ModelOption[];
	/** Per-provider catalogs for the provider filter; `models` is the active profile's flat list. */
	groups?: ProfileCatalog[];
	/** Provider profile the last composer pick belongs to; empty = the Settings default. */
	modelProfile?: string;
	/** Execution engine for the session's next run. */
	engine?: EngineKind;
	signedIn?: boolean;
	userEmail?: string;
	cloudRepo?: string;
	cloudBranch?: string;
	cloudPr?: string;
	/** Session tab strip: persisted sessions + the active one. */
	sessions?: { name: string; title: string }[];
	/** Stored sessions without an open tab — listed in the dropdown for reopening. */
	moreSessions?: { name: string; title: string }[];
	activeSession?: string;
}

export interface AttachmentPreview {
	path: string;
	name: string;
	kind: "file" | "directory";
	mime?: string;
	dataUrl?: string;
}

export type ViewEvent =
	| RunViewEvent
	| { type: "reset" }
	| { type: "cloud-status"; text: string; key?: string }
	| { type: "setup"; step: number; label: string; state: "run" | "ok" | "fail"; detail?: string }
	| { type: "setupStatus"; items: { key: string; label: string; ok: boolean; detail?: string; fixLabel?: string }[] }
	| { type: "github-enable"; repo: string; url: string };

/**
 * Hosts the run UI in one or more webview surfaces (sidebar views, editor panels).
 * Events broadcast to all resolved views; unresolved events queue in a backlog
 * replayed to the next view that opens.
 */
export class RunViewProvider implements vscode.WebviewViewProvider {
	static readonly viewId = "kronyx.runView";
	static readonly rightViewId = "kronyx.runViewRight";
	private readonly views = new Set<vscode.Webview>();
	private readonly backlog: ViewEvent[] = [];
	private state: ViewState = { mode: "code", modelId: "", models: [] };

	onMessage: (message: WebviewMessage) => void = () => {};

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		const media = vscode.Uri.joinPath(this.extensionUri, "media");
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = renderPage(view.webview, this.extensionUri);
		view.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message));
		this.attach(view.webview);
		view.onDidDispose(() => this.detach(view.webview));
	}

	/** Attach a bare webview (e.g. an editor WebviewPanel) to this session surface. */
	attach(webview: vscode.Webview): void {
		this.views.add(webview);
		for (const event of this.backlog) void webview.postMessage(event);
		this.postState();
	}

	detach(webview: vscode.Webview): void {
		this.views.delete(webview);
	}

	post(event: ViewEvent): void {
		if (event.type === "reset") this.backlog.length = 0;
		else {
			this.backlog.push(event);
			if (this.backlog.length > 500) this.backlog.shift();
		}
		for (const webview of this.views) void webview.postMessage(event);
	}

	setState(state: Partial<ViewState>): void {
		this.state = { ...this.state, ...state };
		this.postState();
	}

	getState(): ViewState {
		return this.state;
	}

	insertMention(text: string): void {
		for (const webview of this.views) void webview.postMessage({ type: "insertMention", text });
	}

	insertAttachment(attachment: AttachmentPreview): void {
		for (const webview of this.views) void webview.postMessage({ type: "insertAttachment", attachment });
	}

	private postState(): void {
		for (const webview of this.views) void webview.postMessage({ type: "state", ...this.state });
	}
}
