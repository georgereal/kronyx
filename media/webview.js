// @ts-check
(() => {
	// @ts-ignore acquireVsCodeApi is injected by VS Code
	const vscode = acquireVsCodeApi();
	const timeline = /** @type {HTMLElement} */ (document.getElementById("timeline"));
	const task = /** @type {HTMLTextAreaElement} */ (document.getElementById("task"));
	const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
	const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById("stop"));
	const attachBtn = /** @type {HTMLButtonElement} */ (document.getElementById("attach"));
	const modeBtn = /** @type {HTMLButtonElement} */ (document.getElementById("mode"));
	const modelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("model"));
	const modeLabel = /** @type {HTMLElement} */ (document.getElementById("mode-label"));
	const modelLabel = /** @type {HTMLElement} */ (document.getElementById("model-label"));
	const status = /** @type {HTMLElement} */ (document.getElementById("status"));
	const tokchip = /** @type {HTMLElement} */ (document.getElementById("tokchip"));
	const menu = /** @type {HTMLElement} */ (document.getElementById("menu"));
	/** @type {Map<string, HTMLElement>} */
	const tools = new Map();
	let openToolCard = null;
	let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	let startedAt = 0;

	const persisted = vscode.getState() || {};
	/** @type {string} */
	let mode = persisted.mode || "code";
	/** @type {string} */
	let modelId = persisted.modelId || "";
	/** @type {import("../src/config").ModelOption[]} */
	let models = persisted.models || [];
	/** @type {string[]} */
	let recentModels = persisted.recentModels || [];
	if (persisted.draft) task.value = persisted.draft;

	const MODES = [
		{ id: "code", label: "Code", desc: "Write and edit code" },
		{ id: "smart", label: "Smart", desc: "Auto-approve actions the model judges safe" },
		{ id: "ask", label: "Ask", desc: "Answer questions without code changes" },
		{ id: "plan", label: "Plan", desc: "Plan changes before implementing" },
		{ id: "bypass", label: "Bypass Permissions", desc: "Auto-approve all tool calls" },
	];

	const persist = () => vscode.setState({ mode, modelId, models, recentModels, draft: task.value });

	const el = (tag, cls, text) => {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = text;
		return node;
	};

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
	let groupStats = { added: 0, removed: 0 };
	let streamMsg = null;
	let streamText = "";
	let streamReasoning = null;
	let reasoningText = "";
	let thoughts = null;
	let mdTimer = 0;
	let lastVerb = "";

	const add = (node) => {
		timeline.querySelector(".empty")?.remove();
		const target = runGroup?.querySelector(".group-body") ?? timeline;
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
		groupStats = { added: 0, removed: 0 };
		runGroup = group;
		streamMsg = null;
		streamText = "";
		streamReasoning = null;
		reasoningText = "";
		thoughts = null;
		timeline.querySelector(".empty")?.remove();
		timeline.appendChild(group);
	};

	const fmtDur = (secs) => {
		if (secs < 60) return `${secs}s`;
		const m = Math.floor(secs / 60), s = secs % 60;
		return s ? `${m}m ${s}s` : `${m}m`;
	};

	const updateGroupTitle = (prefix) => {
		if (!runGroup) return;
		const secs = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
		const stats = groupStats.added || groupStats.removed ? ` +${groupStats.added} −${groupStats.removed}` : "";
		runGroup.querySelector(".group-title").textContent =
			secs > 0 ? `${prefix} ${fmtDur(secs)}${stats}` : `${prefix.replace(/\s+for$/, "ed").trim()}${stats}`;
	};

	// First line of assistant text becomes a bold header; the rest renders as markdown.
	const narrationNodes = (text) => {
		const idx = text.indexOf("\n");
		const rawHead = (idx === -1 ? text : text.slice(0, idx)).trim();
		const head = rawHead.length > 140 ? rawHead.slice(0, 140) + "…" : rawHead || "…";
		const nodes = [el("div", "narration-head", head)];
		if (idx !== -1) {
			const body = text.slice(idx + 1).trim();
			if (body) nodes.push(renderMd(body));
		}
		return nodes;
	};

	// Each reasoning segment gets its own inline collapsed section at the position it occurs.
	const newThoughtSegment = () => {
		// Only the newest thoughts segment stays expanded; earlier ones collapse.
		runGroup?.querySelectorAll(".thoughts-group[open]").forEach((t) => (t.open = false));
		thoughts = el("details", "thoughts-group dim");
		thoughts.open = true;
		const s = el("summary");
		s.appendChild(el("span", "twisty", "›"));
		s.appendChild(el("span", "tool-name", "Thoughts"));
		thoughts.appendChild(s);
		add(thoughts);
		return thoughts;
	};

	const collapseAux = () => {
		runGroup?.querySelectorAll(".thoughts-group").forEach((t) => (t.open = false));
	};

	const closeGroup = (label) => {
		if (!runGroup) return;
		collapseAux();
		updateGroupTitle(label);
		runGroup.open = false;
		runGroup = null;
	};

	// Work events lazily open a segment; assistant text closes it — yielding
	// sequential "Worked for Xs" sections interleaved with messages.
	const ensureSegment = () => {
		if (!runGroup) startGroup();
	};

	const setRunning = (running) => {
		sendBtn.hidden = running;
		stopBtn.hidden = !running;
		task.disabled = running;
	};

	const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

	let statusText = "Idle";
	let elapsedTimer = 0;

	const setStatus = (text) => {
		statusText = text;
		const total = usage.inputTokens + usage.outputTokens;
		const elapsed = startedAt ? ` · ${((Date.now() - startedAt) / 1000).toFixed(0)}s` : "";
		status.textContent = (text === "Running..." && lastVerb ? lastVerb : text) + elapsed;
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
		if (name === "read_file" && input.start_line) return `${p} (${input.start_line}-${input.end_line ?? "end"})`;
		if (name === "edit_file" && Array.isArray(input.edits)) return `${p} (${input.edits.length} edit(s))`;
		return String(p);
	};

	const TOOL_STYLE = {
		read_file: ["📄", "Read"],
		list_files: ["🔍", "Listed"],
		search_files: ["🔍", "Searched"],
		write_file: ["✎", "Wrote"],
		edit_file: ["✎", "Edited"],
		append_file: ["✎", "Appended"],
		insert_lines: ["✎", "Edited"],
		run_command: ["›_", "Ran"],
		memory_write: ["✦", "Saved"],
	};
	const toolVerb = (name) => TOOL_STYLE[name] || ["⛭", name];

	const showEmpty = () => {
		timeline.innerHTML = "";
		const empty = el("div", "empty");
		empty.appendChild(el("div", "empty-title", "Kronyx"));
		empty.appendChild(el("div", "empty-sub", "Describe a change, or try:"));
		const list = el("div", "empty-prompts");
		for (const p of ["Explain this codebase", "Fix a bug in the open file", "Write tests for the current file"]) {
			const b = el("button", "prompt-chip", p);
			b.addEventListener("click", () => {
				task.value = p;
				autogrow();
				task.focus();
			});
			list.appendChild(b);
		}
		empty.appendChild(list);
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
		vscode.postMessage({ type: "run", task: text, mode });
		task.value = "";
		autogrow();
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
	 * @param {{search?: boolean, wide?: boolean, items: any[]}} config
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
		menu.style.bottom = `${document.body.clientHeight - rect.top + 6}px`;
		menu.style.top = "auto";
		if (menu.offsetWidth + rect.left > document.body.clientWidth) {
			menu.style.left = `${Math.max(4, document.body.clientWidth - menu.offsetWidth - 4)}px`;
		}
		void menuHeight;
	};

	// ---------- chips ----------

	const modeLabelFor = (id) => MODES.find((m) => m.id === id)?.label ?? id;

	const MODE_ICONS = { code: "</>", smart: "✦", ask: "◯", plan: "≡", bypass: "⛨" };

	const MODE_PLACEHOLDERS = {
		ask: "Ask a question about the codebase…",
		plan: "Describe what to plan…",
	};

	const refreshChips = () => {
		modeLabel.textContent = modeLabelFor(mode);
		document.getElementById("mode-icon").textContent = MODE_ICONS[mode] || "●";
		const found = models.find((m) => m.id === modelId);
		modelLabel.textContent = found?.label || modelId || "Model";
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

	modelBtn.addEventListener("click", () => {
		const recent = recentModels.map((id) => models.find((m) => m.id === id)).filter(Boolean);
		const items = [];
		if (recent.length > 0) {
			items.push({ header: "Recently used" });
			for (const m of recent) items.push(modelItem(m));
		}
		items.push({ header: recent.length > 0 ? "All models" : "Models" });
		if (models.length === 0) items.push({ label: modelId || "No models loaded", disabled: true });
		for (const m of models) items.push(modelItem(m));
		openMenu(modelBtn, { search: true, wide: true, items });
	});

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

	const modelItem = (m) => ({
		label: m.label || m.id,
		desc: modelDesc(m) || m.description?.slice(0, 120),
		checked: m.id === modelId,
		onInfo: () => showModelDetail(m),
		onPick: () => {
			modelId = m.id;
			recentModels = [m.id, ...recentModels.filter((id) => id !== m.id)].slice(0, 3);
			refreshChips();
			persist();
			vscode.postMessage({ type: "setModel", modelId });
		},
	});

	const showModelDetail = (m) => {
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
			modelId = m.id;
			recentModels = [m.id, ...recentModels.filter((id) => id !== m.id)].slice(0, 3);
			refreshChips();
			persist();
			vscode.postMessage({ type: "setModel", modelId });
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
			],
		});
	});

	refreshChips();
	autogrow();
	showEmpty();
	vscode.postMessage({ type: "requestState" });

	// ---------- events ----------

	window.addEventListener("message", (event) => {
		const msg = event.data;
		switch (msg.type) {
			case "state":
				mode = msg.mode || mode;
				modelId = msg.modelId || modelId;
				models = msg.models || models;
				refreshChips();
				persist();
				break;
			case "insertMention": {
				const sep = task.value.length > 0 && !task.value.endsWith(" ") && !task.value.endsWith("\n") ? " " : "";
				task.value += `${sep}@${msg.text} `;
				task.focus();
				autogrow();
				break;
			}
			case "reset":
				showEmpty();
				tools.clear();
				usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
				setRunning(false);
				stopTimer();
				setStatus("Idle");
				break;
			case "run-started": {
				startedAt = Date.now();
				startTimer();
				const card = el("div", "step task");
				const bubble = el("div", "body bubble");
				bubble.appendChild(el("div", "bubble-label", "You"));
				bubble.appendChild(el("div", "bubble-text", msg.task));
				card.appendChild(bubble);
				add(card);
				setRunning(true);
				setStatus("Running...");
				break;
			}
			case "reasoning": {
				ensureSegment();
				streamReasoning = null;
				reasoningText = "";
				newThoughtSegment().appendChild(el("div", "reasoning-text", msg.text));
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
				scrollMaybe();
				break;
			}
			case "assistant-text": {
				closeGroup("Worked for");
				streamMsg = null;
				streamText = "";
				const card = el("div", "step assistant");
				card.appendChild(
					el(
						"span",
						"msg-time",
						new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
					),
				);
				for (const n of narrationNodes(msg.text)) card.appendChild(n);
				add(card);
				break;
			}
			case "assistant-delta": {
				if (!streamMsg) {
					closeGroup("Worked for");
					streamMsg = el("div", "step assistant");
					streamMsg.appendChild(renderMd(""));
					add(streamMsg);
				}
				streamText += msg.text;
				clearTimeout(mdTimer);
				mdTimer = setTimeout(() => {
					if (!streamMsg) return;
					streamMsg.replaceChildren(...narrationNodes(streamText + "▍"));
				}, 60);
				scrollMaybe();
				break;
			}
			case "tool-started": {
				ensureSegment();
				const [icon, verb] = toolVerb(msg.name);
				lastVerb = `${verb} ${describeInput(msg.name, msg.input)}…`;
				setStatus("Running...");
				const card = el("details", "step tool running");
				const summary = el("summary");
				summary.appendChild(el("span", "twisty", "›"));
				summary.appendChild(el("span", "tool-icon", icon));
				summary.appendChild(el("span", "tool-name", verb));
				summary.appendChild(el("span", "tool-arg", describeInput(msg.name, msg.input)));
				summary.appendChild(el("span", "tool-status", "…"));
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
				add(card);
				break;
			}
			case "tool-finished": {
				const card = tools.get(msg.id);
				if (!card) break;
				card.classList.remove("running");
				card.classList.add(msg.ok ? "ok" : "error");
				// Consolidate to a single line: icon verb arg ✓/✗ duration
				const summary = card.querySelector("summary");
				const stat = card.querySelector(".tool-status");
				if (stat) stat.textContent = `${msg.ok ? "✓" : "✗"} ${msg.durationMs}ms`;
				card.classList.add("done-line");
				card.open = false;
				if (openToolCard === card) openToolCard = null;
				if (summary) {
					card.innerHTML = "";
					card.appendChild(summary);
				}
				if (card.dataset.cmd) {
					const cmdDet = el("details", "tool-output");
					cmdDet.appendChild(el("summary", "", "Command"));
					cmdDet.appendChild(el("pre", "io cmd-full", card.dataset.cmd));
					const runBtn = el("button", "perm-btn", "\u29c9 Run in terminal");
					runBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						vscode.postMessage({ type: "runInTerminal", command: card.dataset.cmd });
					});
					cmdDet.appendChild(runBtn);
					card.appendChild(cmdDet);
				}
				const cleanOutput = String(msg.output || "").replace(/\x1b\[[0-9;]*m/g, "").trim();
				if (cleanOutput) card.appendChild(el("pre", `io${msg.ok ? "" : " io-err"}`, cleanOutput));
				lastVerb = "";
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
				setRunning(false);
				stopTimer();
				closeGroup("Stopped · worked for");
				setStatus("Stopped (loop detected)");
				break;
			case "info":
				ensureSegment();
				add(el("div", "step info", `ⓘ ${msg.text}`));
				break;
			case "file-changed": {
				ensureSegment();
				groupStats.added += msg.added || 0;
				groupStats.removed += msg.removed || 0;
				updateGroupTitle("Working for");
				const row = el("div", "step file");
				row.appendChild(el("span", "file-name", `${msg.kind === "created" ? "✚" : "✎"} ${msg.path}`));
				if (msg.added || msg.removed) {
					const stats = el("span", "file-stats");
					if (msg.added) stats.appendChild(el("span", "stat-add", `+${msg.added}`));
					if (msg.removed) stats.appendChild(el("span", "stat-del", `-${msg.removed}`));
					row.appendChild(stats);
				}
				const actions = el("span", "file-actions");
				for (const [label, type] of [["Review", "review"], ["✓", "acceptChange"], ["✗", "rejectChange"]]) {
					const btn = el("button", "file-btn", label);
					btn.title = type === "review" ? "Open diff" : type === "acceptChange" ? "Accept changes" : "Revert file";
					btn.addEventListener("click", () => {
						vscode.postMessage({ type, path: msg.path });
						if (type !== "review") row.remove();
					});
					actions.appendChild(btn);
				}
				row.appendChild(actions);
				add(row);
				if (msg.diff) {
					const det = el("details", "diff-detail");
					det.open = startedAt > 0;
					det.appendChild(el("summary", "", "Changes"));
					const pre = el("pre", "diff-body");
					for (const line of String(msg.diff).split("\n")) {
						const cls = line.startsWith("+") ? "dl add" : line.startsWith("-") ? "dl del" : line.startsWith("@@") ? "dl head" : "dl sep";
						pre.appendChild(el("span", cls, line + "\n"));
					}
					det.appendChild(pre);
					add(det);
				}
				break;
			}
			case "check": {
				ensureSegment();
				const card = el("details", `step tool ${msg.ok ? "ok" : "error"}`);
				const summary = el("summary");
				summary.appendChild(el("span", "twisty", "›"));
				summary.appendChild(el("span", "tool-name", "check"));
				summary.appendChild(el("span", "tool-arg", msg.command));
				summary.appendChild(el("span", "tool-status", `${msg.ok ? "✓" : "✗"} ${msg.durationMs}ms`));
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
				card.appendChild(el("div", "perm-label", msg.tool === "run_command" ? "Command" : msg.tool === "memory_write" ? "Fact" : "Path"));
				card.appendChild(el("code", "perm-body", msg.path));
				if (msg.diff) {
					const pre = el("pre", "diff-body");
					for (const line of String(msg.diff).split("\n")) {
						const cls = line.startsWith("+") ? "dl add" : line.startsWith("-") ? "dl del" : line.startsWith("@@") ? "dl head" : "dl sep";
						pre.appendChild(el("span", cls, line + "\n"));
					}
					card.appendChild(pre);
				}
				row.appendChild(card);
				const btns = el("div", "perm-btns");
				const resolve = (decision, label) => {
					vscode.postMessage({ type: "permissionResponse", id: msg.id, decision });
					btns.remove();
					row.appendChild(el("span", "perm-decision", label));
				};
				const wrap = el("div", "perm-allow-wrap");
				const allowBtn = el("button", "perm-btn allow", "Allow");
				allowBtn.addEventListener("click", () => resolve("allow", "✓ allowed"));
				const dropBtn = el("button", "perm-btn allow drop", "▾");
				const menu = el("div", "perm-menu");
				menu.hidden = true;
				for (const [d, label] of [
					["alwaysTool", "Always allow this tool"],
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
				const wand = el("button", "perm-btn perm-wand", "🪄");
				wand.title = "Always allow this tool";
				wand.addEventListener("click", () => resolve("alwaysTool", "✓ always allow this tool"));
				const rejectBtn = el("button", "perm-btn deny", "Reject");
				rejectBtn.addEventListener("click", () => resolve("deny", "✗ rejected"));
				btns.appendChild(wand);
				btns.appendChild(wrap);
				btns.appendChild(rejectBtn);
				row.appendChild(btns);
				add(row);
				break;
			}
			case "permission-response": {
				const row = timeline.querySelector(`[data-perm-id="${msg.id}"]`);
				if (row && !row.querySelector(".perm-decision")) {
					row.querySelector(".perm-btns")?.remove();
					row.appendChild(el("span", "perm-decision", msg.decision === "deny" ? "✗ denied" : `✓ ${msg.decision}`));
				}
				break;
			}
			case "plan-ready": {
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
				};
				setStatus("Running...");
				break;
			case "run-finished": {
				const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
				const card = el("div", `step done final-answer ${msg.status}`);
				card.appendChild(el("div", "label", `Finished (${msg.status}) · ${secs}s · ${msg.iterations} step(s)`));
				if (msg.text) card.appendChild(renderMd(msg.text));
				add(card);
				setRunning(false);
				stopTimer();
				closeGroup("Finished · worked for");
				setStatus(`Done (${msg.status})`);
				break;
			}
			case "run-failed": {
				const card = el("div", "step failed");
				card.appendChild(el("div", "label", "Run failed"));
				card.appendChild(el("div", "body", msg.error));
				add(card);
				setRunning(false);
				stopTimer();
				closeGroup("Failed · worked for");
				setStatus("Failed");
				break;
			}
		}
	});
})();
