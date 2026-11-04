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

	const renderProfiles = (msg) => {
		try { profiles = JSON.parse(msg.values["provider.profiles"] || "[]"); } catch { profiles = []; }
		profilesList.innerHTML = "";
		if (profiles.length === 0) {
			profilesList.innerHTML = '<p class="note">No saved providers — add one for each config.</p>';
			return;
		}
		const table = document.createElement("table");
		table.className = "providers-table";
		table.innerHTML = "<thead><tr><th>Name</th><th>Provider</th><th>Base URL</th><th>Model</th><th>Key</th><th>Active</th><th></th></tr></thead>";
		const tbody = document.createElement("tbody");
		const activeName = msg.values["provider.profile"] || "";
		profiles.forEach((p, i) => {
			const row = document.createElement("tr");
			const cell = () => { const td = document.createElement("td"); row.appendChild(td); return td; };
			const mkInput = (field, ph, list) => {
				const input = document.createElement("input");
				input.placeholder = ph;
				input.value = p[field] || "";
				if (list) input.setAttribute("list", list);
				input.addEventListener("change", () => { p[field] = input.value.trim(); saveProfiles(); showSaved(); });
				return input;
			};
			const nameInput = mkInput("name", "name");
			let oldName = p.name || "";
			nameInput.addEventListener("change", () => {
				const newName = nameInput.value.trim();
				if (newName && newName !== oldName && oldName) {
					vscode.postMessage({ type: "renameProfileKey", oldName, newName });
					oldName = newName;
				}
			});
			cell().appendChild(nameInput);
			cell().appendChild(mkInput("providerId", "provider", "provider-ids"));
			cell().appendChild(mkInput("baseUrl", "https://…/v1"));
			const mcell = cell();
			const select = document.createElement("select");
			const fill = (models) => {
				select.innerHTML = "";
				if (!models || models.length === 0) return;
				for (const m of models) {
					const opt = document.createElement("option");
					opt.value = m.id; opt.textContent = m.label || m.id;
					if (m.id === p.modelId) opt.selected = true;
					select.appendChild(opt);
				}
				if (!models.find((m) => m.id === p.modelId)) {
					const opt = document.createElement("option");
					opt.value = p.modelId || ""; opt.textContent = p.modelId || "(set model)";
					opt.selected = true;
					select.appendChild(opt);
				}
			};
			onModels(p.name, (msg) => {
				fill(msg.models);
				const n = msg.models?.length ?? 0;
				fetchBtn.textContent = n ? String(n) : "✗";
				fetchBtn.title = n ? `${n} models` : msg.error || "Fetch failed";
			});
			select.addEventListener("change", () => { p.modelId = select.value; saveProfiles(); showSaved(); });
			const fetchBtn = Object.assign(document.createElement("button"), { textContent: "⌄ fetch" });
			fetchBtn.className = "secondary tiny";
			fetchBtn.title = "Fetch models from this provider (no key needed for open catalogs)";
			fetchBtn.addEventListener("click", () => {
				fetchBtn.textContent = "…";
				vscode.postMessage({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl });
			});
			const modelInput = mkInput("modelId", "model-id");
			mcell.appendChild(modelInput);
			mcell.appendChild(select);
			mcell.appendChild(fetchBtn);
			const kcell = cell();
			const keySet = msg.profileKeys && msg.profileKeys[p.name];
			const badge = document.createElement("em");
			badge.textContent = keySet ? "key set" : "no key";
			badge.title = keySet ? "Profile-specific key stored" : "Set an API key for this provider";
			kcell.appendChild(badge);
			const setKey = Object.assign(document.createElement("button"), { textContent: "key" });
			setKey.className = "secondary tiny";
			setKey.addEventListener("click", () => vscode.postMessage({ type: "setProfileKey", name: p.name }));
			const clrKey = Object.assign(document.createElement("button"), { textContent: "✗" });
			clrKey.className = "secondary tiny";
			clrKey.addEventListener("click", () => vscode.postMessage({ type: "clearProfileKey", name: p.name }));
			kcell.appendChild(setKey);
			kcell.appendChild(clrKey);
			const acell = cell();
			const radio = document.createElement("input");
			radio.type = "radio";
			radio.name = "active-provider";
			radio.checked = p.name === activeName;
			radio.addEventListener("change", () => {
				vscode.postMessage({ type: "set", key: "provider.profile", value: p.name });
				showSaved();
			});
			acell.appendChild(radio);
			const dcell = cell();
			const test = Object.assign(document.createElement("button"), { textContent: "test" });
			test.className = "secondary tiny";
			test.title = "Test the provider's /models endpoint (works without a key on open catalogs)";
			const stat = document.createElement("em");
			stat.className = "test-status";
			test.addEventListener("click", () => {
				test.textContent = "…";
				stat.textContent = "";
				vscode.postMessage({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl });
			});
			onModels(p.name, (msg) => {
				if (test.textContent !== "…") return;
				const n = msg.models?.length ?? 0;
				test.textContent = n ? `✓ ${n}` : "✗";
				stat.textContent = n ? "" : ` ${msg.error || "fetch failed"}`;
				stat.title = stat.textContent;
			});
			dcell.appendChild(test);
			dcell.appendChild(stat);
			const del = Object.assign(document.createElement("button"), { textContent: "✗" });
			del.className = "secondary tiny";
			del.addEventListener("click", () => {
				if (keySet && !confirm("Delete provider " + p.name + " and its stored key?")) return;
				if (keySet) vscode.postMessage({ type: "clearProfileKey", name: p.name });
				profiles.splice(i, 1);
				saveProfiles();
			});
			dcell.appendChild(del);
			tbody.appendChild(row);
		});
		table.appendChild(tbody);
		profilesList.appendChild(table);
	};

	const modelsList = document.getElementById("models-list");
	const renderModelsPage = (msg) => {
		if (!modelsList) return;
		modelsList.innerHTML = "";
		if (profiles.length === 0) {
			modelsList.innerHTML = '<p class="note">No providers configured — add them under Provider first.</p>';
			return;
		}
		const activeName = msg.values["provider.profile"] || "";
		profiles.forEach((p) => {
			const block = document.createElement("div");
			block.className = "profile-card";
			const head = document.createElement("div");
			head.className = "row";
			head.appendChild(Object.assign(document.createElement("strong"), { textContent: p.name }));
			head.appendChild(Object.assign(document.createElement("em"), { textContent: p.baseUrl || "no base URL" }));
			if (p.modelId) head.appendChild(Object.assign(document.createElement("code"), { textContent: p.modelId }));
			if (p.name === activeName) head.appendChild(Object.assign(document.createElement("em"), { textContent: "· active" }));
			block.appendChild(head);
			const controls = document.createElement("div");
			controls.className = "model-controls";
			const filter = Object.assign(document.createElement("input"), { placeholder: "Filter models…" });
			filter.className = "model-filter";
			filter.addEventListener("input", apply);
			controls.appendChild(filter);
			const mkSel = (opts, title) => {
				const s = document.createElement("select");
				s.className = "model-sel";
				s.title = title;
				for (const [v, l] of opts) {
					const o = document.createElement("option");
					o.value = v; o.textContent = l;
					s.appendChild(o);
				}
				s.addEventListener("change", apply);
				return s;
			};
			const ctxSel = mkSel([["", "Ctx: any"], ["32768", "Ctx ≥32k"], ["131072", "Ctx ≥128k"], ["262144", "Ctx ≥256k"], ["1048576", "Ctx ≥1M"]], "Minimum context window");
			const priceSel = mkSel([["", "Price: any"], ["0.25", "≤ $0.25/M"], ["0.5", "≤ $0.50/M"], ["1", "≤ $1/M"], ["3", "≤ $3/M"], ["15", "≤ $15/M"]], "Max input price per Mtok");
			const modSel = mkSel([["", "Modalities: all"], ["image", "Image input"], ["audio", "Audio"], ["file", "File input"]], "Input modality");
			const tagSel = mkSel([["", "Tag: any"]], "Tag");
			const sortSel = mkSel([["", "Sort: default"], ["ctx", "Context ↓"], ["price-asc", "Price ↑"], ["price-desc", "Price ↓"]], "Sort order");
			for (const s of [ctxSel, priceSel, modSel, tagSel, sortSel]) controls.appendChild(s);
			block.appendChild(controls);
			let cur = [];
			const rebuildTags = () => {
				const tags = [...new Set(cur.flatMap((m) => m.tags ?? []))].sort();
				const v = tagSel.value;
				tagSel.innerHTML = "<option value=\"\">Tag: any</option>";
				for (const t of tags) tagSel.appendChild(Object.assign(document.createElement("option"), { value: t, textContent: t }));
				tagSel.value = tags.includes(v) ? v : "";
			};
			function apply() {
				const q = filter.value.toLowerCase();
				const ctx = Number(ctxSel.value) || 0;
				const price = Number(priceSel.value) || 0;
				const mod = modSel.value;
				const tag = tagSel.value;
				let out = cur.filter((m) => {
					if (q && !((m.label || "") + " " + m.id + " " + (m.description || "") + " " + (m.tags || []).join(" ")).toLowerCase().includes(q)) return false;
					if (ctx && (m.contextWindow ?? 0) < ctx) return false;
					if (price && (m.pricing?.input == null || m.pricing.input * 1e6 > price)) return false;
					if (mod && !(m.modalities?.input || []).includes(mod)) return false;
					if (tag && !(m.tags || []).includes(tag)) return false;
					return true;
				});
				if (sortSel.value === "ctx") out = [...out].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
				if (sortSel.value === "price-asc") out = [...out].sort((a, b) => (a.pricing?.input ?? Infinity) - (b.pricing?.input ?? Infinity));
				if (sortSel.value === "price-desc") out = [...out].sort((a, b) => (b.pricing?.input ?? -Infinity) - (a.pricing?.input ?? -Infinity));
				fill(out);
			}
			const setModels = (models) => { cur = models ?? []; rebuildTags(); apply(); };
			const table = document.createElement("table");
			table.className = "providers-table models-table";
			table.innerHTML = "<thead><tr><th>Model</th><th>Context</th><th>Max out</th><th>Modalities</th><th>Price / Mtok</th><th>Tags</th><th></th></tr></thead>";
			const tbody = document.createElement("tbody");
			table.appendChild(tbody);
			const fill = (models) => {
				tbody.innerHTML = "";
				if (!models || models.length === 0) {
					tbody.innerHTML = "<tr><td colspan=\"7\"><em>no models</em></td></tr>";
					return;
				}
				for (const m of models) {
					const tr = document.createElement("tr");
					const tdId = document.createElement("td");
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
					const num = (v) => { const td = document.createElement("td"); td.className = "num"; td.textContent = v || "—"; return td; };
					tr.appendChild(num(fmtToks(m.contextWindow)));
					tr.appendChild(num(fmtToks(m.maxTokens)));
					tr.appendChild(num(fmtModalities(m.modalities)));
					const tdPrice = document.createElement("td");
					tdPrice.className = "num";
					tdPrice.textContent = m.pricing ? `${fmtPrice(m.pricing.input)} / ${fmtPrice(m.pricing.output)}` : "—";
					if (m.pricing) tdPrice.title = `Input ${fmtPrice(m.pricing.input)}/Mtok · Output ${fmtPrice(m.pricing.output)}/Mtok`;
					tr.appendChild(tdPrice);
					const tdTags = document.createElement("td");
					tdTags.className = "model-tags";
					tdTags.textContent = (m.tags || []).join(", ");
					tr.appendChild(tdTags);
					const tdUse = document.createElement("td");
					tdUse.style.width = "1%";
					if (p.modelId === m.id) tdUse.innerHTML = "<em>default</em>";
					const info = Object.assign(document.createElement("button"), { textContent: "ⓘ" });
					info.className = "secondary tiny";
					info.title = "Model details";
					info.addEventListener("click", () => {
						const next = tr.nextSibling;
						if (next?.classList?.contains("model-detail")) {
							next.remove();
							return;
						}
						tr.parentNode.insertBefore(detailRow(m), tr.nextSibling);
					});
					tdUse.appendChild(info);
					const use = Object.assign(document.createElement("button"), { textContent: "Use" });
					use.className = "secondary tiny";
					use.addEventListener("click", () => {
						p.modelId = m.id;
						saveProfiles();
						vscode.postMessage({ type: "set", key: "provider.profile", value: p.name });
						vscode.postMessage({ type: "set", key: "provider.modelId", value: m.id });
						showSaved();
					});
					tdUse.appendChild(use);
					tr.appendChild(tdUse);
					tbody.appendChild(tr);
				}
			};
			const detailRow = (m) => {
				const tr = document.createElement("tr");
				tr.className = "model-detail";
				const td = document.createElement("td");
				td.colSpan = 7;
				const grid = document.createElement("div");
				grid.className = "detail-grid";
				const fmtDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "");
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
					["Released", fmtDate(m.releasedAt)],
				];
				for (const [k, v] of rows) {
					if (!v) continue;
					const item = document.createElement("div");
					item.className = "detail-item";
					item.appendChild(Object.assign(document.createElement("span"), { className: "detail-key", textContent: k }));
					item.appendChild(Object.assign(document.createElement("span"), { className: "detail-val", textContent: v }));
					grid.appendChild(item);
				}
				td.appendChild(grid);
				if (m.description) {
					const d = document.createElement("p");
					d.className = "detail-desc";
					d.textContent = m.description;
					td.appendChild(d);
				}
				tr.appendChild(td);
				return tr;
			};
			setModels(p.models);
			onModels(p.name, (msg) => {
				setModels(msg.models);
				const n = msg.models?.length ?? 0;
				fetchBtn.textContent = n ? `Refresh (${n})` : "Refresh failed";
				errNote.textContent = n ? "" : msg.error || "";
				if (n) cacheNote.textContent = ` cached ${new Date().toLocaleString()}`;
			});
			const fetchBtn = Object.assign(document.createElement("button"), {
				textContent: p.models?.length ? `Refresh (${p.models.length})` : "Fetch models",
			});
			fetchBtn.className = "secondary";
			const errNote = Object.assign(document.createElement("em"), { className: "test-status" });
			const cacheNote = Object.assign(document.createElement("em"), {
				className: "test-status",
				textContent: p.modelsFetchedAt ? ` cached ${new Date(p.modelsFetchedAt).toLocaleString()}` : "",
			});
			fetchBtn.addEventListener("click", () => {
				fetchBtn.textContent = "Fetching…";
				errNote.textContent = "";
				vscode.postMessage({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl });
			});
			block.appendChild(fetchBtn);
			block.appendChild(cacheNote);
			block.appendChild(errNote);
			block.appendChild(table);
			modelsList.appendChild(block);
		});
	};

	document.getElementById("add-profile").addEventListener("click", () => {
		profiles.push({ name: "provider-" + (profiles.length + 1), providerId: "openai-compatible", baseUrl: "", modelId: "" });
		saveProfiles();
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
			renderModelsPage(msg);
		}
		if (msg.type === "modelsResult") modelsResult.textContent = msg.text;
		if (msg.type === "profileModels") {
			for (const fn of modelSubs.get(msg.name) ?? []) fn(msg);
		}
	});

	vscode.postMessage({ type: "ready" });
})();
