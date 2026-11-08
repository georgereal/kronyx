// @ts-check
(() => {
	// @ts-ignore acquireVsCodeApi is injected by VS Code
	const vscode = acquireVsCodeApi();
	const timeline = /** @type {HTMLElement} */ (document.getElementById("timeline"));
	const task = /** @type {HTMLTextAreaElement} */ (document.getElementById("task"));
	const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
	const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById("stop"));
	const hdrStatus = /** @type {HTMLElement} */ (document.getElementById("hdr-status"));
	const hdrRepo = /** @type {HTMLElement} */ (document.getElementById("hdr-repo"));
	const hdrBranch = /** @type {HTMLElement} */ (document.getElementById("hdr-branch"));
	const hdrPr = /** @type {HTMLAnchorElement} */ (document.getElementById("hdr-pr"));
	const paneFiles = /** @type {HTMLElement} */ (document.getElementById("pane-files"));
	const paneDiff = /** @type {HTMLElement} */ (document.getElementById("pane-diff"));
	const paneShell = /** @type {HTMLElement} */ (document.getElementById("pane-shell"));
	const files = new Map();

	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	};
	/** @param {string} md */
	const md = (text) => {
		// @ts-ignore marked is loaded globally
		const node = el("div", "md");
		node.innerHTML = window.marked ? window.marked.parse(text) : text;
		return node;
	};
	const scroll = (pane) => { pane.scrollTop = pane.scrollHeight; };
	const addStep = (cls, ...nodes) => {
		const s = el("div", `step ${cls}`);
		for (const n of nodes) s.appendChild(n);
		timeline.appendChild(s);
		scroll(timeline);
		return s;
	};
	const setStatus = (text) => { hdrStatus.textContent = text; };

	const send = () => {
		const text = task.value.trim();
		if (!text) return;
		vscode.postMessage({ type: "run", task: text });
		task.value = "";
	};
	sendBtn.addEventListener("click", send);
	stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
	task.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
	});
	const setupchip = /** @type {HTMLButtonElement} */ (document.getElementById("setupchip"));
	const setupmenu = /** @type {HTMLElement} */ (document.getElementById("setupmenu"));
	setupchip.addEventListener("click", () => { setupmenu.hidden = !setupmenu.hidden; });
	document.addEventListener("click", (e) => {
		if (!(e.target instanceof HTMLElement)) return;
		if (!setupmenu.hidden && !e.target.closest("#setupmenu") && e.target !== setupchip) setupmenu.hidden = true;
	});
	document.querySelectorAll(".tab").forEach((t) => {
		t.addEventListener("click", () => {
			document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
			document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === `pane-${t.dataset.tab}`));
		});
	});

	window.addEventListener("message", (event) => {
		const msg = event.data;
		switch (msg.type) {
			case "cloud-status":
				setStatus(msg.text);
				addStep("cloud", el("span", "cloud-dot", "☁"), el("span", "", msg.text));
				break;
			case "setupStatus": {
				const chip = document.getElementById("setupchip");
				const menu = document.getElementById("setupmenu");
				const ready = msg.items.every((i) => i.ok);
				chip.textContent = ready ? "✓ Ready" : "● Setup needed";
				chip.classList.toggle("ok", ready);
				chip.classList.toggle("warn", !ready);
				menu.innerHTML = "";
				for (const it of msg.items) {
					const row = el("div", "setup-row" + (it.ok ? " ok" : " fail"));
					row.appendChild(el("span", "setup-mark", it.ok ? "✓" : "✗"));
					row.appendChild(el("span", "setup-l", it.label));
					const btn = el("button", "setup-fix", it.ok ? "" : (it.fixLabel || "Fix"));
					if (!it.ok) btn.onclick = () => vscode.postMessage({ type: "fixSetup", key: it.key });
					row.appendChild(btn);
					menu.appendChild(row);
				}
				break;
			}
			case "github-enable": {
				const card = el("div", "ghcard");
				card.appendChild(el("div", "ghcard-title", `GitHub access needed for ${msg.repo}`));
				const row = el("div", "ghcard-actions");
				const enable = el("button", "btn-sm", "Enable GitHub access");
				enable.onclick = () => vscode.postMessage({ type: "githubOpen", url: msg.url });
				const pat = el("button", "btn-sm ghost", "Use PAT");
				pat.onclick = () => vscode.postMessage({ type: "githubPat" });
				const cancel = el("button", "btn-sm ghost", "Cancel");
				cancel.onclick = () => vscode.postMessage({ type: "githubCancel" });
				row.appendChild(enable); row.appendChild(pat); row.appendChild(cancel);
				card.appendChild(el("div", "muted ghcard-hint", "Waiting for the install to complete — the run resumes automatically…"));
				card.appendChild(row);
				timeline.appendChild(card);
				scrollBottom();
				break;
			}
			case "setup": {
				const MARK = { run: "…", ok: "✓", fail: "✗" };
				let row = timeline.querySelector(`[data-setup="${msg.step}"]`);
				if (!row) {
					row = addStep("setup", el("span", "setup-mark"), el("span", "setup-label"), el("span", "setup-detail muted"));
					row.dataset.setup = String(msg.step);
				}
				row.classList.toggle("fail", msg.state === "fail");
				row.querySelector(".setup-mark").textContent = MARK[msg.state] || "…";
				row.querySelector(".setup-label").textContent = msg.label;
				row.querySelector(".setup-detail").textContent = msg.detail ?? "";
				break;
			}
			case "run-started":
				setStatus("Running…");
				sendBtn.hidden = true;
				stopBtn.hidden = false;
				addStep("run", el("strong", "", msg.task || "Run"));
				break;
			case "assistant":
				addStep("assistant", md(msg.text || ""));
				break;
			case "plan":
				addStep("plan", el("strong", "", "Plan"), md(msg.plan || msg.text || ""));
				break;
			case "tool":
				addStep("tool", el("span", "tool-name", msg.name || "tool"), el("span", "tool-args", (msg.args || "").slice(0, 120)));
				paneShell.appendChild(el("div", "shell-line", `$ ${msg.name} ${msg.args ?? ""}`));
				scroll(paneShell);
				break;
			case "tool-result":
				if (msg.output) {
					paneShell.appendChild(el("div", "shell-out", String(msg.output).slice(0, 2000)));
					scroll(paneShell);
				}
				break;
			case "file-changed": {
				const row = el("div", "file-row", `${msg.kind ?? "edited"}  ${msg.path}`);
				files.set(msg.path, msg.diff ?? "");
				paneFiles.appendChild(row);
				addStep("file", el("span", "file-path", `± ${msg.path}`));
				if (msg.diff) {
					const d = el("div", "diff-block");
					d.appendChild(el("div", "diff-file mono", String(msg.path)));
					d.appendChild(el("pre", "diff-body", String(msg.diff).slice(0, 8000)));
					paneDiff.appendChild(d);
					scroll(paneDiff);
				}
				break;
			}
			case "checks":
				addStep("checks", el("strong", "", `Checks: ${msg.status}`));
				break;
			case "status":
				setStatus(msg.text || "");
				break;
			case "run-finished":
				setStatus("Done");
				sendBtn.hidden = false;
				stopBtn.hidden = true;
				addStep("done", el("strong", "", "Run finished"), msg.summary ? md(msg.summary) : el("span"));
				break;
			case "run-failed":
				setStatus("Failed");
				sendBtn.hidden = false;
				stopBtn.hidden = true;
				addStep("failed", el("strong", "", "Run failed"), el("span", "", msg.error || ""));
				break;
			case "state":
				if (msg.cloudRepo) { hdrRepo.hidden = false; hdrRepo.textContent = msg.cloudRepo; }
				if (msg.cloudBranch) { hdrBranch.hidden = false; hdrBranch.textContent = msg.cloudBranch; }
				if (msg.cloudPr) { hdrPr.hidden = false; hdrPr.href = msg.cloudPr; hdrPr.textContent = "Open PR ↗"; }
				break;
		}
	});
	vscode.postMessage({ type: "requestState" });
})();
