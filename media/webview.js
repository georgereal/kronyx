// @ts-check
(() => {
	// @ts-ignore acquireVsCodeApi is injected by VS Code
	const vscode = acquireVsCodeApi();
	const timeline = /** @type {HTMLElement} */ (document.getElementById("timeline"));
	const form = /** @type {HTMLFormElement} */ (document.getElementById("composer"));
	const task = /** @type {HTMLTextAreaElement} */ (document.getElementById("task"));
	const runBtn = /** @type {HTMLButtonElement} */ (document.getElementById("run"));
	const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById("stop"));
	const newBtn = /** @type {HTMLButtonElement} */ (document.getElementById("new"));
	const status = /** @type {HTMLElement} */ (document.getElementById("status"));
	/** @type {Map<string, HTMLElement>} */
	const tools = new Map();
	let usage = { inputTokens: 0, outputTokens: 0 };
	let startedAt = 0;

	const el = (tag, cls, text) => {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = text;
		return node;
	};

	const add = (node) => {
		timeline.querySelector(".empty")?.remove();
		timeline.appendChild(node);
		timeline.scrollTop = timeline.scrollHeight;
	};

	const setRunning = (running) => {
		runBtn.disabled = running;
		stopBtn.disabled = !running;
		task.disabled = running;
	};

	const setStatus = (text) => {
		const tokens = usage.inputTokens + usage.outputTokens > 0 ? ` | tokens in ${usage.inputTokens}, out ${usage.outputTokens}` : "";
		status.textContent = text + tokens;
	};

	const describeInput = (name, input) => {
		if (!input || typeof input !== "object") return "";
		const p = input.path ?? input.pattern ?? "";
		if (name === "read_file" && input.start_line) return `${p} (${input.start_line}-${input.end_line ?? "end"})`;
		if (name === "edit_file" && Array.isArray(input.edits)) return `${p} (${input.edits.length} edit(s))`;
		return String(p);
	};

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		const text = task.value.trim();
		if (!text) return;
		vscode.postMessage({ type: "run", task: text });
		task.value = "";
	});
	task.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
	});
	stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
	newBtn.addEventListener("click", () => vscode.postMessage({ type: "new" }));

	window.addEventListener("message", (event) => {
		const msg = event.data;
		switch (msg.type) {
			case "reset":
				timeline.innerHTML = '<p class="empty">No runs yet. Describe a change below.</p>';
				tools.clear();
				usage = { inputTokens: 0, outputTokens: 0 };
				setRunning(false);
				setStatus("Idle");
				break;
			case "run-started": {
				startedAt = Date.now();
				const card = el("div", "step task");
				card.appendChild(el("div", "label", "Task"));
				card.appendChild(el("div", "body", msg.task));
				add(card);
				setRunning(true);
				setStatus("Running...");
				break;
			}
			case "assistant-text": {
				const card = el("div", "step assistant");
				card.appendChild(el("div", "label", `Agent - step ${msg.iteration}`));
				card.appendChild(el("div", "body", msg.text));
				add(card);
				break;
			}
			case "tool-started": {
				const card = el("details", "step tool running");
				const summary = el("summary");
				summary.appendChild(el("span", "badge", "running"));
				summary.appendChild(el("span", "tool-name", msg.name));
				summary.appendChild(el("span", "tool-arg", describeInput(msg.name, msg.input)));
				card.appendChild(summary);
				card.appendChild(el("pre", "input", JSON.stringify(msg.input, null, 2)));
				tools.set(msg.id, card);
				add(card);
				break;
			}
			case "tool-finished": {
				const card = tools.get(msg.id);
				if (!card) break;
				card.classList.remove("running");
				card.classList.add(msg.ok ? "ok" : "error");
				const badge = card.querySelector(".badge");
				if (badge) badge.textContent = `${msg.ok ? "ok" : "error"} ${msg.durationMs}ms`;
				card.appendChild(el("pre", "output", msg.output));
				break;
			}
			case "file-changed":
				add(el("div", "step file", `${msg.kind === "created" ? "Created" : "Modified"} ${msg.path}`));
				break;
			case "usage":
				usage = { inputTokens: msg.inputTokens, outputTokens: msg.outputTokens };
				setStatus("Running...");
				break;
			case "run-finished": {
				const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
				const card = el("div", "step done");
				card.appendChild(el("div", "label", `Finished (${msg.status}) in ${secs}s, ${msg.iterations} step(s)`));
				if (msg.text) card.appendChild(el("div", "body", msg.text));
				add(card);
				setRunning(false);
				setStatus(`Done (${msg.status})`);
				break;
			}
			case "run-failed": {
				const card = el("div", "step failed");
				card.appendChild(el("div", "label", "Run failed"));
				card.appendChild(el("div", "body", msg.error));
				add(card);
				setRunning(false);
				setStatus("Failed");
				break;
			}
		}
	});
})();
