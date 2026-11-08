// @ts-check
(() => {
	// @ts-ignore acquireVsCodeApi is injected by VS Code
	const vscode = acquireVsCodeApi();
	const fields = [...document.querySelectorAll("[data-key]")];
	const apiKeyStatus = document.getElementById("apikey-status");
	const modelsResult = document.getElementById("models-result");

	const coerce = (el) => {
		const kind = el.dataset.kind;
		if (kind === "bool") return el.checked;
		if (kind === "number") return Number(el.value);
		if (kind === "json") {
			try {
				return JSON.parse(el.value || "[]");
			} catch {
				return undefined;
			}
		}
		return el.value;
	};

	for (const el of fields) {
		el.addEventListener("change", () => {
			const value = coerce(el);
			if (value === undefined) return;
			vscode.postMessage({ type: "set", key: el.dataset.key, value });
			showSaved();
		});
	}

	document.getElementById("set-apikey").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
	document.getElementById("clear-apikey").addEventListener("click", () => vscode.postMessage({ type: "clearApiKey" }));
	const savedNote = document.getElementById("saved-note");
	let savedTimer = 0;
	const showSaved = () => {
		savedNote.classList.add("visible");
		clearTimeout(savedTimer);
		savedTimer = setTimeout(() => savedNote.classList.remove("visible"), 1200);
	};

	for (const nav of document.querySelectorAll(".nav-item")) {
		nav.addEventListener("click", () => {
			document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
			document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
			nav.classList.add("active");
			document.getElementById(`sec-${nav.dataset.nav}`)?.classList.add("active");
		});
	}

	document.getElementById("test-models").addEventListener("click", () => {
		modelsResult.textContent = "Fetching…";
		vscode.postMessage({ type: "testModels" });
	});

	let profiles = [];
	/** @type {Map<string, Set<(msg: {models?: any[], error?: string}) => void>>} */
	const modelSubs = new Map();
	const onModels = (name, fn) => {
		if (!modelSubs.has(name)) modelSubs.set(name, new Set());
		modelSubs.get(name).add(fn);
	};
	const profilesList = document.getElementById("profiles-list");
	const saveProfiles = () => vscode.postMessage({ type: "set", key: "provider.profiles", value: profiles });

	const fmtToks = (n) => (n == null ? "" : n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
	const fmtPrice = (v) => {
		if (v == null) return "";
		const perM = v * 1e6;
		return `$${perM >= 100 ? perM.toFixed(0) : perM >= 1 ? perM.toFixed(2) : perM.toFixed(3)}`;
	};
	const fmtModalities = (mod) => (mod ? [mod.input?.join("+"), mod.output?.join("+")].filter(Boolean).join("→") : "");

	const PRESETS = [
		{ id: "vercel-ai-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1" },
		{ id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
		{ id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
		{ id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com" },
		{ id: "azure", label: "Azure OpenAI", baseUrl: "" },
		{ id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1" },
		{ id: "openai-compatible", label: "Custom (OpenAI-compatible)", baseUrl: "" },
	];
	const PROVIDER_IDS = PRESETS.map((x) => x.id);
	const openCards = new Set();
	const openModelLists = new Set();
	const presetPicker = document.getElementById("preset-picker");
	let presetOpen = false;

	const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
	const mkBtn = (label, fn) => {
		const b = Object.assign(document.createElement("button"), { textContent: label });
		b.className = "secondary tiny";
		b.addEventListener("click", fn);
		return b;
	};
	const ghost = (label, fn) => {
		const b = mkBtn(label, fn);
		b.className = "ghost tiny";
		return b;
	};

	const uniqueName = (base) => {
		let n = base;
		let i = 2;
		while (profiles.some((p) => p.name === n)) n = `${base} ${i++}`;
		return n;
	};

	const renderPresetPicker = () => {
		presetPicker.innerHTML = "";
		presetPicker.hidden = !presetOpen;
		if (!presetOpen) return;
		const grid = el("div", "preset-grid", "");
		for (const pre of PRESETS) {
			const t = document.createElement("button");
			t.className = "preset-tile";
			t.appendChild(el("strong", "", pre.label));
			t.appendChild(el("em", "", pre.id));
			t.addEventListener("click", () => {
				const name = uniqueName(pre.label.split(" ")[0]);
				profiles.push({ name, providerId: pre.id, baseUrl: pre.baseUrl, modelId: "" });
				openCards.add(name);
				presetOpen = false;
				saveProfiles();
			});
			grid.appendChild(t);
		}
		presetPicker.appendChild(grid);
	};

	const renderProfiles = (msg) => {
		try { profiles = JSON.parse(msg.values["provider.profiles"] || "[]"); } catch { profiles = []; }
		profilesList.innerHTML = "";
		renderPresetPicker();
		if (profiles.length === 0) {
			profilesList.innerHTML = '<div class="prov-empty">No providers yet — click <strong>Add provider</strong> to connect one.</div>';
			return;
		}
		const activeName = msg.values["provider.profile"] || "";
		for (const p of profiles) profilesList.appendChild(buildCard(p, activeName, msg));
	};

	const buildCard = (p, activeName, msg) => {
		const keySet = msg.profileKeys && msg.profileKeys[p.name];
		const isActive = p.name === activeName;
		const requestCatalog = () => vscode.postMessage({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl });

		const card = document.createElement("details");
		card.className = "prov";
		card.open = openCards.size === 0 ? isActive : openCards.has(p.name);
		card.addEventListener("toggle", () => {
			if (card.open) openCards.add(p.name); else openCards.delete(p.name);
		});

		// ---- collapsed row ----
		const row = document.createElement("summary");
		row.className = "prov-row";
		const dot = el("span", "dot" + (isActive ? " on" : ""), "");
		dot.title = isActive ? "Active provider" : "Set as active provider";
		dot.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			vscode.postMessage({ type: "set", key: "provider.profile", value: p.name });
			showSaved();
		});
		row.appendChild(dot);
		row.appendChild(el("span", "prov-name", p.name || "(unnamed)"));
		let host = p.baseUrl || "no base URL";
		try { host = new URL(p.baseUrl).host; } catch { /* keep raw */ }
		row.appendChild(el("span", "prov-meta", `${p.providerId || "?"} · ${host}`));
		const right = el("span", "prov-right", "");
		if (p.modelId) right.appendChild(el("code", "chip", p.modelId));
		right.appendChild(el("span", "pill" + (keySet ? "" : " dim"), keySet ? "key set" : "no key"));
		if (isActive) right.appendChild(el("span", "pill on", "Default"));
		right.appendChild(el("span", "chev", "›"));
		row.appendChild(right);
		card.appendChild(row);

		const ed = el("div", "prov-editor", "");

		// ---- status strip ----
		const strip = el("div", "prov-status", "");
		const configured = Boolean(p.baseUrl && p.modelId);
		strip.appendChild(el("span", "dot" + (configured ? " on" : ""), ""));
		strip.appendChild(el("span", "", configured ? "Configured" : "Incomplete — set a base URL and model"));
		strip.appendChild(el("em", "", keySet ? "key set" : "no key"));
		const testStat = el("em", "test-status", "");
		const test = ghost("Test connection", () => {
			test.disabled = true;
			testStat.textContent = "…";
			requestCatalog();
		});
		strip.appendChild(test);
		strip.appendChild(testStat);
		ed.appendChild(strip);

		// ---- fields ----
		const fields = el("div", "prov-fields", "");
		const fld = (label, input, wide) => {
			const d = el("div", "fld" + (wide ? " wide" : ""), "");
			d.appendChild(el("span", "fld-label", label));
			d.appendChild(input);
			fields.appendChild(d);
		};
		const textInput = (f, ph) => {
			const input = document.createElement("input");
			input.placeholder = ph;
			input.value = p[f] || "";
			input.addEventListener("change", () => { p[f] = input.value.trim(); saveProfiles(); showSaved(); });
			return input;
		};

		const nameInput = textInput("name", "name");
		let oldName = p.name || "";
		nameInput.addEventListener("change", () => {
			const newName = nameInput.value.trim();
			if (newName && newName !== oldName && oldName) {
				vscode.postMessage({ type: "renameProfileKey", oldName, newName });
				openCards.delete(oldName);
				openCards.add(newName);
				oldName = newName;
			}
		});
		fld("Name", nameInput);

		const provSel = document.createElement("select");
		for (const id of [...new Set([p.providerId, ...PROVIDER_IDS].filter(Boolean))]) {
			const opt = document.createElement("option");
			opt.value = id;
			opt.textContent = id;
			if (id === p.providerId) opt.selected = true;
			provSel.appendChild(opt);
		}
		provSel.addEventListener("change", () => { p.providerId = provSel.value; saveProfiles(); showSaved(); });
		fld("Provider", provSel);
		fld("Base URL", textInput("baseUrl", "https://…/v1"), true);

		const modelInput = textInput("modelId", p.models?.length ? `search ${p.models.length} models…` : "model-id — fetch the catalog below to pick");
		const dl = document.createElement("datalist");
		dl.id = "mdl-" + (p.name || "x").replace(/[^a-z0-9]/gi, "");
		modelInput.setAttribute("list", dl.id);
		const fillModelSel = (models) => {
			dl.innerHTML = "";
			for (const m of models || []) {
				const opt = document.createElement("option");
				opt.value = m.id;
				if (m.label && m.label !== m.id) opt.label = m.label;
				dl.appendChild(opt);
			}
		};
		fillModelSel(p.models);
		fld("Model", modelInput, true);
		ed.appendChild(fields);
		ed.appendChild(dl);

		// ---- api key row ----
		const keyRow = el("div", "prov-keyrow", "");
		keyRow.appendChild(el("span", "fld-label", "API key"));
		if (keySet) keyRow.appendChild(el("code", "masked", "••••••••"));
		else keyRow.appendChild(el("em", "dim", "not set"));
		keyRow.appendChild(ghost(keySet ? "Update key" : "Set key", () => vscode.postMessage({ type: "setProfileKey", name: p.name })));
		if (keySet) keyRow.appendChild(ghost("Remove", () => vscode.postMessage({ type: "clearProfileKey", name: p.name })));
		ed.appendChild(keyRow);

		// ---- model catalog (renders from cache; explicit Refresh to fetch) ----
		const modelsSec = document.createElement("details");
		modelsSec.className = "prov-models";
		modelsSec.open = openModelLists.has(p.name);
		modelsSec.addEventListener("toggle", () => {
			if (modelsSec.open) openModelLists.add(p.name); else openModelLists.delete(p.name);
		});
		const cacheNote = el("em", "test-status",
			p.modelsFetchedAt ? `cached ${new Date(p.modelsFetchedAt).toLocaleString()}` : p.models?.length ? "cached" : "not fetched");
		const errNote = el("em", "test-status", "");
		const refreshBtn = mkBtn(p.models?.length ? `Refresh (${p.models.length})` : "Fetch models", () => {
			refreshBtn.textContent = "Fetching…";
			errNote.textContent = "";
			requestCatalog();
		});
		const mSum = document.createElement("summary");
		mSum.appendChild(el("span", "twisty", "›"));
		mSum.appendChild(el("strong", "", "Model catalog" + (p.models?.length ? ` (${p.models.length})` : "")));
		mSum.appendChild(cacheNote);
		mSum.appendChild(errNote);
		modelsSec.appendChild(mSum);
		const mHead = document.createElement("div");
		mHead.className = "row models-head";
		mHead.appendChild(refreshBtn);
		modelsSec.appendChild(mHead);

		const fmtDateCol = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");
		const COLS = [
			{ id: "ctx", label: "Context", def: true, num: true, sort: (m) => m.contextWindow ?? 0, filter: "ctx", render: (m) => fmtToks(m.contextWindow) },
			{ id: "maxout", label: "Max out", def: true, num: true, sort: (m) => m.maxTokens ?? 0, render: (m) => fmtToks(m.maxTokens) },
			{ id: "modal", label: "Modalities", def: true, filter: "mod", render: (m) => fmtModalities(m.modalities) },
			{ id: "price", label: "Price / Mtok", def: true, num: true, sort: (m) => m.pricing?.input ?? Infinity, filter: "price",
				render: (m, td) => {
					td.textContent = m.pricing ? `${fmtPrice(m.pricing.input)} / ${fmtPrice(m.pricing.output)}` : "—";
					if (m.pricing) td.title = `Input ${fmtPrice(m.pricing.input)}/Mtok · Output ${fmtPrice(m.pricing.output)}/Mtok`;
				} },
			{ id: "tags", label: "Tags", def: true, cls: "model-tags", filter: "tag", render: (m) => (m.tags || []).join(", ") },
			{ id: "owner", label: "Owner", def: false, render: (m) => m.owner || "—" },
			{ id: "params", label: "Parameters", def: false, cls: "model-tags", render: (m) => (m.supportedParameters || []).join(", ") || "—" },
			{ id: "reasoning", label: "Reasoning", def: false, cls: "model-tags", render: (m) => (m.reasoning || []).join(", ") || "—" },
			{ id: "knowledge", label: "Knowledge", def: false, num: true, render: (m) => m.knowledgeCutoff || "—" },
			{ id: "released", label: "Released", def: false, num: true, sort: (m) => m.releasedAt ?? 0, render: (m) => fmtDateCol(m.releasedAt) || "—" },
		];
		const colState = new Set(COLS.filter((c) => c.def).map((c) => c.id));
		const visCols = () => COLS.filter((c) => colState.has(c.id));
		const filterState = { q: "", ctx: 0, price: 0, mod: "", tag: "" };
		let sortBy = null;
		let cur = [];

		const colPick = document.createElement("div");
		colPick.className = "colpick";
		const colPickBtn = ghost("Columns ▾", () => {
			colPickPanel.hidden = !colPickPanel.hidden;
		});
		const colPickPanel = el("div", "colpick-panel", "");
		colPickPanel.hidden = true;
		for (const c of COLS) {
			const lab = document.createElement("label");
			lab.className = "check colpick-item";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.checked = c.def;
			cb.addEventListener("change", () => {
				if (cb.checked) colState.add(c.id); else colState.delete(c.id);
				rebuildHead();
				apply();
			});
			lab.appendChild(cb);
			lab.appendChild(document.createTextNode(c.label));
			colPickPanel.appendChild(lab);
		}
		document.addEventListener("click", (e) => {
			if (!colPick.contains(e.target)) colPickPanel.hidden = true;
		});
		colPick.appendChild(colPickBtn);
		colPick.appendChild(colPickPanel);
		mHead.appendChild(colPick);

		const thead = document.createElement("thead");
		const tagSel = document.createElement("select");
		tagSel.className = "col-filter";
		tagSel.title = "Tag";
		tagSel.addEventListener("change", () => { filterState.tag = tagSel.value; apply(); });
		const numFilter = (ph, key) => {
			const i = document.createElement("input");
			i.className = "col-filter num";
			i.type = "number";
			i.min = "0";
			i.placeholder = ph;
			i.value = filterState[key] || "";
			i.addEventListener("input", () => { filterState[key] = Number(i.value) || 0; apply(); });
			return i;
		};
		const rebuildHead = () => {
			thead.innerHTML = "";
			const r1 = document.createElement("tr");
			r1.appendChild(el("th", "c-model", "Model"));
			for (const c of visCols()) {
				const th = el("th", (c.num ? "num " : "") + (c.sort ? "sortable" : ""),
					c.label + (sortBy?.id === c.id ? (sortBy.dir < 0 ? " ↓" : " ↑") : ""));
				if (c.sort) {
					th.title = "Sort";
					th.addEventListener("click", () => {
						if (sortBy?.id === c.id) {
							if (sortBy.dir < 0) sortBy = { id: c.id, dir: 1 };
							else sortBy = null;
						} else sortBy = { id: c.id, dir: -1 };
						rebuildHead();
						apply();
					});
				}
				r1.appendChild(th);
			}
			r1.appendChild(el("th", "", ""));
			thead.appendChild(r1);
			const r2 = document.createElement("tr");
			r2.className = "filter-row";
			const tdq = document.createElement("td");
			const q = document.createElement("input");
			q.className = "col-filter";
			q.placeholder = "Filter…";
			q.value = filterState.q;
			q.addEventListener("input", () => { filterState.q = q.value; apply(); });
			tdq.appendChild(q);
			r2.appendChild(tdq);
			for (const c of visCols()) {
				const td = document.createElement("td");
				if (c.filter === "ctx") td.appendChild(numFilter("≥", "ctx"));
				else if (c.filter === "price") td.appendChild(numFilter("$≤", "price"));
				else if (c.filter === "mod") {
					const s = document.createElement("select");
					s.className = "col-filter";
					for (const [v, l] of [["", "all"], ["image", "image"], ["audio", "audio"], ["file", "file"]])
						s.appendChild(Object.assign(document.createElement("option"), { value: v, textContent: l }));
					s.value = filterState.mod;
					s.addEventListener("change", () => { filterState.mod = s.value; apply(); });
					td.appendChild(s);
				} else if (c.filter === "tag") td.appendChild(tagSel);
				r2.appendChild(td);
			}
			r2.appendChild(document.createElement("td"));
			thead.appendChild(r2);
		};

		const rebuildTags = () => {
			const tags = [...new Set(cur.flatMap((m) => m.tags ?? []))].sort();
			const v = tagSel.value;
			tagSel.innerHTML = "<option value=\"\">any tag</option>";
			for (const t of tags) tagSel.appendChild(Object.assign(document.createElement("option"), { value: t, textContent: t }));
			tagSel.value = tags.includes(v) ? v : "";
		};
		function apply() {
			const q = filterState.q.toLowerCase();
			const ctx = filterState.ctx;
			const price = filterState.price;
			const mod = filterState.mod;
			const tag = filterState.tag;
			let out = cur.filter((m) => {
				if (q && !((m.label || "") + " " + m.id + " " + (m.description || "") + " " + (m.tags || []).join(" ")).toLowerCase().includes(q)) return false;
				if (ctx && (m.contextWindow ?? 0) < ctx) return false;
				if (price && (m.pricing?.input == null || m.pricing.input * 1e6 > price)) return false;
				if (mod && !(m.modalities?.input || []).includes(mod)) return false;
				if (tag && !(m.tags || []).includes(tag)) return false;
				return true;
			});
			if (sortBy) {
				const c = COLS.find((x) => x.id === sortBy.id);
				out = [...out].sort((a, b) => (c.sort(a) - c.sort(b)) * -sortBy.dir);
			}
			fill(out);
		}
		const setModels = (models) => { cur = models ?? []; rebuildTags(); apply(); };
		const table = document.createElement("table");
		table.className = "providers-table models-table";
		table.appendChild(thead);
		const tbody = document.createElement("tbody");
		table.appendChild(tbody);
		const fill = (models) => {
			tbody.innerHTML = "";
			const span = visCols().length + 2;
			if (!models || models.length === 0) {
				tbody.innerHTML = `<tr><td colspan="${span}"><em>no models — fetch to load the catalog</em></td></tr>`;
				return;
			}
			for (const m of models) {
				const tr = document.createElement("tr");
				const tdId = document.createElement("td");
				tdId.className = "c-model";
				const name = document.createElement("div");
				name.className = "model-name";
				name.textContent = m.label || m.id;
				tdId.appendChild(name);
				if (m.label && m.label !== m.id) {
					const idline = document.createElement("div");
					idline.className = "model-id";
					idline.textContent = m.id;
					tdId.appendChild(idline);
				}
				if (m.description) {
					const desc = document.createElement("div");
					desc.className = "model-desc";
					desc.textContent = m.description;
					desc.title = m.description;
					tdId.appendChild(desc);
				}
				tr.appendChild(tdId);
				for (const c of visCols()) {
					const td = document.createElement("td");
					if (c.num) td.className = "num";
					if (c.cls) td.classList.add(...c.cls.split(" "));
					c.render(m, td);
					tr.appendChild(td);
				}
				const tdUse = document.createElement("td");
				tdUse.className = "c-actions";
				if (p.modelId === m.id) tdUse.innerHTML = "<em>default</em>";
				tdUse.appendChild(mkBtn("ⓘ", () => {
					const next = tr.nextSibling;
					if (next?.classList?.contains("model-detail")) {
						next.remove();
						return;
					}
					tr.parentNode.insertBefore(detailRow(m, span), tr.nextSibling);
				}));
				tdUse.appendChild(mkBtn("Use", () => {
					p.modelId = m.id;
					saveProfiles();
					vscode.postMessage({ type: "set", key: "provider.profile", value: p.name });
					vscode.postMessage({ type: "set", key: "provider.modelId", value: m.id });
					showSaved();
				}));
				tr.appendChild(tdUse);
				tbody.appendChild(tr);
			}
		};
		const detailRow = (m, span) => {
			const tr = document.createElement("tr");
			tr.className = "model-detail";
			const td = document.createElement("td");
			td.colSpan = span;
			const dgrid = document.createElement("div");
			dgrid.className = "detail-grid";
			const perTok = (v) => (v == null ? "" : `$${v} / tok`);
			const rows = [
				["ID", m.id],
				["Owner", m.owner],
				["Context", m.contextWindow?.toLocaleString() + " tok"],
				["Max output", m.maxTokens?.toLocaleString() + " tok"],
				["Modalities", fmtModalities(m.modalities)],
				["Input price", m.pricing?.input != null ? `${fmtPrice(m.pricing.input)} / Mtok (${perTok(m.pricing.input)})` : ""],
				["Output price", m.pricing?.output != null ? `${fmtPrice(m.pricing.output)} / Mtok (${perTok(m.pricing.output)})` : ""],
				["Tags", (m.tags || []).join(", ")],
				["Parameters", (m.supportedParameters || []).join(", ")],
				["Reasoning", (m.reasoning || []).join(", ")],
				["Knowledge", m.knowledgeCutoff],
				["Released", fmtDateCol(m.releasedAt)],
			];
			for (const [k, v] of rows) {
				if (!v) continue;
				const item = document.createElement("div");
				item.className = "detail-item";
				item.appendChild(el("span", "detail-key", k));
				item.appendChild(el("span", "detail-val", v));
				dgrid.appendChild(item);
			}
			td.appendChild(dgrid);
			if (m.description) {
				const d = document.createElement("p");
				d.className = "detail-desc";
				d.textContent = m.description;
				td.appendChild(d);
			}
			tr.appendChild(td);
			return tr;
		};
		rebuildHead();
		setModels(p.models);
		onModels(p.name, (r) => {
			if (r.models?.length) {
				fillModelSel(r.models);
				setModels(r.models);
				cacheNote.textContent = `cached ${new Date().toLocaleString()}`;
			}
			const n = r.models?.length ?? 0;
			refreshBtn.textContent = n ? `Refresh (${n})` : "Refresh failed";
			test.disabled = false;
			testStat.textContent = n ? `✓ ${n} models` : `✗ ${r.error || "fetch failed"}`;
			testStat.title = testStat.textContent;
			errNote.textContent = n ? "" : r.error || "";
		});
		const tableWrap = el("div", "prov-tablewrap", "");
		tableWrap.appendChild(table);
		modelsSec.appendChild(tableWrap);
		ed.appendChild(modelsSec);

		// ---- footer ----
		const foot = el("div", "prov-foot", "");
		const del = ghost("Delete provider", () => {
			if (keySet && !confirm("Delete provider " + p.name + " and its stored key?")) return;
			if (keySet) vscode.postMessage({ type: "clearProfileKey", name: p.name });
			const i = profiles.indexOf(p);
			if (i >= 0) profiles.splice(i, 1);
			saveProfiles();
		});
		del.classList.add("danger");
		foot.appendChild(del);
		ed.appendChild(foot);

		card.appendChild(ed);
		return card;
	};

	document.getElementById("add-profile").addEventListener("click", () => {
		presetOpen = !presetOpen;
		renderPresetPicker();
	});
	document.getElementById("snapshot-profile").addEventListener("click", () => {
		profiles.push({
			name: "provider-" + (profiles.length + 1),
			providerId: lastValues["provider.id"] || "openai-compatible",
			baseUrl: lastValues["provider.baseUrl"] || "",
			modelId: lastValues["provider.modelId"] || "",
		});
		saveProfiles();
	});

	let lastValues = {};
	window.addEventListener("message", (event) => {
		const msg = event.data;
		if (msg.type === "values") {
			modelSubs.clear();
			lastValues = msg.values;
			for (const el of fields) {
				if (el.dataset.dynamic === "profiles" && msg.profileNames) {
					el.innerHTML = "";
					const none = document.createElement("option");
					none.value = "";
					none.textContent = "(none)";
					el.appendChild(none);
					for (const name of msg.profileNames) {
						const opt = document.createElement("option");
						opt.value = name;
						opt.textContent = name;
						el.appendChild(opt);
					}
				}
				const value = msg.values[el.dataset.key];
				if (value === undefined) continue;
				if (el.dataset.kind === "bool") el.checked = Boolean(value);
				else el.value = value;
			}
			apiKeyStatus.textContent = msg.apiKeySet ? "— set" : "— not set";
			renderProfiles(msg);
		}
		if (msg.type === "modelsResult") modelsResult.textContent = msg.text;
		if (msg.type === "profileModels") {
			// Keep the local profiles array in sync so a later saveProfiles() doesn't
			// write back a stale catalog and wipe the persisted models.
			const p = profiles.find((x) => x.name === msg.name);
			if (p && msg.models?.length) {
				p.models = msg.models;
				p.modelsFetchedAt = Date.now();
			}
			for (const fn of modelSubs.get(msg.name) ?? []) fn(msg);
		}
	});

	vscode.postMessage({ type: "ready" });
})();
