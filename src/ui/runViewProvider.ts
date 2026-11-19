import * as vscode from "vscode";
import type { AgentMode, RunViewEvent } from "../agent/runner";
import type { ModelOption } from "../config";
import { renderPage } from "./pageHtml";

export type { AgentMode, ModelOption };

export type WebviewMessage =
	| { type: "run"; task: string; mode: AgentMode }
	| { type: "stop" }
	| { type: "compact" }
	| { type: "clearContext" }
	| { type: "new" }
	| { type: "setApiKey" }
	| { type: "requestState" }
	| { type: "setMode"; mode: AgentMode }
	| { type: "setModel"; modelId: string }
	| { type: "attach"; kind: "file" | "directory" | "upload" }
	| { type: "newSession" }
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
	signedIn?: boolean;
	userEmail?: string;
	cloudRepo?: string;
	cloudBranch?: string;
	cloudPr?: string;
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

  private sessions: Array<{ id: string; name: string; messages: string[] }> = [];
  private activeSessionId: string | null = null;

  private broadcastSessions() {
    const msg = {
      type: "updateSessions",
      sessions: this.sessions,
      activeSessionId: this.activeSessionId,
    };
    for (const webview of this.views) void webview.postMessage(msg);
  }

  private createSession() {
    const newSession = {
      id: (Math.random() + 1).toString(36).substring(7),
      name: `Session ${this.sessions.length + 1}`,
      messages: [],
    };
    this.sessions.push(newSession);
    this.activeSessionId = newSession.id;
    this.broadcastSessions();
  }

  private closeSession(sessionId: string) {
    this.sessions = this.sessions.filter(s => s.id !== sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions.length > 0 ? this.sessions[0].id : null;
    }
    this.broadcastSessions();
  }

  private switchSession(sessionId: string) {
    if (this.sessions.find(s => s.id === sessionId)) {
      this.activeSessionId = sessionId;
      this.broadcastSessions();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = renderPage(view.webview, this.extensionUri);

    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case "newSession":
          this.createSession();
          break;
        case "closeSession":
          this.closeSession(message.sessionId);
          break;
        case "switchSession":
          this.switchSession(message.sessionId);
          break;
        // Additional message handling can be added here
      }

      this.onMessage(message);
    });

    this.attach(view.webview);
    view.onDidDispose(() => this.detach(view.webview));
  }

  attach(webview: vscode.Webview): void {
    this.views.add(webview);
    if (this.sessions.length === 0) {
      this.createSession();
    } else {
      this.broadcastSessions();
    }
  }

  detach(webview: vscode.Webview): void {
    this.views.delete(webview);
  }

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

	private postState(): void {
		for (const webview of this.views) void webview.postMessage({ type: "state", ...this.state });
	}
}
