/**
 * esbuild entry for the IDE-bundled web session page.
 *
 * Mounts the REAL `web/app/(app)/sessions/[id]/page.tsx` (with `next/*` and
 * `@/lib/api` swapped for the shims in ./shims) so Agent Mode renders exactly
 * the dashboard's session view. Exposed as `window.KronyxSession.mount(cfg)`.
 */
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
// The real session page and new-session page — shared source with the dashboard.
import SessionView from "../../web/app/(app)/sessions/[id]/page";
import SessionsLanding from "../../web/app/(app)/sessions/page";
import { configure, resolveApiUrl } from "./shims/kronyxApi";
import { setSessionParams } from "./shims/nextNavigation";
import type { ModelGroup } from "../../web/lib/types";
import "../../web/app/globals.css";

interface MountConfig {
	sessionId: string;
	token: string;
	apiBase: string;
	webBase: string;
	modelId?: string;
	modelProfile?: string;
	/** Local BYOK provider catalogs seeded by the extension — fallback when the
	 *  backend /api/models returns no synced profiles. */
	groups?: ModelGroup[];
}

// window.__kronyxPost is injected by the webview's inline script BEFORE this
// bundle loads — acquireVsCodeApi may only be called once per webview and the
// host script owns it.

// The page builds its SSE URL inline (`/api/sessions/…/events?…&token=…`),
// bypassing apiFetch — rewrite relative /api URLs to the backend here so the
// stream works inside the webview (backend CORS handles the cross-origin).
const NativeEventSource = globalThis.EventSource;
if (typeof NativeEventSource === "function") {
	class PatchedEventSource extends NativeEventSource {
		constructor(url: string | URL, config?: EventSourceInit) {
			super(resolveApiUrl(String(url)), config);
		}
	}
	(globalThis as Record<string, unknown>).EventSource = PatchedEventSource;
}

// window.confirm is a no-op in VS Code webviews — the shared page gates
// "Clear context" on it. Let it pass, then put the real confirmation on the
// actual request: a DOM modal in front of the /clear POST.
(globalThis as { confirm: (msg?: string) => boolean }).confirm = () => true;

function confirmOverlay(text: string): Promise<boolean> {
	return new Promise((resolve) => {
		const wrap = document.createElement("div");
		wrap.style.cssText =
			"position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);";
		const card = document.createElement("div");
		card.style.cssText =
			"max-width:420px;padding:16px 20px;border-radius:8px;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc);border:1px solid var(--vscode-panel-border,#444);font:13px system-ui;";
		const msg = document.createElement("p");
		msg.textContent = text;
		const row = document.createElement("div");
		row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;";
		const mk = (label: string, ok: boolean, primary: boolean) => {
			const b = document.createElement("button");
			b.textContent = label;
			b.style.cssText = `padding:4px 12px;border-radius:4px;cursor:pointer;border:1px solid var(--vscode-panel-border,#555);${
				primary
					? "background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);"
					: "background:transparent;color:inherit;"
			}`;
			b.onclick = () => {
				wrap.remove();
				resolve(ok);
			};
			return b;
		};
		row.append(mk("Cancel", false, false), mk("Clear", true, true));
		card.append(msg, row);
		wrap.appendChild(card);
		document.body.appendChild(wrap);
	});
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if ((init?.method ?? "GET") === "POST" && /\/api\/sessions\/[^/]+\/clear$/.test(url)) {
		return confirmOverlay("Clear this session's context? The next message starts fresh.").then((ok) =>
			ok ? nativeFetch(input, init) : new Response('{"ok":false}', { headers: { "content-type": "application/json" } }),
		);
	}
	return nativeFetch(input, init);
};

// Plain relative anchors (e.g. Composer's <a href="/connect">) bypass the
// next/link shim — forward them to the host so they open in the dashboard.
document.addEventListener("click", (e) => {
	const a = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
	const href = a?.getAttribute("href") ?? "";
	if (a && href.startsWith("/")) {
		e.preventDefault();
		globalThis.__kronyxPost?.({ type: "nav", href });
	}
});

let root: Root | undefined;
let container: HTMLElement | undefined;

// Fresh root per page — clean React state when switching sessions or pages.
function render(el: ReactElement) {
	root?.unmount();
	container?.remove();
	container = document.createElement("div");
	container.id = "kronyx-session-root";
	container.classList.add("kronyx-ide");
	document.body.appendChild(container);
	root = createRoot(container);
	root.render(el);
}

// The IDE's saved pick is the composer's starting selection on every mount; with
// no pick, stale localStorage is cleared so a session can't run on an old model.
function seedModel(modelId?: string, modelProfile?: string) {
	if (modelId && modelProfile) {
		localStorage.setItem("kronyx.modelId", modelId);
		localStorage.setItem("kronyx.modelProfile", modelProfile);
	} else {
		localStorage.removeItem("kronyx.modelId");
		localStorage.removeItem("kronyx.modelProfile");
	}
}

// The Composer falls back to these when the backend has no synced profiles.
function seedGroups(groups?: ModelGroup[]) {
	if (groups?.length) localStorage.setItem("kronyx.modelGroups", JSON.stringify(groups));
}

(globalThis as Record<string, unknown>).KronyxSession = {
	mount(cfg: MountConfig) {
		configure({ apiBase: cfg.apiBase, webBase: cfg.webBase, token: cfg.token });
		setSessionParams({ id: cfg.sessionId });
		seedModel(cfg.modelId, cfg.modelProfile);
		seedGroups(cfg.groups);
		render(createElement(SessionView));
	},
	// The web's new-session page (repo/branch/mode/environment composer).
	showNew(cfg: Omit<MountConfig, "sessionId">) {
		configure({ apiBase: cfg.apiBase, webBase: cfg.webBase, token: cfg.token });
		seedModel(cfg.modelId, cfg.modelProfile);
		seedGroups(cfg.groups);
		render(createElement(SessionsLanding));
	},
	unmount() {
		root?.unmount();
		root = undefined;
		container?.remove();
		container = undefined;
	},
};
