// @ts-check
(() => {
	// @ts-ignore acquireVsCodeApi is injected by VS Code
	const vscode = acquireVsCodeApi();
	const timeline = /** @type {HTMLElement} */ (document.getElementById("timeline"));
	const task = /** @type {HTMLTextAreaElement} */ (document.getElementById("task"));
	const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
	const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById("stop"));
	const attachBtn = /** @type {HTMLButtonElement} */ (document.getElementById("attach"));
	const cloudStatus = /** @type {HTMLElement} */ (document.getElementById("cloudstatus"));
	const mentionBtn = /** @type {HTMLButtonElement} */ (document.getElementById("mention"));
	const modeBtn = /** @type {HTMLButtonElement} */ (document.getElementById("mode"));
	const modelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("model"));
	const modeLabel = /** @type {HTMLElement} */ (document.getElementById("mode-label"));
	const engineBtn = /** @type {HTMLButtonElement} */ (document.getElementById("engine"));
	const engineLabel = /** @type {HTMLElement} */ (document.getElementById("engine-label"));
	const modelLabel = /** @type {HTMLElement} */ (document.getElementById("model-label"));
	const status = /** @type {HTMLElement} */ (document.getElementById("status"));
	const tokchip = /** @type {HTMLElement} */ (document.getElementById("tokchip"));
	const menu = /** @type {HTMLElement} */ (document.getElementById("menu"));
	const authBanner = /** @type {HTMLElement} */ (document.getElementById("authbanner"));
	const authSignIn = /** @type {HTMLButtonElement} */ (document.getElementById("auth-signin"));
	const authDismiss = /** @type {HTMLButtonElement} */ (document.getElementById("auth-dismiss"));
	const tabList = /** @type {HTMLElement} */ (document.getElementById("tab-list"));
	const tabNew = /** @type {HTMLButtonElement} */ (document.getElementById("tab-new"));
	const tabPrev = /** @type {HTMLButtonElement} */ (document.getElementById("tab-prev"));
	const tabRight = /** @type {HTMLButtonElement} */ (document.getElementById("tab-right"));
	const attachmentPreviews = /** @type {HTMLElement} */ (document.getElementById("attachment-previews"));
	const activity = /** @type {HTMLButtonElement} */ (document.getElementById("activity"));
	const contextPopover = /** @type {HTMLElement} */ (document.getElementById("context-popover"));
	/** @type {Map<string, HTMLElement>} */
	const tools = new Map();
	/** @type {Map<string, HTMLElement>} */
	const attachments = new Map();
	let openToolCard = null;
	let usage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalCost: 0,
		iteration: 0,
		contextMsgs: 0,
		contextBudget: 0,
	};
	let startedAt = 0;

	const persisted = vscode.getState() || {};
	/** @type {string} */
	let mode = persisted.mode || "code";
	const ENGINES = ["cline", "openai"];
	let engine = ENGINES.includes(persisted.engine) ? persisted.engine : "cline";
	/** @type {string} */
	// The composer pick (modelId + modelProfile) is host state only — never restored
	// from webview storage, so a stale id can't pair with the wrong provider.
	let modelId = "";
	/** @type {import("../src/config").ModelOption[]} */
	let models = persisted.models || [];
	/** Per-provider catalogs from the host; `models` stays the active profile's flat list. @type {{profile: string, active?: boolean, models: any[]}[]} */
	let groups = [];
	let modelProfile = "";
	let providerFilter = "";
	/** @type {string[]} */
	let recentModels = persisted.recentModels || [];
	/** @type {{name: string, title: string}[]} */
	let sessionTabs = [];
	/** @type {{name: string, title: string}[]} */
	let moreTabs = [];
	let activeSession = "";
	// Drafts are per-session — switching sessions swaps the composer text.
	/** @type {Record<string, string>} */
	const drafts = persisted.drafts || {};

	const MODES = [
		{ id: "code", label: "Code", desc: "Write and edit code" },
		{ id: "smart", label: "Smart", desc: "Auto-approve actions the model judges safe" },
		{ id: "ask", label: "Ask", desc: "Answer questions without code changes" },
		{ id: "plan", label: "Plan", desc: "Plan changes before implementing" },
		{ id: "bypass", label: "Bypass Permissions", desc: "Auto-approve all tool calls" },
	];

	const persist = () => {
		drafts[activeSession] = task.value;
		vscode.setState({ mode, engine, models, recentModels, drafts, authDismissed, cloudEnv });
	};

	let cloudEnv = persisted.cloudEnv === true;

	const persistedAuth = persisted.authDismissed === true;
	let authDismissed = persistedAuth;
	let signedIn = undefined;
	const refreshAuthBanner = () => {
		authBanner.hidden = signedIn !== false || authDismissed;
	};
	authSignIn.addEventListener("click", () => vscode.postMessage({ type: "signIn" }));
	authDismiss.addEventListener("click", () => {
		authDismissed = true;
		refreshAuthBanner();
		persist();
	});
	refreshAuthBanner();

	const el = (tag, cls, text) => {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = text;
		return node;
	};

	const renderTabs = () => {
		tabList.innerHTML = "";
		const labels = sessionTabs.map((s) => s.title || s.name);
		const makeChip = (s, active) => {
			const label = s.title || s.name;
			// Disambiguate same-title sessions with the stored session name.
			const text = labels.indexOf(label) !== labels.lastIndexOf(label) && s.title !== s.name ? `${label} · ${s.name}` : label;
			const chip = el("button", "tab" + (active ? " active" : ""), text);
			chip.title = s.name;
			chip.addEventListener("click", () => {
				if (s.name !== activeSession) vscode.postMessage({ type: "switchSession", name: s.name });
			});
			const close = el("span", "tab-close", "×");
			close.title = "Close session tab";
			close.addEventListener("click", (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: "closeSession", name: s.name });
			});
			chip.appendChild(close);
			return chip;
		};
		// Tabs keep a stable left-to-right order; selection only changes which
		// chip is active, never its position.
		for (const s of sessionTabs) tabList.appendChild(makeChip(s, s.name === activeSession));
		// Scroll the active chip into view; offer "»" when tabs overflow to the right.
		const activeChip = tabList.querySelector(".tab.active");
		if (activeChip) activeChip.scrollIntoView({ block: "nearest", inline: "nearest" });
		tabRight.hidden = tabList.scrollWidth - tabList.scrollLeft <= tabList.clientWidth + 1;
	};
	tabRight.addEventListener("click", () => {
		tabList.scrollTo({ left: tabList.scrollWidth, behavior: "smooth" });
		tabRight.hidden = true;
	});
	tabList.addEventListener("scroll", () => {
		tabRight.hidden = tabList.scrollWidth - tabList.scrollLeft <= tabList.clientWidth + 1;
	});
	tabNew.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
	window.addEventListener("resize", renderTabs);
	tabPrev.addEventListener("click", () => {
		const item = (s) => ({
			label: s.title || s.name,
			desc: s.title && s.title !== s.name ? s.name : undefined,
			checked: s.name === activeSession,
			onPick: () => {
				if (s.name !== activeSession) vscode.postMessage({ type: "switchSession", name: s.name });
			},
		});
		openMenu(tabPrev, {
			below: true,
			items: sessionTabs.length || moreTabs.length
				? [...sessionTabs.map(item), ...(moreTabs.length ? [{ header: "More sessions" }, ...moreTabs.map(item)] : [])]
				: [{ label: "No sessions yet", disabled: true }],
		});
	});

	// ---------- markdown ----------
	const sanitizeMd = (html) => html.replace(/<(script|style|iframe|object|embed|form)[\s\S]*?<\/\1>/gi, "");
	const renderMd = (text) => {
		const d = el("div", "md");
		if (typeof marked === "undefined") {
			d.textContent = text;
			return d;
		}
		d.innerHTML = sanitizeMd(marked.parse(text));
		for (const pre of d.querySelectorAll("pre")) {
			const wrap = el("div", "code-wrap");
			const bar = el("div", "code-bar");
			const lang = pre.querySelector("code")?.className.replace(/^(language-|hljs)/, "").trim();
			bar.appendChild(el("span", "code-lang", lang || "code"));
			const copy = el("button", "code-copy", "Copy");
			copy.addEventListener("click", () => {
				void navigator.clipboard.writeText(pre.textContent || "");
				copy.textContent = "✓";
				setTimeout(() => (copy.textContent = "Copy"), 1200);
			});
			bar.appendChild(copy);
			pre.parentNode.insertBefore(wrap, pre);
			wrap.appendChild(bar);
			wrap.appendChild(pre);
		}
		return d;
	};

	// ---------- scroll ----------
	const atBottom = () => timeline.scrollTop + timeline.clientHeight >= timeline.scrollHeight - 40;
	const jumpBtn = el("button", "jump-latest", "↓ Latest");
	jumpBtn.hidden = true;
	jumpBtn.addEventListener("click", () => {
		timeline.scrollTop = timeline.scrollHeight;
		jumpBtn.hidden = true;
	});
	document.body.appendChild(jumpBtn);

	const scrollMaybe = (force) => {
		if (force || atBottom()) {
			timeline.scrollTop = timeline.scrollHeight;
			jumpBtn.hidden = true;
		} else {
			jumpBtn.hidden = false;
		}
	};

	let runGroup = null;
	/** The current run's top-level section — bubble, worked group and result
	 *  card all live inside it so nothing escapes into a sibling run's area. */
	let runEl = null;
	/** @type {any} */
	let batchEl = null;
	/** @type {any} */
	let boardEl = null;
	let boardSig = "";
	/** True once the current run has emitted a board — stats read it, so a
	 *  plan-reuse run doesn't inherit the previous run's blocked counts. */
	let boardActive = false;
	const boardTasks = new Map();
	/** @type {any} */
	let progressEl = null;
	/** Newest plan doc this session produced — the result card links back to it. */
	let lastPlanPath = "";
	let lastCompactEl = null;
	let groupStats = { added: 0, removed: 0, files: new Set() };
	let streamMsg = null;
	let streamText = "";
	let streamReasoning = null;
	let reasoningText = "";
	let lastReasoningNorm = "";
	let thoughts = null;
	let mdTimer = 0;
	let lastVerb = "";

	const setEmptyMode = (empty) => timeline.classList.toggle("is-empty", empty);

	const add = (node) => {
		setEmptyMode(false);
		timeline.querySelector(".empty")?.remove();
		if (runGroup && !runGroup.isConnected) runGroup = null;
		if (runEl && !runEl.isConnected) runEl = null;
		// Work goes into the run's open group; run-level cards go into the run's
		// section; only content outside any run reaches the bare timeline.
		const target = runGroup?.querySelector(".group-body") ?? runEl ?? timeline;
		target.appendChild(node);
		scrollMaybe(true);
		persist();
	};

	const startGroup = () => {
		const group = el("details", "run-group");
		group.open = true;
		const summary = el("summary");
		summary.appendChild(el("span", "twisty", "›"));
		summary.appendChild(el("span", "group-title", "Working..."));
		group.appendChild(summary);
		const body = el("div", "group-body");
		group.appendChild(body);
		groupStats = { added: 0, removed: 0, files: new Set() };
		lastReasoningNorm = "";
		runGroup = group;
		batchEl = null;
		streamMsg = null;
		streamText = "";
		streamReasoning = null;
		reasoningText = "";
		thoughts = null;
		timeline.querySelector(".empty")?.remove();
		(runEl ?? timeline).appendChild(group);
	};

	const fmtDur = (secs) => {
		if (secs < 60) return `${secs}s`;
		const m = Math.floor(secs / 60), s = secs % 60;
		return s ? `${m}m ${s}s` : `${m}m`;
	};

	const updateGroupTitle = (prefix) => {
		if (!runGroup) return;
		const secs = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
		const diff = groupStats.added || groupStats.removed ? ` +${groupStats.added} −${groupStats.removed}` : "";
		const files = groupStats.files.size ? ` · ${groupStats.files.size} file${groupStats.files.size === 1 ? "" : "s"}` : "";
		// "Finished · worked for 45s" live, just "Finished" when no duration;
		// "Worked for 45s" live, "Worked" when the step took under a second.
		const title = secs > 0
			? `${prefix} ${fmtDur(secs)}`
			: prefix.replace(/ · worked for$/, "").replace(/\s+for$/, "");
		runGroup.querySelector(".group-title").textContent = `${title}${diff}${files}`;
	};

	// Ledger refs (t1, s3, s3–s4) render as small chips — the id stays terse and
	// the task/step it points at shows as a hover tooltip.
	const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
	const stepText = (id) => {
		for (const t of boardTasks.values()) {
			const s = (t.steps || []).find((x) => x.id === id);
			if (s) return s.text;
		}
		return "";
	};
	// {t1}/{s3} braces are explicit refs — always resolved. Bare t1/s3 resolves
	// only when it names a real board id, so prose like "the s3 bucket" or a
	// stray "t2" in code talk is left alone.
	const REF_RE = /\{[ts]\d+(?:\s*[–-]\s*s?\d+)?\}|\bt\d+\b|\bs\d+(?:\s*[–-]\s*s?\d+)?/g;
	const REF_TEST = /\{[ts]\d|\bt\d+\b|\bs\d+/;
	const refTip = (ref) =>
		ref[0] === "t"
			? boardTasks.get(ref)?.title
			: (ref.match(/s\d+/g) || []).map(stepText).filter(Boolean).join(" / ");
	const refChip = (ref, braced) => {
		// Step ids repeat across tasks — a bare "s3" is just prose (AWS S3 says hi);
		// steps resolve only through explicit {s3} braces. Task ids are board-unique.
		if (!braced && ref[0] === "s") return document.createTextNode(ref);
		const tip = refTip(ref);
		// An unresolvable bare token isn't a ref — emit it as ordinary text.
		if (!tip && !braced) return document.createTextNode(ref);
		const chip = el("span", "ref-chip");
		// Ledger ids are internal — the chip shows the work's name, the id stays in the tooltip.
		chip.textContent = tip ? clip(tip, 32) : ref;
		if (tip) chip.title = `${ref} · ${tip}`;
		return chip;
	};
	/** Split text into text nodes and ref chips. */
	const refNodes = (text) => {
		const nodes = [];
		let last = 0;
		for (const m of text.matchAll(REF_RE)) {
			const braced = m[0].startsWith("{");
			const id = braced ? m[0].slice(1, -1) : m[0];
			if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
			nodes.push(refChip(id, braced));
			last = m.index + m[0].length;
		}
		if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
		return nodes;
	};
	/** Wrap refs inside a rendered markdown tree; skips code and links. */
	const chipify = (root) => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) => (REF_TEST.test(n.nodeValue) ? (n.parentElement?.closest("code, pre, a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) : NodeFilter.FILTER_SKIP),
		});
		const targets = [];
		while (walker.nextNode()) targets.push(walker.currentNode);
		for (const n of targets) {
			const frag = document.createDocumentFragment();
			for (const part of refNodes(n.nodeValue)) frag.appendChild(part);
			n.parentNode.replaceChild(frag, n);
		}
	};

	// Inline `code` spans that spell a workspace file path open the file on click —
	// so "approve the plan at `.kronyx/plans/x.md`" is a link, not dead text.
	const PATH_EXT = /\.(md|ts|tsx|js|jsx|mjs|cjs|json|css|html|py|go|rs|toml|yaml|yml|txt|sh|sql|java|c|cc|cpp|h|hpp|rb|swift|kt|env|ini|cfg|xml|lock)$/i;
	const linkifyPaths = (root) => {
		for (const code of root.querySelectorAll("code")) {
			if (code.closest("pre")) continue;
			const t = code.textContent.trim();
			if (t.length < 3 || t.length > 240 || /\s/.test(t)) continue;
			if (!t.includes("/") && !PATH_EXT.test(t)) continue;
			code.classList.add("file-link");
			code.title = `Open ${t}`;
			code.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: t }));
		}
	};

	// First line of assistant text becomes a header line; the rest renders as markdown.
	const narrationNodes = (rawText) => {
		const idx = rawText.indexOf("\n");
		const rawHead = (idx === -1 ? rawText : rawText.slice(0, idx)).trim();
		const head = rawHead.length > 140 ? rawHead.slice(0, 140) + "…" : rawHead || "…";
		const headEl = el("div", "narration-head");
		headEl.append(...refNodes(head));
		const nodes = [headEl];
		if (idx !== -1) {
			const body = rawText.slice(idx + 1).trim();
			if (body) {
				const md = renderMd(body);
				chipify(md);
				linkifyPaths(md);
				nodes.push(md);
			}
		}
		return nodes;
	};

	// Each reasoning segment gets its own inline collapsed section at the position it occurs.
	const newThoughtSegment = (previewText) => {
		// Only the newest thoughts segment stays expanded; earlier ones collapse.
		runGroup?.querySelectorAll(".thoughts-group[open]").forEach((t) => (t.open = false));
		thoughts = el("details", "thoughts-group dim");
		thoughts.open = true;
		const s = el("summary");
		s.appendChild(el("span", "twisty", "›"));
		s.appendChild(el("span", "tool-name", "Thoughts"));
		s.appendChild(el("span", "thought-preview", previewText || ""));
		thoughts.appendChild(s);
		add(thoughts);
		return thoughts;
	};

	const firstLine = (text) => {
		const line = String(text).split("\n").find((l) => l.trim()) || "";
		return line.trim().length > 90 ? `${line.trim().slice(0, 90)}…` : line.trim();
	};

	const setThoughtPreview = (text) => {
		const p = thoughts?.querySelector(".thought-preview");
		if (p) p.textContent = firstLine(text);
	};

	const collapseEditCards = () => {
		runGroup?.querySelectorAll("details.diff-editor[data-state='done']").forEach((d) => (d.open = false));
	};

	const collapseAux = () => {
		runGroup?.querySelectorAll(".thoughts-group").forEach((t) => (t.open = false));
	};

	const closeGroup = (label) => {
		if (!runGroup) return;
		collapseAux();
		collapseEditCards();
		updateGroupTitle(label);
		runGroup.open = false;
		runGroup = null;
		batchEl = null;
	};

	// Work events lazily open a segment; assistant text closes it — yielding
	// sequential "Worked for Xs" sections interleaved with messages.
	const ensureSegment = () => {
		// A session reset/reload wipes the timeline but leaves runGroup pointing
		// at a detached node — appends there are invisible (timeline can't scroll
		// to them). Re-anchor when the group is no longer in the document.
		if (runGroup && !runGroup.isConnected) runGroup = null;
		if (!runGroup) startGroup();
	};

	// Tool calls from one model turn share a batch card: a count and duration on the
	// header, one row per call underneath. Calls without a turn number render alone.
	/** @param {any} batch */
	const updateBatch = (batch) => {
		const total = batch.querySelectorAll(":scope > .batch-body > .step.tool").length;
		const running = batch.querySelectorAll(":scope > .batch-body > .step.tool.running").length;
		// A one-call batch is its own card — hide the redundant header row.
		batch.classList.toggle("single", total === 1);
		const label = `${total} operation${total === 1 ? "" : "s"}`;
		const secs = Math.round((Date.now() - Number(batch.dataset.startedAt)) / 1000);
		batch.querySelector(".batch-title").textContent = running ? `Running ${label}…` : secs > 0 ? `${label} · ${fmtDur(secs)}` : label;
	};

	/** @param {any} card @param {any} iteration */
	const addToolCard = (card, iteration) => {
		if (iteration === undefined || iteration === null) return add(card);
		if (!batchEl || !batchEl.isConnected || batchEl.dataset.iteration !== String(iteration)) {
			batchEl = el("details", "tool-batch");
			batchEl.open = true;
			batchEl.dataset.iteration = String(iteration);
			batchEl.dataset.startedAt = String(Date.now());
			const head = el("summary");
			head.appendChild(el("span", "twisty", "›"));
			head.appendChild(el("span", "batch-title", ""));
			batchEl.appendChild(head);
			batchEl.appendChild(el("div", "batch-body"));
			add(batchEl);
		}
		batchEl.querySelector(".batch-body").appendChild(card);
		updateBatch(batchEl);
		scrollMaybe(true);
	};

	const setRunning = (running) => {
		sendBtn.hidden = running;
		stopBtn.hidden = !running;
		task.disabled = running;
		activity.classList.toggle("running", running);
	};

	const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
	// Events are stamped at persist time; replayed ones keep their real clock
	// time instead of all showing the replay moment.
	const evTime = (msg) =>
		new Date(typeof msg?.ts === "number" ? msg.ts : Date.now()).toLocaleTimeString([], {
			hour: "numeric",
			minute: "2-digit",
		});

	let statusText = "Idle";
	let elapsedTimer = 0;

	const activityFill = document.getElementById("activity-fill");
	const RING_C = 2 * Math.PI * 6; // r=6 in the 16x16 activity svg
	const contextWindow = () =>
		groups.find((g) => g.profile === modelProfile)?.models?.find((m) => m.id === modelId)?.contextWindow ||
		models.find((m) => m.id === modelId)?.contextWindow ||
		groups.flatMap((g) => g.models || []).find((m) => m.id === modelId)?.contextWindow ||
		0;
	const contextUsed = () => usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

	const updateActivityRing = () => {
		const ctx = contextWindow();
		const used = contextUsed();
		let frac = ctx > 0 ? Math.min(1, used / ctx) : 0;
		if (used > 0 && frac < 0.05) frac = 0.05; // keep a visible sliver once any tokens exist
		activityFill.style.strokeDasharray = `${RING_C}`;
		activityFill.style.strokeDashoffset = `${RING_C * (1 - frac)}`;
		activity.classList.toggle("warn", frac >= 0.7 && frac < 0.9);
		activity.classList.toggle("crit", frac >= 0.9);
		activity.classList.toggle("has-usage", used > 0);
		activity.title = ctx > 0
			? `Context ${(frac * 100).toFixed(0)}% — ${used.toLocaleString()} / ${ctx.toLocaleString()} tokens`
			: used > 0 ? `Context usage — ${used.toLocaleString()} tokens` : "Context usage";
		if (!contextPopover.hidden) renderContextPopover();
	};

	let contextPinned = false;
	let contextHideTimer = 0;

	const usageRow = (label, value) => {
		const row = el("div", "context-row");
		row.appendChild(el("span", "context-key", label));
		row.appendChild(el("span", "context-val", String(value)));
		return row;
	};

	const renderContextPopover = () => {
		contextPopover.innerHTML = "";
		const ctx = contextWindow();
		const used = contextUsed();
		const pct = ctx > 0 ? Math.min(100, Math.round((used / ctx) * 100)) : 0;
		const head = el("div", "context-head");
		head.appendChild(el("div", "context-title", ctx ? `${pct}% context used` : "Context usage"));
		head.appendChild(el("div", "context-sub", ctx ? `${used.toLocaleString()} of ${ctx.toLocaleString()} tokens` : `${used.toLocaleString()} tokens`));
		contextPopover.appendChild(head);
		const meter = el("div", "context-meter");
		const fill = el("span", "context-meter-fill");
		fill.style.width = `${Math.max(used > 0 ? 2 : 0, pct)}%`;
		if (pct >= 90) fill.classList.add("crit");
		else if (pct >= 70) fill.classList.add("warn");
		meter.appendChild(fill);
		contextPopover.appendChild(meter);
		const rows = el("div", "context-rows");
		rows.appendChild(usageRow("Input", usage.inputTokens.toLocaleString()));
		if (usage.cacheReadTokens) rows.appendChild(usageRow("Cached input", usage.cacheReadTokens.toLocaleString()));
		if (usage.cacheWriteTokens) rows.appendChild(usageRow("Cache write", usage.cacheWriteTokens.toLocaleString()));
		if (usage.outputTokens) rows.appendChild(usageRow("Output", usage.outputTokens.toLocaleString()));
		if (usage.reasoningTokens) rows.appendChild(usageRow("Reasoning", usage.reasoningTokens.toLocaleString()));
		if (usage.contextMsgs) rows.appendChild(usageRow("Messages", usage.contextMsgs.toLocaleString()));
		if (usage.iteration) rows.appendChild(usageRow("Iteration", usage.iteration.toLocaleString()));
		if (usage.contextBudget) rows.appendChild(usageRow("Compaction budget", usage.contextBudget.toLocaleString()));
		if (usage.totalCost) rows.appendChild(usageRow("Provider cost", `$${usage.totalCost < 0.01 ? usage.totalCost.toFixed(4) : usage.totalCost.toFixed(2)}`));
		contextPopover.appendChild(rows);
		contextPopover.appendChild(el("div", "context-note", "Values are provider-reported usage for this run."));
	};

	const showContextPopover = (pinned) => {
		clearTimeout(contextHideTimer);
		contextPinned = pinned;
		renderContextPopover();
		contextPopover.hidden = false;
		activity.setAttribute("aria-expanded", "true");
		const rect = activity.getBoundingClientRect();
		const width = contextPopover.offsetWidth;
		contextPopover.style.left = `${Math.max(8, Math.min(rect.right - width, document.body.clientWidth - width - 8))}px`;
		contextPopover.style.bottom = `${document.body.clientHeight - rect.top + 8}px`;
		contextPopover.style.top = "auto";
	};

	const hideContextPopover = () => {
		contextPinned = false;
		contextPopover.hidden = true;
		activity.setAttribute("aria-expanded", "false");
	};

	const scheduleContextHide = () => {
		clearTimeout(contextHideTimer);
		contextHideTimer = setTimeout(() => {
			if (!contextPinned) hideContextPopover();
		}, 220);
	};

	activity.addEventListener("mouseenter", () => showContextPopover(contextPinned));
	activity.addEventListener("mouseleave", scheduleContextHide);
	activity.addEventListener("focus", () => showContextPopover(contextPinned));
	activity.addEventListener("blur", scheduleContextHide);
	activity.addEventListener("click", () => {
		if (!contextPopover.hidden && contextPinned) hideContextPopover();
		else showContextPopover(true);
	});
	contextPopover.addEventListener("mouseenter", () => clearTimeout(contextHideTimer));
	contextPopover.addEventListener("mouseleave", scheduleContextHide);
	document.addEventListener("mousedown", (e) => {
		if (!contextPopover.hidden && e.target instanceof Node && !contextPopover.contains(e.target) && e.target !== activity && !activity.contains(e.target)) {
			hideContextPopover();
		}
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") hideContextPopover();
	});

	const setStatus = (text) => {
		statusText = text;
		const total = usage.inputTokens + usage.outputTokens;
		const elapsed = startedAt ? ` · ${((Date.now() - startedAt) / 1000).toFixed(0)}s` : "";
		status.textContent = (text === "Running..." && lastVerb ? lastVerb : text) + elapsed;
		updateActivityRing();
		tokchip.hidden = total === 0;
		if (total > 0) {
			tokchip.textContent = `in ${fmt(usage.inputTokens)} · out ${fmt(usage.outputTokens)}` +
				(usage.cacheReadTokens > 0 ? ` · cached ${fmt(usage.cacheReadTokens)}` : "");
			tokchip.title = `Tokens — input ${usage.inputTokens.toLocaleString()}, output ${usage.outputTokens.toLocaleString()}, cache read ${usage.cacheReadTokens.toLocaleString()}, cache write ${usage.cacheWriteTokens.toLocaleString()}`;
		}
	};

	const startTimer = () => {
		clearInterval(elapsedTimer);
		elapsedTimer = setInterval(() => {
			if (statusText.startsWith("Running")) {
				setStatus("Running...");
				updateGroupTitle("Working for");
				// Tick live elapsed labels on running action cards.
				const secs = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
				for (const n of timeline.querySelectorAll(".live-elapsed")) n.textContent = `${fmtDur(secs)}`;
			}
		}, 1000);
	};
	const stopTimer = () => {
		clearInterval(elapsedTimer);
		elapsedTimer = 0;
		startedAt = 0;
	};

	const describeInput = (name, input) => {
		if (typeof input === "string") {
			try { input = JSON.parse(input); } catch { return input.length > 90 ? input.slice(0, 87) + "…" : input; }
		}
		if (!input || typeof input !== "object") return "";
		const p = input.path ?? input.pattern ?? input.command ?? input.cmd ?? "";
		if (name === "run_command") return String(p).replace(/\s+/g, " ").slice(0, 90);
		if (name === "list_files") return p === "." ? "repo root" : String(p);
		if (name === "read_file" && input.start_line) return `${p} (${input.start_line}-${input.end_line ?? "end"})`;
		if (name === "edit_file" && Array.isArray(input.edits)) return `${p} (${input.edits.length} edit(s))`;
		if (name === "read_files" && Array.isArray(input.files)) {
			const names = input.files.map((f) => String(f?.path ?? "")).filter(Boolean);
			const list = names.join(", ");
			return list.length > 90 ? `${names[0]} +${names.length - 1} more` : list;
		}
		return String(p);
	};

	/** Result rollup for the collapsed tool row, e.g. "1,204 lines", "3 matches". */
	const resultDetail = (name, output) => {
		const lines = String(output || "").split("\n").filter((l) => l.trim());
		const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
		if (!lines.length) return "";
		if (name === "read_file") {
			const n = lines.filter((l) => /^\s*\d+\|/.test(l)).length;
			return n ? plural(n, "line", "lines") : "";
		}
		if (name === "list_files") return plural(lines.length, "entry", "entries");
		if (name === "search_files") return plural(lines.filter((l) => /:\d+:/.test(l)).length, "match", "matches");
		return "";
	};

	const fmtMs = (ms) => {
		ms = Number(ms) || 0;
		if (ms < 1000) return "";
		const s = ms / 1000;
		return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
	};

	const copyIconButton = (text, title) => {
		const copy = el("button", "perm-copy");
		copy.type = "button";
		copy.title = title;
		copy.setAttribute("aria-label", title);
		copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
		copy.addEventListener("click", async (e) => {
			e.stopPropagation();
			try {
				await navigator.clipboard.writeText(text);
				copy.classList.add("copied");
				copy.title = "Copied";
				setTimeout(() => {
					copy.classList.remove("copied");
					copy.title = title;
				}, 1400);
			} catch {
				copy.title = "Copy failed";
			}
		});
		return copy;
	};

	const commandResult = (raw, ok) => {
		const clean = prettyOut(String(raw || "")).replace(/\x1b\[[0-9;]*m/g, "").trim();
		const match = /^exit\s+(-?\d+)\s*(?:\n|$)/i.exec(clean);
		return {
			code: match ? Number(match[1]) : ok ? 0 : 1,
			text: match ? clean.slice(match[0].length).trim() : clean,
		};
	};

	/** Unwrap {"error": "…"} JSON envelopes so failures read as text. */
	const prettyOut = (raw) => {
		const t = String(raw || "").trim();
		if (t.startsWith("{")) {
			try {
				const j = JSON.parse(t);
				const msg = j.error ?? j.message;
				if (typeof msg === "string") return msg;
			} catch { /* not JSON */ }
		}
		return raw;
	};

	/** Numbered unified-diff rows: new-file numbers for +/ctx, old for −. */
	const LANG_BY_EXT = {
		ts: ["typescript", "TS"], tsx: ["typescript", "TSX"], js: ["javascript", "JS"], jsx: ["javascript", "JSX"],
		mjs: ["javascript", "JS"], cjs: ["javascript", "JS"], json: ["json", "JSON"], py: ["python", "PY"],
		css: ["css", "CSS"], html: ["xml", "HTML"], htm: ["xml", "HTML"], xml: ["xml", "XML"], svg: ["xml", "SVG"],
		sh: ["bash", "SH"], bash: ["bash", "SH"], zsh: ["bash", "SH"], md: ["markdown", "MD"], go: ["go", "GO"], rs: ["rust", "RS"],
	};
	/** Highlight.js language id + short badge + split name/dir for a file path. */
	const fileLang = (path) => {
		const full = String(path || "");
		const name = full.split("/").pop() || "";
		const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
		const [lang, badge] = LANG_BY_EXT[ext] || [null, ext.slice(0, 4).toUpperCase() || "TXT"];
		return { lang, badge, name, dir: full.slice(0, full.length - name.length).replace(/\/$/, "") };
	};
	const normPath = (p) => String(p ?? "").replace(/^\.\//, "").replace(/^\/+/, "");
	const parseInput = (input) => {
		if (typeof input === "string") {
			try { return JSON.parse(input) ?? {}; } catch { return {}; }
		}
		return input && typeof input === "object" ? input : {};
	};

	/** One diff code line, highlighted when the language is bundled (media/highlight.js). */
	const codeCell = (text, lang) => {
		const span = el("span", "fd-code");
		const hl = /** @type {any} */ (globalThis).hljs;
		if (lang && text && hl?.getLanguage?.(lang)) span.innerHTML = hl.highlight(text, { language: lang, ignoreIllegals: true }).value;
		else span.textContent = text || " ";
		return span;
	};
	const renderDiffRows = (rows, lang, truncated) => {
		const pre = el("div", "diff-body");
		for (const r of rows) {
			if (r.cls === "fd-fold") {
				pre.appendChild(el("div", "fd-fold", "⋯"));
				continue;
			}
			const line = el("div", `fd-row ${r.cls}`);
			line.appendChild(el("span", "fd-num", r.num ? String(r.num) : ""));
			line.appendChild(codeCell(r.text, lang));
			pre.appendChild(line);
		}
		if (truncated) pre.appendChild(el("div", "fd-trunc", "…truncated…"));
		return pre;
	};
	// Parses formatUnifiedWithContext / formatHunks text. Numbers appear only when the text has @@ headers.
	const parseDiffRows = (diff, cap = 400) => {
		const rows = [];
		let oldN = 0, newN = 0, truncated = false, numbered = false;
		const num = (n) => (numbered ? n : 0);
		for (const l of String(diff || "").split("\n")) {
			const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
			if (h) {
				numbered = true;
				oldN = Number(h[1]);
				newN = Number(h[2]);
				if (rows.length) rows.push({ cls: "fd-fold" });
				continue;
			}
			if (/^… \(\d+ more lines\)$/.test(l)) { truncated = true; break; }
			if (l === "…") { rows.push({ cls: "fd-fold" }); continue; }
			if (rows.length >= cap) { truncated = true; break; }
			if (l.startsWith("+")) rows.push({ num: num(newN++), cls: "fd-l-add", text: l.slice(1) });
			else if (l.startsWith("-")) rows.push({ num: num(oldN++), cls: "fd-l-del", text: l.slice(1) });
			else if (l.startsWith(" ")) rows.push({ num: num(newN++), cls: "fd-l-ctx", text: l.slice(1) });
		}
		return { rows, truncated };
	};
	/** Finished write: numbered lines with context, highlighted for the file's language. */
	const renderEditorDiff = (diff, path) => {
		const { rows, truncated } = parseDiffRows(diff);
		return renderDiffRows(rows, fileLang(path).lang, truncated);
	};

	const READ_TOOLS = new Set(["read_file", "read_files"]);
	/** Read results as an editor view: one highlighted, numbered block per file
	 *  (### path sections from read_files; bare "path (lines a-b of n)" for read_file). */
	const renderReadOutput = (text, cap = 400) => {
		const wrap = el("div", "readout");
		const rawChunks = [];
		// Split into sections; text before the first ### belongs to the first (unnamed) section.
		const parts = String(text).split(/^### /m);
		for (const [pi, part] of parts.entries()) {
			if (!part.trim()) continue;
			let section = pi === 0 ? part : part; // header text is part of the section lines
			let headPath = "";
			if (pi > 0) {
				const nl = section.indexOf("\n");
				headPath = (nl === -1 ? section : section.slice(0, nl)).replace(/\s+\(failed\)\s*$/, "").trim();
				section = nl === -1 ? "" : section.slice(nl + 1);
			}
			const lines = section.split("\n");
			let path = headPath, meta = "";
			// Meta line: "path (lines a-b of n)." — may repeat the section path or stand alone.
			const metaMatch = lines[0] && /^(.*?) \(lines \d+[-–](?:\d+|end) of \d+\)/.exec(lines[0]);
			if (metaMatch) {
				path = path || metaMatch[1].trim();
				meta = /\(lines .*$/.exec(lines[0])?.[0] || "";
				lines.shift();
			}
			const rows = [];
			const rest = [];
			let truncated = false;
			for (const l of lines) {
				const m = /^\s*(\d+)\| ?(.*)$/.exec(l);
				if (m) {
					if (rows.length >= cap) truncated = true;
					else rows.push({ num: Number(m[1]), cls: "fd-l-ctx", text: m[2] });
				} else if (l.trim()) rest.push(l);
			}
			if (!rows.length) {
				rawChunks.push((pi > 0 ? `### ${part}` : part).trim());
				continue;
			}
			if (path || meta) {
				const head = el("div", "ro-head");
				head.appendChild(el("span", "ro-path", path));
				if (meta) head.appendChild(el("span", "ro-meta", meta));
				wrap.appendChild(head);
			}
			wrap.appendChild(renderDiffRows(rows, fileLang(path).lang, truncated));
			if (rest.length) wrap.appendChild(el("pre", "io", rest.join("\n")));
		}
		for (const chunk of rawChunks) wrap.appendChild(el("pre", "io", chunk));
		return wrap;
	};

	const EDIT_TOOLS = new Set(["edit_file", "write_file", "append_file", "insert_lines"]);
	/** Proposed lines for an edit call — available as soon as the call starts, before the write runs. */
	const previewRows = (name, input, cap = 200) => {
		const rows = [];
		let truncated = false;
		const lines = (s) => (s ? String(s).replace(/\n$/, "").split("\n") : []);
		const push = (cls, text) => {
			if (rows.length >= cap) truncated = true;
			else rows.push({ num: 0, cls, text });
		};
		if (name === "edit_file" && Array.isArray(input?.edits)) {
			input.edits.forEach((e, i) => {
				if (i > 0) rows.push({ cls: "fd-fold" });
				for (const l of lines(e?.old_text)) push("fd-l-del", l);
				for (const l of lines(e?.new_text)) push("fd-l-add", l);
			});
		} else {
			for (const l of lines(input?.content)) push("fd-l-add", l);
		}
		return { rows, truncated };
	};

	/** Head of an editor card: language badge, file name, dir, +/- totals, and status. */
	const editorHead = (path, { added = 0, removed = 0, status = "", cls = "" } = {}) => {
		const { badge, name, dir } = fileLang(path);
		const head = el("summary", "diff-editor-head");
		head.appendChild(el("span", "diff-lang", badge));
		const fileName = el("span", "diff-file-name", name || path || "file");
		fileName.title = path;
		head.appendChild(fileName);
		if (dir) head.appendChild(el("span", "diff-dir", dir));
		const stats = el("span", "file-stats");
		if (added) stats.appendChild(el("span", "stat-add", `+${added}`));
		if (removed) stats.appendChild(el("span", "stat-del", `−${removed}`));
		head.appendChild(stats);
		head.appendChild(el("span", `diff-status ${cls}`.trim(), status));
		return head;
	};
	const setEditStatus = (card, text, cls = "") => {
		const s = card.querySelector(".diff-status");
		if (!s) return;
		s.textContent = text;
		s.className = `diff-status ${cls}`.trim();
	};
	/** Icon actions shared by edit cards and standalone file rows. */
	const fileActions = (path, target) => {
		const actions = el("span", "file-actions");
		for (const [label, type, title] of [["↗", "review", "Open diff"], ["✓", "acceptChange", "Accept changes"], ["✗", "rejectChange", "Revert file"]]) {
			const btn = el("button", "file-btn", label);
			btn.title = title;
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				vscode.postMessage({ type, path });
				if (type !== "review") target.remove();
			});
			actions.appendChild(btn);
		}
		return actions;
	};
	const pendingEdits = [];
	const pendingEditCard = (name, input, path) => {
		const card = el("details", "diff-editor pending");
		card.dataset.state = "pending";
		card.open = true;
		card.appendChild(editorHead(path, { status: "Editing…", cls: "pending" }));
		const { rows, truncated } = previewRows(name, input);
		card.appendChild(renderDiffRows(rows, fileLang(path).lang, truncated));
		return card;
	};
	const takePending = (path) => {
		const key = normPath(path);
		const i = pendingEdits.findIndex((e) => e.path === key);
		return i < 0 ? null : pendingEdits.splice(i, 1)[0].card;
	};
	const dropPending = (card) => {
		const i = pendingEdits.findIndex((e) => e.card === card);
		if (i >= 0) pendingEdits.splice(i, 1);
	};
	/** Fills an edit card in place: header with totals/actions, then the real diff when present. */
	const fillEditorCard = (card, { path, diff = "", added = 0, removed = 0, status = "", cls = "" }) => {
		card.classList.remove("pending");
		card.dataset.state = "done";
		card.open = startedAt > 0;
		const head = editorHead(path, { added, removed, status, cls });
		head.appendChild(fileActions(path, card));
		card.replaceChildren(head);
		if (diff) card.appendChild(renderEditorDiff(diff, path));
	};
	/** Marks edit cards whose result never arrived (stop, failure, or restore mid-edit). */
	// A paused run's Continue/Stop only works while its agent is alive; any
	// terminal event (or a replayed one) retires those buttons.
	const retirePaused = () => {
		for (const n of timeline.querySelectorAll(".paused-actions")) n.remove();
	};
	const settlePending = (label) => {
		for (const { card } of pendingEdits) {
			if (card.dataset.state !== "pending") continue;
			card.classList.remove("pending");
			card.dataset.state = "interrupted";
			setEditStatus(card, label, "muted");
		}
		pendingEdits.length = 0;
	};

	/** Per-run counters for the summary card — reset on run-started. */
	let runStats = { toolsFailed: 0, checksPassed: 0, checksFailed: 0, files: new Map() };
	const resetRunStats = () => { runStats = { toolsFailed: 0, checksPassed: 0, checksFailed: 0, files: new Map() }; };

	const TOOL_STYLE = {
		read_file: ["📄", "Read", "Reading"],
		read_files: ["📄", "Read", "Reading"],
		list_files: ["🔍", "Listed", "Listing"],
		search_files: ["🔍", "Searched", "Searching"],
		write_file: ["✎", "Wrote", "Writing"],
		edit_file: ["✎", "Edited", "Editing"],
		append_file: ["✎", "Appended", "Appending"],
		insert_lines: ["✎", "Edited", "Editing"],
		run_command: ["›_", "Ran", "Running"],
		memory_write: ["✦", "Saved", "Saving"],
	};
	const toolVerb = (name) => TOOL_STYLE[name] || ["⛭", name, name];

	const showEmpty = () => {
		setEmptyMode(true);
		timeline.innerHTML = "";
		timeline.scrollTop = 0;
		const empty = el("div", "empty");
		const hero = el("div", "empty-hero");
		const logo = el("div", "empty-logo");
		logo.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4v16"/><path d="M19 4l-9 8 9 8"/><circle cx="10" cy="12" r="1.5" fill="currentColor"/></svg>';
		hero.appendChild(logo);
		hero.appendChild(el("div", "empty-kicker", "Kronyx · Agentic engineering in your editor"));
		hero.appendChild(el("h1", "empty-headline", "From prompts to production."));
		hero.appendChild(el("p", "empty-copy", "Understand your code, make changes, and verify them before you ship."));
		hero.appendChild(el("div", "empty-sub", "Try a starting point"));
		const list = el("div", "empty-prompts");
		for (const p of ["Explain this codebase", "Fix a bug in the open file"]) {
			const b = el("button", "prompt-chip", p);
			b.addEventListener("click", () => {
				task.value = p;
				autogrow();
				task.focus();
				persist();
			});
			list.appendChild(b);
		}
		hero.appendChild(list);
		empty.appendChild(hero);
		timeline.appendChild(empty);
	};

	// ---------- composer ----------

	const autogrow = () => {
		task.style.height = "auto";
		task.style.height = `${Math.min(task.scrollHeight, 160)}px`;
	};
	task.addEventListener("input", () => {
		autogrow();
		persist();
	});

	const submit = () => {
		const text = task.value.trim();
		if (!text || sendBtn.hidden) return;
		vscode.postMessage(cloudEnv ? { type: "runCloud", task: text, mode } : { type: "run", task: text, mode, pick: { modelId, profile: modelProfile }, engine });
		task.value = "";
		attachments.clear();
		attachmentPreviews.replaceChildren();
		attachmentPreviews.hidden = true;
		autogrow();
		persist();
	};

	task.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	});
	sendBtn.addEventListener("click", submit);
	stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));



	// ---------- popup menu ----------

	const closeMenu = () => {
		menu.hidden = true;
		menu.innerHTML = "";
	};

	document.addEventListener("mousedown", (e) => {
		if (!menu.hidden && !menu.contains(/** @type {Node} */ (e.target)) && !(e.target instanceof HTMLElement && e.target.closest(".chip, .icon-btn"))) {
			closeMenu();
		}
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") closeMenu();
	});

	/**
	 * @param {HTMLElement} anchor
	 * @param {{search?: boolean, wide?: boolean, below?: boolean, items: any[]}} config
	 * items: {header} | {icon, label, desc, checked, disabled, onPick}
	 */
	const openMenu = (anchor, config) => {
		if (!menu.hidden && menu.dataset.anchor === anchor.id) {
			closeMenu();
			return;
		}
		menu.innerHTML = "";
		menu.dataset.anchor = anchor.id;
		menu.classList.toggle("wide", !!config.wide);
		if (config.search) {
			const input = el("input", "menu-search");
			input.placeholder = "Search all models";
			input.addEventListener("input", () => {
				const q = input.value.toLowerCase();
				for (const item of menu.querySelectorAll(".menu-item")) {
					item.classList.toggle("filtered-out", !item.textContent?.toLowerCase().includes(q));
				}
				for (const header of menu.querySelectorAll(".menu-header")) {
					let node = header.nextElementSibling;
					let visible = false;
					while (node && !node.classList.contains("menu-header")) {
						if (!node.classList.contains("filtered-out")) visible = true;
						node = node.nextElementSibling;
					}
					header.classList.toggle("filtered-out", !visible && input.value.length > 0);
				}
			});
			menu.appendChild(input);
			setTimeout(() => input.focus(), 0);
		}
		if (config.chips) {
			const row = el("div", "menu-chips");
			for (const c of config.chips) {
				const b = el("button", c.active ? "menu-chip on" : "menu-chip", c.label);
				b.addEventListener("click", (e) => {
					e.stopPropagation();
					c.onPick();
				});
				row.appendChild(b);
			}
			menu.appendChild(row);
		}
		const list = el("div", "menu-list");
		for (const item of config.items) {
			if (item.header) {
				list.appendChild(el("div", "menu-header", item.header));
				continue;
			}
			const row = el("div", `menu-item${item.disabled ? " disabled" : ""}`);
			if (item.icon) row.appendChild(el("span", "menu-icon", item.icon));
			const col = el("div", "menu-text");
			col.appendChild(el("div", "menu-label", item.label));
			if (item.desc) col.appendChild(el("div", "menu-desc", item.desc));
			row.appendChild(col);
			if (item.onInfo) {
				const info = el("button", "menu-info", "ⓘ");
				info.title = "Model details";
				info.addEventListener("click", (e) => {
					e.stopPropagation();
					item.onInfo();
				});
				row.appendChild(info);
			}
			if (item.checked) row.appendChild(el("span", "menu-check", "✓"));
			if (!item.disabled) {
				row.addEventListener("click", () => {
					closeMenu();
					item.onPick?.();
				});
			}
			list.appendChild(row);
		}
		menu.appendChild(list);
		menu.hidden = false;
		const rect = anchor.getBoundingClientRect();
		const menuHeight = menu.offsetHeight;
		menu.style.left = `${Math.max(4, rect.left)}px`;
		if (config.below) {
			menu.style.top = `${rect.bottom + 6}px`;
			menu.style.bottom = "auto";
		} else {
			menu.style.bottom = `${document.body.clientHeight - rect.top + 6}px`;
			menu.style.top = "auto";
		}
		if (menu.offsetWidth + rect.left > document.body.clientWidth) {
			menu.style.left = `${Math.max(4, document.body.clientWidth - menu.offsetWidth - 4)}px`;
		}
		void menuHeight;
	};

	// ---------- chips ----------

	const modeLabelFor = (id) => MODES.find((m) => m.id === id)?.label ?? id;

	/** @type {Record<string, string>} */
	const ENGINE_LABELS = { cline: "Cline SDK", openai: "OpenAI" };
	/** @type {Record<string, string>} */
	const ENGINE_DESCS = {
		cline: "Cline SDK transport: any provider, including Anthropic",
		openai: "OpenAI transport: Responses for OpenAI, chat completions elsewhere",
	};

	const MODE_ICONS = { code: "</>", smart: "✦", ask: "◯", plan: "≡", bypass: "⛨" };
	const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
	const MODE_SVGS = {
		code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
		smart: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>'),
		ask: svg('<circle cx="12" cy="12" r="9"/><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4.5"/><line x1="12" y1="17.5" x2="12" y2="17.6"/>'),
		plan: svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
		bypass: svg('<path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="M4 4l16 16"/>'),
	};

	const MODE_PLACEHOLDERS = {
		ask: "Ask a question about the codebase…",
		plan: "Describe what to plan…",
	};

	const refreshChips = () => {
		modeLabel.textContent = modeLabelFor(mode);
		engineLabel.textContent = ENGINE_LABELS[engine];
		document.getElementById("mode-icon").innerHTML = MODE_SVGS[mode] || MODE_SVGS.code;
		// Selection identity is the pair profile|modelId — look up the label in
		// the picked profile's catalog first so a same-id model elsewhere can't win.
		const found = groups.find((g) => g.profile === modelProfile)?.models?.find((m) => m.id === modelId) ||
			groups.flatMap((g) => g.models || []).find((m) => m.id === modelId) ||
			models.find((m) => m.id === modelId);
		const name = found?.label || modelId || "Model";
		// Only prefix the picked profile — never guess it from a first-match in
		// another group (the same model id can exist under multiple providers).
		modelLabel.textContent = modelProfile ? `${modelProfile} · ${name}` : name;
		task.placeholder = MODE_PLACEHOLDERS[mode] || "Ask, plan, or describe a change…";
	};

	modeBtn.addEventListener("click", () => {
		openMenu(modeBtn, {
			items: MODES.map((m) => ({
				icon: MODE_ICONS[m.id],
				label: m.label,
				desc: m.desc,
				checked: m.id === mode,
				onPick: () => {
					mode = m.id;
					refreshChips();
					persist();
					vscode.postMessage({ type: "setMode", mode });
				},
			})),
		});
	});

	engineBtn.addEventListener("click", () => {
		openMenu(engineBtn, {
			items: ENGINES.map((id) => ({
				label: ENGINE_LABELS[id],
				desc: ENGINE_DESCS[id],
				checked: id === engine,
				onPick: () => {
					engine = id;
					refreshChips();
					persist();
					vscode.postMessage({ type: "setEngine", engine });
				},
			})),
		});
	});

	const reopenModelMenu = () => {
		menu.dataset.anchor = "";
		showModelMenu();
	};
	const showModelMenu = () => {
		const pool = groups.length > 0 ? groups : [{ profile: "", active: true, models }];
		const scoped = pool.filter((g) => !providerFilter || g.profile === providerFilter);
		const all = scoped.flatMap((g) => g.models.map((m) => ({ m, profile: g.profile })));
		const recent = recentModels
			// Entries are {id, profile}; legacy persisted entries are bare ids — resolve those against the current profile.
			.map((r) => all.find((e) => e.m.id === (typeof r === "string" ? r : r.id) && e.profile === (typeof r === "string" ? modelProfile : r.profile)))
			.filter(Boolean);
		const items = [];
		if (recent.length > 0) {
			items.push({ header: "Recently used" });
			for (const e of recent) items.push(modelItem(e.m, e.profile));
		}
		for (const g of scoped) {
			items.push({ header: groups.length > 0 ? `${g.profile}${g.active ? " · active" : ""}` : recent.length > 0 ? "All models" : "Models" });
			if (g.models.length === 0) items.push({ label: modelId || "No models loaded", disabled: true });
			for (const m of g.models) items.push(modelItem(m, g.profile));
		}
		const chips =
			pool.length > 1
				? [
						{ label: "All", active: !providerFilter, onPick: () => { providerFilter = ""; reopenModelMenu(); } },
						...pool.map((g) => ({
							label: g.active ? `${g.profile} · active` : g.profile,
							active: providerFilter === g.profile,
							onPick: () => { providerFilter = g.profile; reopenModelMenu(); },
						})),
					]
				: undefined;
		openMenu(modelBtn, { search: true, wide: true, chips, items });
	};
	modelBtn.addEventListener("click", showModelMenu);

	const fmtToks = (n) => (n == null ? "" : n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
	const fmtPrice = (v) => {
		if (v == null) return "";
		const perM = v * 1e6;
		return `$${perM >= 100 ? perM.toFixed(0) : perM >= 1 ? perM.toFixed(2) : perM.toFixed(3)}`;
	};
	const modelDesc = (m) => {
		const parts = [];
		if (m.label && m.label !== m.id) parts.push(m.id);
		if (m.contextWindow) parts.push(`${fmtToks(m.contextWindow)} ctx`);
		if (m.maxTokens) parts.push(`${fmtToks(m.maxTokens)} out`);
		if (m.pricing?.input != null || m.pricing?.output != null)
			parts.push(`${fmtPrice(m.pricing?.input)}/${fmtPrice(m.pricing?.output)} per Mtok`);
		const modalities = [m.modalities?.input?.join("+"), m.modalities?.output?.join("+")].filter(Boolean).join("→");
		if (modalities && modalities !== "text→text") parts.push(modalities);
		if (m.tags?.length) parts.push(m.tags.slice(0, 3).join(", "));
		return parts.join(" · ");
	};

	/** Record a pick and tell the host which provider profile it belongs to (pins the run's provider). */
	const chooseModel = (m, profile) => {
		modelId = m.id;
		modelProfile = profile || "";
		recentModels = [{ id: m.id, profile: modelProfile }, ...recentModels.filter((r) => (typeof r === "string" ? r : r.id) !== m.id || (typeof r === "string" ? modelProfile : r.profile) !== modelProfile)].slice(0, 3);
		refreshChips();
		updateActivityRing();
		persist();
		vscode.postMessage({ type: "setModel", modelId, profile: modelProfile || undefined });
	};

	const modelItem = (m, profile) => ({
		label: profile ? `${profile} / ${m.label || m.id}` : m.label || m.id,
		desc: modelDesc(m) || m.description?.slice(0, 120),
		checked: m.id === modelId && (modelProfile ? profile === modelProfile : !profile),
		onInfo: () => showModelDetail(m, profile),
		onPick: () => chooseModel(m, profile),
	});

	const showModelDetail = (m, profile) => {
		const overlay = el("div", "detail-overlay");
		const card = el("div", "detail-card");
		const head = el("div", "detail-head");
		const back = el("button", "detail-back", "← Back");
		back.title = "Back to model list";
		back.addEventListener("click", () => overlay.remove());
		head.appendChild(back);
		const title = el("div", "detail-title");
		title.appendChild(el("div", "detail-name", m.label || m.id));
		if (m.label && m.label !== m.id) title.appendChild(el("div", "detail-id", m.id));
		head.appendChild(title);
		const actions = el("div", "detail-actions");
		const use = el("button", "detail-use", "Use model");
		use.addEventListener("click", () => {
			chooseModel(m, profile);
			overlay.remove();
			closeMenu();
		});
		actions.appendChild(use);
		const close = el("button", "detail-close", "✕");
		close.title = "Close";
		close.addEventListener("click", () => {
			overlay.remove();
			closeMenu();
		});
		actions.appendChild(close);
		head.appendChild(actions);
		card.appendChild(head);
		const fmtDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");
		const perTok = (v) => (v == null ? "" : `$${v} / tok`);
		const rows = [
			["ID", m.id],
			["Owner", m.owner],
			["Context", m.contextWindow ? `${m.contextWindow.toLocaleString()} tok` : ""],
			["Max output", m.maxTokens ? `${m.maxTokens.toLocaleString()} tok` : ""],
			["Modalities", [m.modalities?.input?.join("+"), m.modalities?.output?.join("+")].filter(Boolean).join("→")],
			["Input price", m.pricing?.input != null ? `${fmtPrice(m.pricing.input)} / Mtok (${perTok(m.pricing.input)})` : ""],
			["Output price", m.pricing?.output != null ? `${fmtPrice(m.pricing.output)} / Mtok (${perTok(m.pricing.output)})` : ""],
			["Tags", (m.tags || []).join(", ")],
			["Parameters", (m.supportedParameters || []).join(", ")],
			["Reasoning", (m.reasoning || []).join(", ")],
			["Knowledge", m.knowledgeCutoff],
			["Released", fmtDate(m.releasedAt)],
		];
		const grid = el("div", "detail-grid");
		for (const [k, v] of rows) {
			if (!v) continue;
			const item = el("div", "detail-item");
			item.appendChild(el("span", "detail-key", k));
			item.appendChild(el("span", "detail-val", String(v)));
			grid.appendChild(item);
		}
		card.appendChild(grid);
		if (m.description) card.appendChild(el("p", "detail-desc", m.description));
		overlay.appendChild(card);
		overlay.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			if (e.target === overlay) overlay.remove();
		});
		document.body.appendChild(overlay);
	};

	attachBtn.addEventListener("click", () => {
		const pick = (kind) => () => vscode.postMessage({ type: "attach", kind });
		openMenu(attachBtn, {
			items: [
				{ icon: "⇪", label: "Upload file", onPick: pick("upload") },
				{ header: "Context" },
				{ icon: "</>", label: "Files", onPick: pick("file") },
				{ icon: "⬒", label: "Directories", onPick: pick("directory") },
				{ icon: "✦", label: "Skills", desc: "Coming soon", disabled: true },
				{ icon: "❞", label: "Conversations", desc: "Coming soon", disabled: true },
				{ icon: "⑂", label: "Git", desc: "Coming soon", disabled: true },
				{ icon: "⌘", label: "MCP servers", desc: "Coming soon", disabled: true },
				{ icon: "§", label: "Rules", desc: "Coming soon", disabled: true },
				{ icon: "≣", label: "Plans", desc: "Coming soon", disabled: true },
				{ icon: "›_", label: "Terminal", desc: "Coming soon", disabled: true },
				{ icon: "◎", label: "Codemaps", desc: "Coming soon", disabled: true },
				{ icon: "/", label: "Slash commands", desc: "Coming soon", disabled: true },
				{ header: "Run target" },
				{ icon: "⌂", label: "Local", desc: "Run in this workspace", checked: !cloudEnv, onPick: () => { cloudEnv = false; persist(); } },
				{ icon: "☁", label: "Cloud", desc: "Run in an E2B sandbox", checked: cloudEnv, onPick: () => { cloudEnv = true; persist(); } },
				{ header: "Context actions" },
				{ icon: "≋", label: "Compact context", desc: "Next model turn", onPick: () => vscode.postMessage({ type: "compact" }) },
				{ icon: "⌫", label: "Clear context", desc: "Next task starts fresh", onPick: () => vscode.postMessage({ type: "clearContext" }) },
			],
		});
	});

	mentionBtn.addEventListener("click", () => vscode.postMessage({ type: "attach", kind: "file" }));

	refreshChips();
	autogrow();
	showEmpty();
	vscode.postMessage({ type: "requestState" });

	// ---------- events ----------

	// Run-scoped step counter: iteration fields on this run's events give the
	// true span, so old stored run-finished payloads (which recorded the
	// session-cumulative turn) don't misreport.
	let iterMin = 0;
	let iterMax = 0;

	window.addEventListener("message", (event) => {
		const msg = event.data;
		if (typeof msg.iteration === "number" && msg.iteration > 0) {
			iterMax = Math.max(iterMax, msg.iteration);
			iterMin = iterMin ? Math.min(iterMin, msg.iteration) : msg.iteration;
		}
		switch (msg.type) {
			case "state":
				if (ENGINES.includes(msg.engine)) engine = msg.engine;
				mode = msg.mode || mode;
				if (typeof msg.modelId === "string") modelId = msg.modelId;
				models = msg.models || models;
				groups = msg.groups || groups;
				if (typeof msg.modelProfile === "string") modelProfile = msg.modelProfile;
				if (typeof msg.signedIn === "boolean") signedIn = msg.signedIn;
				if (Array.isArray(msg.sessions)) {
					sessionTabs = msg.sessions;
					moreTabs = Array.isArray(msg.moreSessions) ? msg.moreSessions : [];
					const nextSession = msg.activeSession || activeSession;
					if (nextSession !== activeSession) {
						drafts[activeSession] = task.value;
						task.value = drafts[nextSession] || "";
						activeSession = nextSession;
						autogrow();
					}
					renderTabs();
				}
				refreshAuthBanner();
				refreshChips();
				updateActivityRing();
				persist();
				break;
			case "insertMention": {
				const sep = task.value.length > 0 && !task.value.endsWith(" ") && !task.value.endsWith("\n") ? " " : "";
				task.value += `${sep}@${msg.text} `;
				task.focus();
				autogrow();
				break;
			}
			case "insertAttachment": {
				const a = msg.attachment;
				if (!a?.path || attachments.has(a.path)) break;
				const sep = task.value.length > 0 && !task.value.endsWith(" ") && !task.value.endsWith("\n") ? " " : "";
				task.value += `${sep}@${a.path} `;
				const card = el("div", `attachment-preview ${a.dataUrl ? "image" : "file"}`);
				if (a.dataUrl) {
					const image = document.createElement("img");
					image.src = a.dataUrl;
					image.alt = a.name;
					card.appendChild(image);
				} else {
					card.appendChild(el("span", "attachment-file-icon", a.kind === "directory" ? "▱" : "⌑"));
					card.appendChild(el("span", "attachment-name", a.name));
				}
				const remove = el("button", "attachment-remove", "×");
				remove.type = "button";
				remove.title = `Remove ${a.name}`;
				remove.addEventListener("click", () => {
					card.remove();
					attachments.delete(a.path);
					task.value = task.value.replace(`@${a.path} `, "").replace(`@${a.path}`, "");
					attachmentPreviews.hidden = attachments.size === 0;
					autogrow();
					persist();
				});
				card.appendChild(remove);
				attachments.set(a.path, card);
				attachmentPreviews.appendChild(card);
				attachmentPreviews.hidden = false;
				task.focus();
				autogrow();
				persist();
				break;
			}
			case "cloud-status":
				cloudStatus.hidden = false;
				cloudStatus.textContent = `☁ ${msg.text}`;
				break;
			case "reset":
				showEmpty();
				// Timeline was just wiped — every cached element is detached now.
				// Clear them or new events append into dead DOM.
				runGroup = null;
				runEl = null;
				batchEl = null;
				boardEl = null;
				boardSig = "";
				progressEl = null;
				streamMsg = null;
				streamText = "";
				streamReasoning = null;
				reasoningText = "";
				thoughts = null;
				groupStats = { added: 0, removed: 0, files: new Set() };
				boardTasks.clear();
				tools.clear();
				pendingEdits.length = 0;
				attachments.clear();
				attachmentPreviews.replaceChildren();
				attachmentPreviews.hidden = true;
				usage = {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					reasoningTokens: 0,
					totalCost: 0,
					iteration: 0,
					contextMsgs: 0,
					contextBudget: 0,
				};
				setRunning(false);
				stopTimer();
				setStatus("Idle");
				lastCompactEl = null;
				break;
			case "run-started": {
				retirePaused();
				// A previous group left open (missing terminal event, mid-run
				// reload) would swallow this run's bubble and cards inside its
				// collapsed body — close it before the new bubble lands.
				closeGroup("Worked for");
				// Each run owns a section; its bubble, work group and result all
				// mount inside it and can't bleed into neighbouring runs.
				runEl = el("div", "run-section");
				timeline.appendChild(runEl);
				iterMin = iterMax = 0;
				startedAt = Date.now();
				startTimer();
				const card = el("div", "step task");
				const bubble = el("div", "body bubble");
				bubble.appendChild(el("div", "bubble-label", "You"));
				bubble.appendChild(el("div", "bubble-text", msg.task));
				card.appendChild(bubble);
				card.appendChild(
					el("span", "msg-time", evTime(msg)),
				);
				add(card);
				resetRunStats();
				// Each run owns one plan board and one progress card; refs persist
				// so narration can still resolve ids to titles between boards.
				boardEl = null;
				boardSig = "";
				boardActive = false;
				progressEl = null;
				// Streaming/thought elements from a run that ended mid-delta point
				// inside its collapsed card — clear them or the new run's text is
				// written into dead, invisible DOM ("content on top of content").
				streamMsg = null;
				streamText = "";
				streamReasoning = null;
				reasoningText = "";
				lastReasoningNorm = "";
				thoughts = null;
				lastCompactEl = null;
				batchEl = null;
				setRunning(true);
				setStatus("Running...");
				break;
			}
			case "reasoning": {
				ensureSegment();
				const text = String(msg.text || "");
				const norm = text.replace(/\s+/g, " ").trim();
				if (streamReasoning) {
					// Final event for the segment we already streamed — update it
					// in place instead of opening a duplicate Thoughts pill.
					streamReasoning.classList.remove("streaming");
					if (norm) {
						reasoningText = text;
						streamReasoning.textContent = text;
						lastReasoningNorm = norm;
					} else {
						lastReasoningNorm = reasoningText.replace(/\s+/g, " ").trim();
					}
					setThoughtPreview(reasoningText);
					streamReasoning = null;
					reasoningText = "";
				} else if (norm && norm !== lastReasoningNorm) {
					lastReasoningNorm = norm;
					newThoughtSegment(text).appendChild(el("div", "reasoning-text", text));
				}
				scrollMaybe();
				break;
			}
			case "reasoning-delta": {
				ensureSegment();
				if (!streamReasoning) {
					reasoningText = "";
					streamReasoning = el("div", "reasoning-text streaming", "");
					newThoughtSegment().appendChild(streamReasoning);
				}
				reasoningText += msg.text;
				streamReasoning.textContent = reasoningText;
				streamReasoning.scrollTop = streamReasoning.scrollHeight;
				setThoughtPreview(reasoningText);
				scrollMaybe();
				break;
			}
			case "assistant-text": {
				streamMsg = null;
				streamText = "";
				// Interim narration is a working note — it folds into the current
				// worked group; only a tool-free reply gets its own top-level card.
				const hasWork = !!runGroup?.querySelector(".step.tool, .tool-batch, .thoughts-group");
				const card = el("div", `step assistant${hasWork ? " narration-note" : ""}`);
				const body = el("div", "k-body");
				for (const n of narrationNodes(msg.text)) body.appendChild(n);
				card.appendChild(body);
				card.appendChild(
					el(
						"span",
						"msg-time",
						evTime(msg),
					),
				);
				if (hasWork) add(card);
				else {
					closeGroup("Worked for");
					add(card);
				}
				break;
			}
			case "assistant-delta": {
				if (!streamMsg) {
					const hasWork = !!runGroup?.querySelector(".step.tool, .tool-batch, .thoughts-group");
					if (!hasWork) closeGroup("Worked for");
					streamMsg = el("div", `step assistant${hasWork ? " narration-note" : ""}`);
					streamMsg.appendChild(el("div", "k-body"));
					add(streamMsg);
				}
				streamText += msg.text;
				clearTimeout(mdTimer);
				mdTimer = setTimeout(() => {
					if (!streamMsg) return;
					streamMsg.querySelector(".k-body")?.replaceChildren(...narrationNodes(streamText + "▍"));
				}, 60);
				scrollMaybe();
				break;
			}
			case "tool-started": {
				ensureSegment();
				const [icon, verb] = toolVerb(msg.name);
				lastVerb = `${verb} ${describeInput(msg.name, msg.input)}…`;
				setStatus("Running...");
				if (EDIT_TOOLS.has(msg.name)) {
					const input = parseInput(msg.input);
					const path = normPath(input.path);
					const card = pendingEditCard(msg.name, input, path);
					card.dataset.toolId = msg.id;
					tools.set(msg.id, card);
					pendingEdits.push({ path, card });
					add(card);
					break;
				}
				const card = el("details", "step tool running");
				card.dataset.tool = msg.name;
				const summary = el("summary");
				summary.appendChild(el("span", "twisty", "›"));
				summary.appendChild(el("span", "tool-icon", icon));
				summary.appendChild(el("span", "tool-name", verb));
				summary.appendChild(el("span", "tool-arg", describeInput(msg.name, msg.input)));
				summary.appendChild(el("span", "tool-detail muted"));
				const stat = el("span", "tool-status");
				stat.appendChild(el("span", "live-elapsed muted", "0s"));
				stat.appendChild(el("span", "act-pill run", "Running"));
				summary.appendChild(stat);
				card.appendChild(summary);
				const input = el("details", "tool-input");
				input.appendChild(el("summary", "", "Input"));
				input.appendChild(el("pre", "io", JSON.stringify(msg.input, null, 2)));
				card.appendChild(input);
				card.dataset.toolId = msg.id;
				if (msg.name === "run_command" && msg.input?.command) card.dataset.cmd = msg.input.command;
				tools.set(msg.id, card);
				// Open while running; collapse the previous card so only one stays expanded.
				if (openToolCard && openToolCard !== card) openToolCard.open = false;
				card.open = true;
				input.open = true;
				openToolCard = card;
				addToolCard(card, msg.iteration);
				break;
			}
			case "tool-finished": {
				const card = tools.get(msg.id);
				if (!card) break;
				if (card.classList.contains("diff-editor")) {
					dropPending(card);
					if (!msg.ok) {
						runStats.toolsFailed++;
						card.dataset.state = "failed";
						card.classList.remove("pending");
						setEditStatus(card, "Not applied", "err");
						card.open = true;
						const out = prettyOut(String(msg.output || "")).replace(/\x1b\[[0-9;]*m/g, "").trim();
						if (out) card.appendChild(el("pre", "io io-err", out));
					} else if (card.dataset.state === "pending") {
						card.classList.remove("pending");
						card.dataset.state = "done";
						setEditStatus(card, "No changes", "muted");
					}
					lastVerb = "";
					break;
				}
				card.classList.remove("running");
				card.classList.add(msg.ok ? "ok" : "error");
				// Consolidate to a single line: icon verb arg · detail … duration ✓/✗
				const summary = card.querySelector("summary");
				const det = card.querySelector(".tool-detail");
				if (det) {
					const d = resultDetail(msg.name, msg.output);
					det.textContent = d ? `· ${d}` : "";
				}
				const stat = card.querySelector(".tool-status");
				if (stat) {
					stat.textContent = "";
					const dur = fmtMs(msg.durationMs);
					if (dur) stat.appendChild(el("span", "muted", dur));
					stat.appendChild(
						msg.ok
							? el("span", "tool-check", "✓")
							: el("span", "act-pill err", "Failed"),
					);
				}
				if (!msg.ok) runStats.toolsFailed++;
				card.classList.add("done-line");
				if (openToolCard === card) openToolCard = null;
				// Completed command cards keep their result visible; other successful
				// tools collapse to a concise line.
				if (summary && msg.ok) {
					card.innerHTML = "";
					card.appendChild(summary);
				}
				if (card.dataset.cmd) {
					const result = commandResult(msg.output, msg.ok);
					const resultBox = el("div", "tool-result");
					const commandHead = el("div", "tool-result-head");
					commandHead.appendChild(el("span", "tool-result-label", "Command"));
					commandHead.appendChild(copyIconButton(card.dataset.cmd, "Copy command"));
					resultBox.appendChild(commandHead);
					resultBox.appendChild(el("pre", "io cmd-full", card.dataset.cmd));
					const outputHead = el("div", "tool-result-head");
					outputHead.appendChild(el("span", "tool-result-label", "Output"));
					if (result.text) outputHead.appendChild(copyIconButton(result.text, "Copy output"));
					resultBox.appendChild(outputHead);
					if (result.text) resultBox.appendChild(el("pre", `io${msg.ok ? "" : " io-err"}`, result.text));
					resultBox.appendChild(el("div", `tool-exit${msg.ok ? "" : " failed"}`, `${msg.ok ? "Exited" : "Failed"} with code ${result.code}`));
					card.appendChild(resultBox);
					card.open = true;
				} else {
					const cleanOutput = prettyOut(String(msg.output || "")).replace(/\x1b\[[0-9;]*m/g, "").trim();
					if (cleanOutput) {
						if (msg.ok && READ_TOOLS.has(msg.name)) card.appendChild(renderReadOutput(cleanOutput));
						else card.appendChild(el("pre", `io${msg.ok ? "" : " io-err"}`, cleanOutput));
					}
					card.open = !msg.ok;
				}
				const batch = card.closest(".tool-batch");
				if (batch) updateBatch(batch);
				lastVerb = "";
				break;
			}
			case "task-board": {
				boardActive = true;
				const tasks = msg.tasks || [];
				// Same plan → update the existing card in place. A different task
				// set means the model wrote a new plan — only then append a card.
				const sig = tasks.map((t) => t.id).join(",");
				if (sig !== boardSig || !boardEl || !boardEl.isConnected) {
					boardEl = el("div", "step taskboard");
					add(boardEl);
					boardSig = sig;
				} else {
					// Move the live card to the current position so progress isn't
					// buried in a collapsed earlier segment.
					const target = runGroup?.querySelector(".group-body") ?? runEl ?? timeline;
					if (boardEl.parentNode !== target) add(boardEl);
				}
				boardTasks.clear();
				for (const t of tasks) boardTasks.set(t.id, t);
				const head = el("div", "board-head");
				head.appendChild(el("span", "board-label", "Plan"));
				const counts = tasks.reduce((acc, t) => ((acc[t.status] = (acc[t.status] || 0) + 1), acc), {});
				head.appendChild(
					el(
						"span",
						"board-rollup",
						Object.entries(counts)
							.map(([s, n]) => `${n} ${s.replace("_", " ")}`)
							.join(" · "),
					),
				);
				const rows = tasks.map((t) => {
					const row = el("div", `board-task ${t.status}`);
					const title = el("div", "board-title");
					title.appendChild(el("span", "board-name", t.title));
					if (t.from) title.appendChild(el("span", "board-adopt", `↩ run ${String(t.from).slice(0, 8)}`));
					title.appendChild(el("span", `board-pill ${t.status}`, t.status.replace("_", " ")));
					row.appendChild(title);
					const list = el("ul", "board-steps");
					for (const s of t.steps || []) list.appendChild(el("li", `board-step ${s.status}`, `${s.text} · ${s.status}`));
					row.appendChild(list);
					return row;
				});
				boardEl.replaceChildren(head, ...rows);
				scrollMaybe(true);
				break;
			}
			case "task-progress": {
				ensureSegment();
				// Progress is a live snapshot — update one card in place rather
				// than stacking a new card per update.
				const fresh = !progressEl || !progressEl.isConnected;
				const card = fresh ? el("div", "step progress") : progressEl;
				card.replaceChildren();
				card.appendChild(el("div", "progress-objective", msg.objective || "Progress"));
				/** @param {string} label @param {string[] | undefined} items */
				const section = (label, items) => {
					if (!items?.length) return;
					const wrap = el("div", "progress-section");
					wrap.appendChild(el("div", "progress-label", label));
					const list = el("ul", "progress-list");
					for (const item of items) list.appendChild(el("li", "", item));
					wrap.appendChild(list);
					card.appendChild(wrap);
				};
				section("Done", msg.completed);
				section("In progress", msg.inProgress);
				section("Next", msg.next);
				section("Blockers", msg.blockers);
				if (fresh) {
					progressEl = card;
					add(card);
				} else {
					// Keep the card at the current position across segments.
					const target = runGroup?.querySelector(".group-body") ?? runEl ?? timeline;
					if (card.parentNode !== target) add(card);
					else {
						scrollMaybe(true);
						persist();
					}
				}
				break;
			}
			case "mode-blocked": {
				ensureSegment();
				const card = el("div", "step mode-blocked");
				card.appendChild(
					el("div", "mb-label", `Writes are disabled in ${msg.mode === "plan" ? "Plan" : "Ask"} mode.`),
				);
				const btn = el("button", "perm-btn allow", "Switch to Code");
				btn.addEventListener("click", () => {
					vscode.postMessage({ type: "setMode", mode: "code" });
					card.remove();
				});
				card.appendChild(btn);
				add(card);
				break;
			}
			case "loop-detected":
				add(el("div", "step info", `⏹ Stopped: \`${msg.tool}\` repeated ${msg.count}× — the model was looping.`));
				settlePending("Interrupted");
				setRunning(false);
				stopTimer();
				closeGroup("Stopped · worked for");
				setStatus("Stopped (loop detected)");
				break;
			case "info": {
				ensureSegment();
				// Collapse consecutive compaction notices into the last one — a
				// long run can fire one per turn and bury the real timeline.
				const compact = msg.meta?.kind === "context_compaction";
				const target = runGroup?.querySelector(".group-body") ?? runEl ?? timeline;
				if (compact && lastCompactEl && target.lastElementChild === lastCompactEl) {
					lastCompactEl.textContent = `ⓘ ${msg.text}`;
					scrollMaybe(true);
					persist();
					break;
				}
				const n = el("div", msg.meta?.kind === "harness" ? "step info harness" : "step info", `ⓘ ${msg.text}`);
				if (compact) lastCompactEl = n;
				add(n);
				break;
			}
			case "file-changed": {
				ensureSegment();
				groupStats.added += msg.added || 0;
				groupStats.removed += msg.removed || 0;
				if ((msg.added || 0) + (msg.removed || 0) > 0) groupStats.files.add(msg.path);
				runStats.files.set(msg.path, { added: msg.added || 0, removed: msg.removed || 0 });
				updateGroupTitle("Working for");
				const pending = takePending(msg.path);
				if (msg.diff || pending) {
					// Edit calls resolve their preview card in place; standalone writes get a new card.
					const card = pending ?? el("details", "diff-editor");
					fillEditorCard(card, { ...msg, status: msg.diff ? "" : "No changes", cls: msg.diff ? "" : "muted" });
					if (!pending) add(card);
					break;
				}
				const row = el("div", "step file");
				row.appendChild(el("span", "file-name", `${msg.kind === "created" ? "✚" : "✎"} ${msg.path}`));
				if (msg.added || msg.removed) {
					const stats = el("span", "file-stats");
					if (msg.added) stats.appendChild(el("span", "stat-add", `+${msg.added}`));
					if (msg.removed) stats.appendChild(el("span", "stat-del", `−${msg.removed}`));
					row.appendChild(stats);
				}
				row.appendChild(fileActions(msg.path, row));
				add(row);
				break;
			}
			case "check": {
				ensureSegment();
				if (msg.ok) runStats.checksPassed++;
				else runStats.checksFailed++;
				const card = el("details", `step tool ${msg.ok ? "ok" : "error"}`);
				card.open = !msg.ok;
				const summary = el("summary");
				summary.appendChild(el("span", "twisty", "›"));
				summary.appendChild(el("span", "tool-name", "check"));
				summary.appendChild(el("span", "tool-arg", msg.command));
				const cstat = el("span", "tool-status");
				cstat.appendChild(el("span", `act-pill ${msg.ok ? "ok" : "err"}`, msg.ok ? "Passed" : "Failed"));
				summary.appendChild(cstat);
				card.appendChild(summary);
				if (msg.output) card.appendChild(el("pre", "io", msg.output));
				add(card);
				break;
			}
			case "permission-request": {
				ensureSegment();
				const row = el("div", "step permission");
				row.dataset.permId = msg.id;
				const titles = { run_command: "Run a command?", memory_write: "Save a fact?" };
				row.appendChild(el("div", "perm-title", titles[msg.tool] || "Apply changes?"));
				const card = el("div", "perm-card");
				const commandHead = el("div", "perm-command-head");
				commandHead.appendChild(el("div", "perm-label", msg.tool === "run_command" ? "Command" : msg.tool === "memory_write" ? "Fact" : "Path"));
				if (msg.tool === "run_command") {
					const copy = el("button", "perm-copy");
					copy.type = "button";
					copy.title = "Copy command";
					copy.setAttribute("aria-label", "Copy command");
					copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
					copy.addEventListener("click", async (e) => {
						e.stopPropagation();
						try {
							await navigator.clipboard.writeText(String(msg.path || ""));
							copy.classList.add("copied");
							copy.title = "Copied";
							setTimeout(() => {
								copy.classList.remove("copied");
								copy.title = "Copy command";
							}, 1400);
						} catch {
							copy.title = "Copy failed";
						}
					});
					commandHead.appendChild(copy);
				}
				card.appendChild(commandHead);
				card.appendChild(el("code", "perm-body", msg.path));
				if (msg.diff) card.appendChild(renderEditorDiff(msg.diff, msg.path));
				const btns = el("div", "perm-btns");
				const resolve = (decision, label) => {
					vscode.postMessage({ type: "permissionResponse", id: msg.id, decision });
					btns.remove();
					card.appendChild(el("span", "perm-decision", label));
				};
				const wrap = el("div", "perm-allow-wrap");
				const allowBtn = el("button", "perm-btn allow", "Allow");
				allowBtn.addEventListener("click", () => resolve("allow", "✓ allowed"));
				const dropBtn = el("button", "perm-btn allow drop");
				dropBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
				const menu = el("div", "perm-menu");
				menu.hidden = true;
				for (const [d, label] of [
					["alwaysTool", "Always allow this tool"],
					["alwaysRule", "Always allow this (saved)"],
					["always", "Allow all this session"],
				]) {
					const item = el("button", "perm-menu-item", label);
					item.addEventListener("click", () => {
						menu.hidden = true;
						resolve(d, `✓ ${label.toLowerCase()}`);
					});
					menu.appendChild(item);
				}
				dropBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					menu.hidden = !menu.hidden;
				});
				document.addEventListener("click", () => (menu.hidden = true));
				wrap.appendChild(allowBtn);
				wrap.appendChild(dropBtn);
				wrap.appendChild(menu);
				const wand = el("button", "perm-btn perm-wand");
				wand.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 19 6v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/></svg>';
				wand.title = "Always allow this tool";
				wand.addEventListener("click", () => resolve("alwaysTool", "✓ always allow this tool"));
				const rejectBtn = el("button", "perm-btn deny", "Reject");
				rejectBtn.addEventListener("click", () => resolve("deny", "✗ rejected"));
				btns.appendChild(wand);
				btns.appendChild(wrap);
				btns.appendChild(rejectBtn);
				card.appendChild(btns);
				row.appendChild(card);
				add(row);
				break;
			}
			case "permission-response": {
				const row = timeline.querySelector(`[data-perm-id="${msg.id}"]`);
				if (row && !row.querySelector(".perm-decision")) {
					row.querySelector(".perm-btns")?.remove();
					const card = row.querySelector(".perm-card") || row;
					card.appendChild(el("span", "perm-decision", msg.decision === "deny" ? "✗ denied" : `✓ ${msg.decision}`));
				}
				break;
			}
			case "plan-ready": {
				// The deliverable — keep it top-level, not folded into the work group.
				lastPlanPath = msg.path || lastPlanPath;
				closeGroup("Finished · worked for");
				const card = el("div", "step plan-ready");
				card.appendChild(el("div", "perm-title", "Plan ready"));
				card.appendChild(el("code", "perm-body", msg.path));
				const btns = el("div", "perm-btns");
				const review = el("button", "perm-btn allow", "Review plan");
				review.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: msg.path }));
				const impl = el("button", "perm-btn deny", "Start implementation");
				impl.className = "perm-btn allow";
				impl.addEventListener("click", () => vscode.postMessage({ type: "implementPlan", path: msg.path }));
				btns.appendChild(review);
				btns.appendChild(impl);
				card.appendChild(btns);
				add(card);
				break;
			}
			case "usage":
				usage = {
					inputTokens: msg.inputTokens,
					outputTokens: msg.outputTokens,
					cacheReadTokens: msg.cacheReadTokens || 0,
					cacheWriteTokens: msg.cacheWriteTokens || 0,
					reasoningTokens: msg.reasoningTokens || 0,
					totalCost: msg.totalCost || 0,
					iteration: msg.iteration || 0,
					contextMsgs: msg.contextMsgs || 0,
					contextBudget: msg.contextBudget || 0,
				};
				setStatus("Running...");
				break;
			case "run-finished": {
				retirePaused();
				const secs = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
				const issues = runStats.toolsFailed + runStats.checksFailed;
				const stopped = msg.status === "stopped" || msg.status === "interrupted";
				settlePending("Interrupted");
				// Zero-diff churn (binary/.pyc) isn't a meaningful change.
				const files = [...runStats.files.values()].filter((f) => f.added + f.removed > 0);
				const added = files.reduce((a, f) => a + f.added, 0);
				const removed = files.reduce((a, f) => a + f.removed, 0);
				const card = el("div", `step done result-card${stopped ? " stopped" : ""}${issues ? " has-issues" : ""}`);
				const title = el("div", "result-title");
				title.appendChild(el("span", stopped ? "stop-circle" : "check-circle", stopped ? "■" : "✓"));
				title.appendChild(el("span", "result-heading", stopped ? "Stopped" : msg.status === "completed" || msg.status === "success" ? "Task completed" : `Finished (${msg.status})`));
				const pill = stopped
					? el("span", "status-pill stopped", "Stopped")
					: issues
						? el("span", "status-pill warn", `${issues} issue${issues > 1 ? "s" : ""}`)
						: el("span", "status-pill completed", "Completed");
				pill.style.marginLeft = "auto";
				title.appendChild(pill);
				card.appendChild(title);
				if (issues) card.appendChild(el("div", "result-issues", `${issues} command${issues > 1 ? "s" : ""} or check${issues > 1 ? "s" : ""} failed during this run — expand the cards above to inspect.`));
				const blocked = boardActive ? [...boardTasks.values()].filter((t) => t.status === "blocked").length : 0;
				if (blocked) card.appendChild(el("div", "result-issues blocked", `${blocked} plan task${blocked > 1 ? "s" : ""} could not be completed this run — see the plan card above.`));
				if (msg.text) {
					const rs = el("div", "result-summary");
					const md = renderMd(msg.text);
					chipify(md);
					linkifyPaths(md);
					rs.appendChild(md);
					card.appendChild(rs);
				}
				const stats = el("div", "result-stats");
				const stat = (val, cls, label) => {
					const d = el("div", "result-stat");
					d.appendChild(el("b", cls, String(val)));
					d.appendChild(el("span", "muted", label));
					return d;
				};
				// Diff stats belong to code/agent runs — a plan or ask run reports
				// checks and the plan link instead of empty +0/−0 counters.
				const showDiff = mode !== "plan" && mode !== "ask";
				if (showDiff && files.length) stats.appendChild(stat(files.length, "", `File${files.length > 1 ? "s" : ""} changed`));
				if (showDiff && (added || removed)) {
					stats.appendChild(stat(`+${added}`, "stat-add", "Lines added"));
					stats.appendChild(stat(`−${removed}`, "stat-del", "Lines removed"));
				}
				if (runStats.checksPassed) stats.appendChild(stat(runStats.checksPassed, "", "Checks passed"));
				if (issues) stats.appendChild(stat(issues, "stat-del", "Failed"));
				card.appendChild(stats);
				const foot = el("div", "result-foot muted");
				const steps = iterMax ? iterMax - iterMin + 1 : msg.iterations;
				foot.textContent = `${secs ? `${secs}s · ` : ""}${steps} step(s)`;
				if (lastPlanPath) {
					const link = el("button", "plan-link", `plan · ${lastPlanPath.split("/").pop()}`);
					link.title = lastPlanPath;
					link.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: lastPlanPath }));
					foot.appendChild(document.createTextNode(" · "));
					foot.appendChild(link);
				}
				card.appendChild(foot);
				// Close the work group first so the card lands at top level —
				// otherwise it is swallowed into the just-collapsed group.
				closeGroup(stopped ? "Stopped · worked for" : "Finished · worked for");
				add(card);
				setRunning(false);
				stopTimer();
				setStatus(stopped ? "Stopped" : `Done (${msg.status})`);
				break;
			}
			case "run-failed": {
				const card = el("div", "step failed");
				card.appendChild(el("div", "label", "Run failed"));
				card.appendChild(el("div", "body", msg.error));
				retirePaused();
				settlePending("Interrupted");
				setRunning(false);
				stopTimer();
				closeGroup("Failed · worked for");
				add(card);
				setStatus("Failed");
				break;
			}
			case "run-paused": {
				// The agent is parked at its step cap with its context intact:
				// Continue resumes it on the same agent, Stop finalizes the run.
				settlePending("Interrupted");
				setRunning(false);
				stopTimer();
				const card = el("div", "step paused-card");
				card.appendChild(el("div", "label", "Paused at step limit"));
				card.appendChild(el("div", "body", `Paused after ${iterMax ? iterMax - iterMin + 1 : msg.iterations} steps — the agent's context is kept.`));
				const actions = el("div", "result-actions paused-actions");
				const cont = el("button", "continue-btn", "Continue");
				cont.addEventListener("click", () => {
					actions.remove();
					setRunning(true);
					setStatus("Running...");
					startTimer();
					vscode.postMessage({ type: "resumeRun" });
				});
				const stopBtnPaused = el("button", "stop-btn", "Stop");
				stopBtnPaused.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
				actions.append(cont, stopBtnPaused);
				card.appendChild(actions);
				closeGroup("Paused · worked for");
				add(card);
				setStatus("Paused");
				break;
			}
		}
	});
})();
