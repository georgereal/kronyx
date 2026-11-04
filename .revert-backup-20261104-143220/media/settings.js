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
	const pendingModelFills = new Map();
	const profilesList = document.getElementById("profiles-list");
	const saveProfiles = () => vscode.postMessage({ type: "set", key: "provider.profiles", value: profiles });

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
			pendingModelFills.set(p.name, (models) => {
				fill(models);
				fetchBtn.textContent = models && models.length ? String(models.length) : "✗";
			});
			select.addEventListener("change", () => { p.modelId = select.value; saveProfiles(); showSaved(); });
			const fetchBtn = Object.assign(document.createElement("button"), { textContent: "⌄ fetch" });
			fetchBtn.className = "secondary tiny";
			fetchBtn.title = "Fetch models from this provider";
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
			const filter = Object.assign(document.createElement("input"), { placeholder: "Filter models…" });
			filter.className = "model-filter";
			filter.addEventListener("input", () => {
				const q = filter.value.toLowerCase();
				for (const tr of tbody.querySelectorAll("tr")) tr.hidden = q.length > 0 && !tr.textContent.toLowerCase().includes(q);
			});
			block.appendChild(filter);
			const table = document.createElement("table");
			table.className = "providers-table";
			const tbody = document.createElement("tbody");
			table.appendChild(tbody);
			const fill = (models) => {
				tbody.innerHTML = "";
				if (!models || models.length === 0) {
					tbody.innerHTML = "<tr><td colspan=\"2\"><em>no models</em></td></tr>";
					return;
				}
				for (const m of models) {
					const tr = document.createElement("tr");
					const tdId = document.createElement("td");
					tdId.textContent = m.label || m.id;
					tr.appendChild(tdId);
					const tdUse = document.createElement("td");
					tdUse.style.width = "1%";
					if (p.modelId === m.id) tdUse.innerHTML = "<em>default</em>";
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
			pendingModelFills.set(p.name, (models) => {
				fill(models);
				fetchBtn.textContent = models && models.length ? "Fetched " + models.length : "Fetch failed";
			});
			const fetchBtn = Object.assign(document.createElement("button"), { textContent: "Fetch models" });
			fetchBtn.className = "secondary";
			fetchBtn.addEventListener("click", () => {
				fetchBtn.textContent = "Fetching…";
				vscode.postMessage({ type: "fetchProfileModels", name: p.name, baseUrl: p.baseUrl });
			});
			block.appendChild(fetchBtn);
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
			const done = pendingModelFills.get(msg.name);
			if (done) done(msg.models);
		}
	});

	vscode.postMessage({ type: "ready" });
})();
