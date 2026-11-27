// @ts-check
(() => {
	// @ts-ignore acquireVsCodeApi is injected by VS Code
	const vscode = acquireVsCodeApi();
	const sessionEl = /** @type {HTMLSelectElement} */ (document.getElementById("session"));
	const runEl = /** @type {HTMLSelectElement} */ (document.getElementById("run"));
	const reportEl = /** @type {HTMLElement} */ (document.getElementById("report"));
	const hintEl = /** @type {HTMLElement} */ (document.getElementById("hint"));
	const refreshBtn = /** @type {HTMLButtonElement} */ (document.getElementById("refresh"));
	const uploadBtn = /** @type {HTMLButtonElement} */ (document.getElementById("upload"));
	const liveEl = /** @type {HTMLElement} */ (document.getElementById("live"));

	let sessions = [];
	/** @type {any} */ let report = null;
	let runId = "";
	/** @type {ReturnType<typeof setInterval> | null} */ let pollTimer = null;

	const esc = (/** @type {any} */ s = undefined) => String(s ?? "").replace(/[&<>"]/g, (c) => (/** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }))[c]);
	const fmtTok = (/** @type {any} */ n = undefined) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
	const fmtWhen = (/** @type {any} */ at = undefined) => new Date(Number(at)).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });

	function load() {
		stopPolling();
		sessions = [];
		report = null;
		runId = "";
		liveEl.hidden = true;
		sessionEl.innerHTML = '<option value="">Select a session…</option>';
		runEl.innerHTML = '<option value="">All runs</option>';
		reportEl.innerHTML = "";
		hintEl.textContent = "Loading sessions…";
		vscode.postMessage({ type: "list" });
	}

	function requestReport() {
		if (!sessionEl.value) return;
		vscode.postMessage({ type: "report", session: sessionEl.value, runId: runId || undefined });
	}

	function startPolling() {
		stopPolling();
		pollTimer = setInterval(requestReport, 2500);
	}

	function stopPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = null;
	}

	function render() {
		const r = report;
		if (!r) return;
		hintEl.textContent = "";
		runEl.innerHTML =
			'<option value="">All runs</option>' +
			(r.runs || []).map((/** @type {any} */ run = undefined) => `<option value="${esc(run.runId)}"${run.runId === runId ? " selected" : ""}>${esc(fmtWhen(run.startedAt))} · ${esc(run.status ?? "running")} · ${run.tasksCreated ?? 0} tasks · ${fmtTok(run.tokensIn)} tok</option>`).join("");
		renderBoard(r);
		renderInterventions(r);
		renderContext(r);
		renderExecution(r);
	}

	function renderBoard(/** @type {any} */ r = undefined) {
		const tasks = r.board?.tasks || [];
		const html = tasks.length
			? tasks
					.map((/** @type {any} */ t = undefined) => {
						const steps = (t.steps || [])
							.map((/** @type {any} */ s = undefined) => {
								const mark = /** @type {Record<string, string>} */ ({ done: "✓", in_progress: "◐", pending: "○", blocked: "✕" })[s.status] || "○";
								const ev = s.evidence?.length ? `<span class="step-ev">${s.evidence.length} call${s.evidence.length === 1 ? "" : "s"}</span>` : "";
								const sig = s.signal ? `<span class="step-signal">on ${esc(s.signal.tool)}${s.signal.path ? ` ${esc(s.signal.path)}` : ""}</span>` : "";
								return `<li><span class="step-mark ${esc(s.status)}">${mark}</span><span class="step-text">${esc(s.text)}${sig}${ev}</span></li>`;
							})
							.join("");
						const acc = t.acceptance?.kind === "command" ? `acceptance: <span class="mono">${esc(t.acceptance.command)}</span>` : `acceptance: ${esc(t.acceptance?.kind ?? "?")}`;
						const dep = t.dependsOn?.length ? `<div class="depends">depends on ${t.dependsOn.map(esc).join(", ")}</div>` : "";
						return `<div class="card"><div class="task-head"><span class="task-title">${esc(t.id)} · ${esc(t.title)}</span><span class="pill ${esc(t.status)}">${esc(t.status)}</span></div><div class="task-meta">${acc}</div><ul class="steps">${steps}</ul>${dep}</div>`;
					})
					.join("")
			: '<div class="card muted">No task board — conversational task, or the planner produced nothing for this run.</div>';
		section("Plan & board", html);
	}

	function renderInterventions(/** @type {any} */ r = undefined) {
		const items = (r.interventions || []).filter((/** @type {any} */ i = undefined) => !runId || i.runId === runId);
		const html = items.length
			? `<div class="tl">${items
					.map(
						(/** @type {any} */ i = undefined, /** @type {any} */ idx = undefined) => `<div class="tl-item kind-${esc(i.kind)}${idx === items.length - 1 ? " latest" : ""}"><span class="tl-kind">${esc(i.kind)}</span><span class="tl-label">${esc(i.label)}</span><span class="tl-when">${esc(fmtWhen(i.at))}</span>${i.detail ? `<div class="tl-detail">${esc(i.detail)}</div>` : ""}</div>`,
					)
					.join("")}</div>${r.interventionsOmitted ? `<div class="omitted">…and ${r.interventionsOmitted} earlier interventions omitted.</div>` : ""}`
			: '<div class="card muted">The harness never had to intervene — no steering notes, loop verdicts, or compactions.</div>';
		section("Harness interventions", html);
	}

	function renderContext(/** @type {any} */ r = undefined) {
		const c = r.context || {};
		const t = c.tokens || { input: 0, output: 0, cached: 0 };
		const src = c.bySource || { model: 0, planner: 0, tools: 0, recap: 0 };
		const total = src.model + src.planner + src.tools + src.recap || 1;
		const pct = (/** @type {any} */ n = undefined) => `${Math.round((n / total) * 100)}%`;
		const tiles = `<div class="tiles">
			<div class="tile"><div class="num">${c.turns ?? 0}</div><div class="lbl">model turns</div></div>
			<div class="tile"><div class="num">${c.toolCalls ?? 0}</div><div class="lbl">tool calls</div></div>
			<div class="tile"><div class="num">${c.toolFailures ?? 0}</div><div class="lbl">failures</div></div>
			<div class="tile"><div class="num">${fmtTok(t.input)}</div><div class="lbl">tokens in</div></div>
			<div class="tile"><div class="num">${fmtTok(t.output)}</div><div class="lbl">tokens out</div></div>
			<div class="tile"><div class="num">${fmtTok(t.cached)}</div><div class="lbl">cached</div></div>
			<div class="tile"><div class="num">${c.refusals ?? 0}</div><div class="lbl">finish refusals</div></div>
		</div>`;
		const split = `<div class="split">
			<div class="s-model" style="width:${pct(src.model)}" title="model ${pct(src.model)}"></div>
			<div class="s-planner" style="width:${pct(src.planner)}" title="planner ${pct(src.planner)}"></div>
			<div class="s-tools" style="width:${pct(src.tools)}" title="tools/subagents ${pct(src.tools)}"></div>
			<div class="s-recap" style="width:${pct(src.recap)}" title="recap ${pct(src.recap)}"></div>
		</div>
		<div class="legend">
			<span class="s-model">model ${fmtTok(src.model)}</span>
			<span class="s-planner">planner ${fmtTok(src.planner)}</span>
			<span class="s-tools">tools/subagents ${fmtTok(src.tools)}</span>
			<span class="s-recap">recap ${fmtTok(src.recap)}</span>
		</div>
		<div class="stat-row" style="margin-top:8px">
			<span>recaps <b>${c.recaps ?? 0}</b></span>
			<span>context clears <b>${c.clears ?? 0}</b></span>
			<span>budget warnings <b>${c.budgetWarnings ?? 0}</b></span>
		</div>`;
		section("Context & budget", tiles + split);
	}

	function renderExecution(/** @type {any} */ r = undefined) {
		const e = r.execution || {};
		const tools = (e.tools || [])
			.map((/** @type {any} */ t = undefined) => `<tr><td class="mono">${esc(t.name)}</td><td class="num">${t.calls}</td><td class="num">${t.failures || ""}</td></tr>`)
			.join("");
		const stats = `<div class="stat-row" style="margin-bottom:8px">
			<span>steps proven by tool calls <b>${e.stepsSignalDone ?? 0}</b></span>
			<span>steps covered by acceptance <b>${e.stepsCoveredAtCloseout ?? 0}</b></span>
			<span><span class="mono">read_file</span> <b>${e.readFileCalls ?? 0}</b></span>
			<span><span class="mono">read_files</span> <b>${e.readFilesCalls ?? 0}</b></span>
			<span><span class="mono">explore_codebase</span> <b>${e.exploreCalls ?? 0}</b></span>
			<span>read-only turns <b>${e.exploreTurns ?? 0}</b></span>
			<span>max read streak <b>${e.maxReadOnlyStreak ?? 0}</b></span>
		</div>`;
		const table = tools ? `<table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Failed</th></tr></thead><tbody>${tools}</tbody></table>` : '<div class="card muted">No tool calls.</div>';
		section("Execution stats", stats + table);
	}

	function section(/** @type {any} */ title = undefined, /** @type {any} */ html = undefined) {
		const el = document.createElement("section");
		el.innerHTML = `<h2>${esc(title)}</h2>${html}`;
		reportEl.appendChild(el);
	}

	sessionEl.addEventListener("change", () => {
		runId = "";
		if (!sessionEl.value) {
			stopPolling();
			liveEl.hidden = true;
			return;
		}
		hintEl.textContent = "Loading…";
		startPolling();
		requestReport();
	});
	runEl.addEventListener("change", () => {
		runId = runEl.value;
		if (!sessionEl.value) return;
		hintEl.textContent = "Loading…";
		requestReport();
	});
	refreshBtn.addEventListener("click", () => {
		if (sessionEl.value) requestReport();
		else load();
	});
	uploadBtn.addEventListener("click", () => {
		if (!runId) {
			hintEl.textContent = "Pick a specific run to upload (the dashboard keys reports by run).";
			return;
		}
		uploadBtn.disabled = true;
		vscode.postMessage({ type: "upload", session: sessionEl.value, runId });
		// host queues it into the local store; the sync worker uploads in batches
	});

	window.addEventListener("message", (event) => {
		const msg = event.data;
		switch (msg.type) {
			case "sessions": {
				sessions = msg.sessions || [];
				sessionEl.innerHTML = '<option value="">Select a session…</option>' + sessions.map((/** @type {any} */ s = undefined) => `<option value="${esc(s.name)}">${esc(s.name)} · ${esc(fmtWhen(s.at))}</option>`).join("");
				hintEl.textContent = sessions.length ? `${sessions.length} session log${sessions.length === 1 ? "" : "s"} under .kronyx/harness/ — tracking the newest.` : "No harness logs yet — run a task on the Harness engine first.";
				// Auto-select the newest session so the panel is live on open.
				if (sessions.length) {
					sessionEl.value = sessions[0].name;
					startPolling();
					requestReport();
				}
				break;
			}
			case "report": {
				report = msg.report;
				runId = msg.runId || "";
				liveEl.hidden = !(report?.runs || []).some((/** @type {any} */ run = undefined) => run.status === "running");
				render();
				break;
			}
			case "error":
				hintEl.textContent = msg.text;
				break;
			case "queued":
				uploadBtn.disabled = false;
				hintEl.textContent = `Report for run ${msg.runId.slice(0, 8)}… queued — the sync worker uploads it to the dashboard on the next flush.`;
				break;
		}
	});

	load();
})();
