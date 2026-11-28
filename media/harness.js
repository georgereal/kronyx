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
	const exportBtn = /** @type {HTMLButtonElement} */ (document.getElementById("export"));
	const liveEl = /** @type {HTMLElement} */ (document.getElementById("live"));

	let sessions = [];
	/** @type {any} */ let report = null;
	let runId = "";
	let lastTab = "plan";
	let traceFilter = "all";
	let traceSearch = "";
	let rawLines = /** @type {string[] | null} */ (null);
	let rawSession = "";
	let analyticsData = /** @type {any} */ (null);
	let rawTypeFilter = "";
	let rawRequestedFor = "";
	let rawSearch = "";
	let lastRenderKey = "";
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
		// Clear first — the poll re-renders everything.
		reportEl.innerHTML = "";
		reportEl.appendChild(buildDashboard(r));
	}

	// ---------- formatting helpers ----------
	const fmtDur = (/** @type {any} */ ms = undefined) => {
		if (ms === undefined || ms === null) return "—";
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
	};
	const fmtClock = (/** @type {any} */ at = undefined) => new Date(Number(at)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

	// ---------- info popover (shared for tasks/steps/divergences) ----------
	let openInfo = /** @type {HTMLElement | null} */ (null);
	const closeInfo = () => {
		openInfo?.remove();
		openInfo = null;
	};
	// The drawer is pinned — it closes via its ✕ or when another row opens a new one,
	// so you can scroll the main view and keep the detail in sight.
	document.addEventListener("click", (e) => {
		const t = e.target;
		if (t instanceof HTMLElement && t.classList.contains("run-callid") && t.dataset.callid) {
			void navigator.clipboard?.writeText(t.dataset.callid);
			const orig = t.textContent;
			t.textContent = "copied!";
			setTimeout(() => { t.textContent = orig; }, 800);
		}
	});

	const actorBadge = (/** @type {any} */ actor = undefined) => `<span class="actor ${esc(actor)}">${esc(actor)}</span>`;

	// ---------- correlation graph (static SVG) ----------
	/** Full-chain static flow per run: turn → tool call → execution → step, with the plan node beneath. */
	function correlationGraph(/** @type {any} */ opts = undefined) {
		const runs = (opts.runs || []).slice(0, 12);
		const turns = (report && report.turns) || [];
		const executions = (report && report.executions) || [];
		const plans = (report && report.plans) || [];
		const activePlan = plans.find((/** @type {any} */ p = undefined) => p.status === "active") ?? plans[plans.length - 1];
		const turnOf = (/** @type {any} */ callId = undefined) => turns.find((/** @type {any} */ t = undefined) => (t.toolCalls || []).some((/** @type {any} */ c = undefined) => c.callId === callId));
		const execOf = (/** @type {any} */ callId = undefined) => executions.find((/** @type {any} */ x = undefined) => x.callId === callId);
		const rowH = 52;
		const height = Math.max(150, runs.length * rowH + 96);
		const CX = { turn: 4, call: 110, exec: 216, step: 322 };
		const W = { turn: 98, call: 98, exec: 98, step: 92 };
		const stepY = Math.max(60, (runs.length * rowH) / 2 + 20);
		const node = (/** @type {any} */ x = undefined, /** @type {any} */ y = undefined, /** @type {any} */ w = undefined, /** @type {any} */ color = undefined, /** @type {any} */ fill = undefined, /** @type {any} */ line1 = undefined, /** @type {any} */ line2 = undefined) => [
			`<rect x="${x}" y="${y}" width="${w}" height="34" rx="5" fill="${fill}" stroke="${color}66"/>`,
			`<text x="${x + 7}" y="${y + 14}" fill="${color}" font-size="8.5" font-family="monospace">${esc(line1)}</text>`,
			`<text x="${x + 7}" y="${y + 26}" fill="#ccc" font-size="8.5">${esc(line2)}</text>`,
		].join("");
		const edge = (/** @type {any} */ x1 = undefined, /** @type {any} */ y1 = undefined, /** @type {any} */ x2 = undefined, /** @type {any} */ y2 = undefined, /** @type {any} */ color = undefined, /** @type {any} */ dash = undefined) =>
			`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.4"${dash ? ' stroke-dasharray="3,3"' : ""}/>`;
		const svg = [];
		svg.push(`<svg class="corr-svg" width="100%" height="${height}" viewBox="0 0 420 ${height}" xmlns="http://www.w3.org/2000/svg">`);
		// edges first
		runs.forEach((/** @type {any} */ r = undefined, /** @type {any} */ i = undefined) => {
			const y = 24 + i * rowH + 17;
			const color = r.ok === false ? "#f4877155" : "#569cd644";
			svg.push(edge(CX.turn + W.turn, y, CX.call, y, color));
			svg.push(edge(CX.call + W.call, y, CX.exec, y, color));
			svg.push(edge(CX.exec + W.exec, y, CX.step, stepY, color));
		});
		// chain nodes per run
		runs.forEach((/** @type {any} */ r = undefined, /** @type {any} */ i = undefined) => {
			const y = 24 + i * rowH;
			const turn = turnOf(r.callId);
			const exec = execOf(r.callId);
			const fail = r.ok === false;
			const color = fail ? "#f48771" : r.role === "close" ? "#e5c07b" : "#89d185";
			svg.push(node(CX.turn, y, W.turn, "#9cdcfe", "rgba(156,220,254,0.07)", turn ? `Turn ${turn.turn}` : "turn ?", turn ? `seq ${turn.seq}` : `seq ${r.seq}`));
			svg.push(node(CX.call, y, W.call, "#61afef", "rgba(97,175,239,0.08)", r.tool, String(r.target ?? "").slice(-14) || r.callId.slice(0, 10)));
			const exLine2 = exec ? `${exec.ok ? "ok" : "fail"}${exec.durationMs !== undefined ? ` · ${(exec.durationMs / 1000).toFixed(1)}s` : ""}${exec.exitCode !== undefined ? ` · exit ${exec.exitCode}` : ""}` : fail ? "refused" : "ok";
			svg.push(node(CX.exec, y, W.exec, color, fail ? "rgba(244,135,113,0.10)" : "rgba(137,209,133,0.07)", "execution", exLine2));
		});
		// step node
		svg.push(`<rect x="${CX.step}" y="${stepY - 20}" width="${W.step}" height="40" rx="6" fill="rgba(197,134,192,0.12)" stroke="#c586c0"/>`);
		svg.push(`<text x="${CX.step + W.step / 2}" y="${stepY - 4}" fill="#c586c0" font-size="10" text-anchor="middle" font-weight="bold">${esc(opts.title.split(" ")[0] ?? "step")}</text>`);
		svg.push(`<text x="${CX.step + W.step / 2}" y="${stepY + 10}" fill="#888" font-size="8" text-anchor="middle">${runs.length} run${runs.length === 1 ? "" : "s"}</text>`);
		// plan node beneath the step
		if (activePlan) {
			const planY = height - 40;
			const planLabel = `Plan ${activePlan.id.replace("p", "v")}`;
			svg.push(edge(CX.step + W.step / 2, stepY + 20, CX.step + W.step / 2, planY, "#c586c055", true));
			svg.push(`<rect x="${CX.step}" y="${planY}" width="${W.step}" height="28" rx="5" fill="rgba(78,201,176,0.08)" stroke="#4ec9b066"/>`);
			svg.push(`<text x="${CX.step + W.step / 2}" y="${planY + 12}" fill="#4ec9b0" font-size="8.5" text-anchor="middle">${esc(planLabel)}</text>`);
			svg.push(`<text x="${CX.step + W.step / 2}" y="${planY + 22}" fill="#888" font-size="7.5" text-anchor="middle">${activePlan.taskCount}t · ${activePlan.stepCount}s</text>`);
		}
		if (!runs.length) svg.push(`<text x="16" y="40" fill="#888" font-size="10">No correlated tool runs recorded for this step.</text>`);
		// legend
		svg.push(`<text x="8" y="${height - 6}" fill="#666" font-size="8">turn → tool call → execution → step${activePlan ? "   (dashed: plan membership)" : ""}</text>`);
		svg.push("</svg>");
		const wrap = document.createElement("div");
		wrap.className = "corr-wrap";
		wrap.innerHTML = svg.join("");
		return wrap;
	}

	// ---------- detail drawer (right-docked, tabbed) ----------
	function infoPanel(/** @type {any} */ anchor = undefined, /** @type {any} */ opts = undefined) {
		closeInfo();
		const panel = document.createElement("div");
		panel.className = "info-popover drawer";
		const life = `<div class="info-life">
			${opts.createdAt !== undefined ? `<span>created <b>${esc(fmtClock(opts.createdAt))}</b></span>` : ""}
			${opts.startedAt !== undefined ? `<span>started <b>${esc(fmtClock(opts.startedAt))}</b></span>` : ""}
			${opts.endedAt !== undefined ? `<span>ended <b>${esc(fmtClock(opts.endedAt))}</b></span>` : ""}
			${opts.durationMs !== undefined ? `<span>duration <b>${esc(fmtDur(opts.durationMs))}</b></span>` : ""}
		</div>`;
		const actions = (opts.actions || [])
			.map((/** @type {any} */ a = undefined) => `<div class="info-action">${actorBadge(a.actor)}<span class="info-label">${esc(a.label)}</span><span class="info-when">${esc(fmtClock(a.at))}</span>${a.detail ? `<div class="info-detail">${esc(a.detail)}</div>` : ""}</div>`)
			.join("");
		const ROLE_CHIP = { evidence: ["proof", "#89d185"], close: ["close attempt", "#e5c07b"], task: ["task", "#888"] };
		const runRow = (/** @type {any} */ r = undefined) => {
			const chip2 = r.role ? `<span class="run-role" style="color:${(ROLE_CHIP[/** @type {string} */ (r.role)] || [])[1] ?? "#888"};border-color:${(ROLE_CHIP[/** @type {string} */ (r.role)] || [])[1] ?? "#888"}">${(ROLE_CHIP[/** @type {string} */ (r.role)] || [])[0] ?? esc(r.role)}</span>` : "";
			const payload = r.input !== undefined || r.output !== undefined
				? `<details class="run-payload"><summary>input / output</summary>${r.input !== undefined ? `<div class="payload-label">input</div><pre class="payload-pre">${esc(r.input)}</pre>` : ""}${r.output !== undefined ? `<div class="payload-label">output</div><pre class="payload-pre">${esc(r.output || "(empty)")}</pre>` : ""}</details>`
				: "";
			return `<div class="info-action${r.ok ? "" : " run-failed"}">${chip2}<span class="mono run-tool">${esc(r.tool)}</span><span class="run-target">${esc(r.target)}</span><span class="info-when">${esc(fmtClock(r.at))}${r.durationMs !== undefined ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : ""}</span><span class="run-callid mono" title="${esc(r.callId)} — click to copy" data-callid="${esc(r.callId)}">${esc(r.callId.slice(0, 8))}</span>${r.error ? `<div class="info-detail run-error">${esc(r.error)}</div>` : ""}${payload}</div>`;
		};
		const runs = (opts.runs || []);
		const proofRuns = runs.filter((/** @type {any} */ r = undefined) => r.role === "evidence");
		const closeRuns = runs.filter((/** @type {any} */ r = undefined) => r.role === "close");

		const head = document.createElement("div");
		head.className = "drawer-head";
		head.innerHTML = `<div><div class="info-head">${esc(opts.title)}</div>${opts.meta ? `<div class="info-meta">${esc(opts.meta)}</div>` : ""}</div><button class="drawer-close" title="close">✕</button>`;
		head.querySelector(".drawer-close")?.addEventListener("click", () => closeInfo());
		panel.appendChild(head);

		const tabBar = document.createElement("div");
		tabBar.className = "drawer-tabs";
		const body = document.createElement("div");
		body.className = "drawer-body";
		const tabs = [];
		tabs.push(["overview", "Overview", () => {
			const el = document.createElement("div");
			el.innerHTML = `<div class="drawer-section">Lifecycle</div>${life}${actions ? `<div class="drawer-section">Actor actions</div><div class="info-actions">${actions}</div>` : '<div class="muted" style="padding:6px 0">No recorded actions.</div>'}`;
			return el;
		}]);
		if (runs.length) tabs.push(["execution", `Execution (${runs.length})`, () => {
			const el = document.createElement("div");
			el.innerHTML = `<div class="info-actions">${runs.map(runRow).join("")}</div>`;
			return el;
		}]);
		if (proofRuns.length || closeRuns.length) tabs.push(["evidence", "Evidence", () => {
			const el = document.createElement("div");
			el.innerHTML = `${proofRuns.length ? `<div class="drawer-section">Proof — counted toward closing (${proofRuns.length})</div><div class="info-actions">${proofRuns.map(runRow).join("")}</div>` : ""}${closeRuns.length ? `<div class="drawer-section">Close attempts (${closeRuns.length})</div><div class="info-actions">${closeRuns.map(runRow).join("")}</div>` : ""}`;
			return el;
		}]);
		tabs.push(["links", "Links", () => correlationGraph(opts)]);
		let activeTab = "";
		const selectTab = (/** @type {any} */ name = undefined) => {
			if (activeTab === name) return;
			activeTab = name;
			tabBar.querySelectorAll(".drawer-tab").forEach((t) => t.classList.toggle("active", t.getAttribute("data-dtab") === name));
			body.innerHTML = "";
			const tab = tabs.find((t) => t[0] === name);
			if (tab) body.appendChild(/** @type {any} */ (tab[2])());
		};
		for (const [name, label] of tabs.map((t) => [t[0], t[1]])) {
			const b = document.createElement("button");
			b.className = "drawer-tab";
			b.setAttribute("data-dtab", /** @type {any} */ (name));
			b.textContent = /** @type {any} */ (label);
			b.addEventListener("click", () => selectTab(name));
			tabBar.appendChild(b);
		}
		panel.appendChild(tabBar);
		panel.appendChild(body);
		document.body.appendChild(panel);
		openInfo = panel;
		selectTab("overview");
	}

	const infoBtn = (/** @type {any} */ opts = undefined) => {
		const btn = document.createElement("button");
		btn.className = "info-btn";
		btn.textContent = "ⓘ";
		btn.title = "lifecycle & actions";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			infoPanel(btn, opts);
		});
		return btn;
	};

	// ---------- dashboard shell ----------
	function buildDashboard(/** @type {any} */ r = undefined) {
		const root = document.createElement("div");
		root.className = "dash";
		root.appendChild(buildTiles(r));
		const tabs = [
			["plan", "Plan & Tasks"],
			["timeline", "Execution Trace"],
			["divergence", `Divergences (${r.summary?.divergences?.total ?? 0})`],
			["comparison", "Plan Comparison"],
			["artifacts", "Artifacts"],
			["context", "Context & Execution"],
			["raw", "Run Data"],
			["analytics", "Analytics"],
		];
		const bar = document.createElement("div");
		bar.className = "tab-bar";
		const body = document.createElement("div");
		body.className = "tab-body";
		const builders = /** @type {Record<string, (rep: any) => HTMLElement>} */ ({
			plan: buildPlanTab,
			timeline: buildTimelineTab,
			divergence: buildDivergenceTab,
			comparison: buildComparisonTab,
			artifacts: buildArtifactsTab,
			context: buildContextTab,
			raw: buildRawTab,
			analytics: buildAnalyticsTab,
		});
		let active = "";
		const select = (/** @type {any} */ name = undefined) => {
			if (name === active) return;
			active = name;
			lastTab = name;
			bar.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === name));
			body.innerHTML = "";
			body.appendChild(builders[name](r));
		};
		for (const [name, label] of tabs) {
			const t = document.createElement("button");
			t.className = "tab";
			t.setAttribute("data-tab", name);
			t.textContent = label;
			t.addEventListener("click", () => select(name));
			bar.appendChild(t);
		}
		root.appendChild(bar);
		root.appendChild(body);
		select(builders[lastTab] ? lastTab : "plan");
		return root;
	}

	function buildTiles(/** @type {any} */ r = undefined) {
		const s = r.summary || {};
		const el = document.createElement("div");
		el.className = "tiles-row";
		const tile = (/** @type {any} */ num = undefined, /** @type {any} */ lbl = undefined, /** @type {any} */ sub = undefined, /** @type {any} */ accent = undefined) =>
			`<div class="tile accent-${esc(accent)}"><div class="num">${esc(num)}</div><div class="lbl">${esc(lbl)}</div>${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ""}</div>`;
		el.innerHTML =
			tile(s.planVersions ?? 1, "Plan versions", undefined, "teal") +
			tile(s.tasks?.total ?? 0, "Tasks", `${s.tasks?.completed ?? 0} completed · ${s.tasks?.changed ?? 0} changed`, "green") +
			tile(s.steps?.total ?? 0, "Steps", `${s.steps?.completed ?? 0} completed · ${s.steps?.skipped ?? 0} skipped · ${s.steps?.replaced ?? 0} replaced`, "purple") +
			tile(s.toolRuns?.total ?? 0, "Tool runs", `${s.toolRuns?.succeeded ?? 0} succeeded · ${s.toolRuns?.retried ?? 0} retried`, "blue") +
			tile(s.divergences?.total ?? 0, "Divergences", `${s.divergences?.taskAdded ?? 0} new · ${s.divergences?.stepReplaced ?? 0} replaced · ${s.divergences?.unplanned ?? 0} unplanned`, "amber") +
			tile(fmtDur(s.durationMs), "Total duration", undefined, "slate");
		return el;
	}

	// ---------- Plan & Tasks tab ----------
	function buildPlanTab(/** @type {any} */ r = undefined) {
		const wrap = document.createElement("div");
		wrap.className = "plan-layout";
		const side = document.createElement("div");
		side.className = "plan-side";
		side.appendChild(buildEvolution(r));
		const main = document.createElement("div");
		main.className = "plan-main";
		main.appendChild(buildTaskTree(r));
		wrap.appendChild(side);
		wrap.appendChild(main);
		return wrap;
	}

	function buildEvolution(/** @type {any} */ r = undefined) {
		const box = document.createElement("div");
		box.className = "evo";
		const plans = r.plans || [];
		const head = document.createElement("h3");
		head.textContent = "Plan Evolution & Divergence";
		box.appendChild(head);
		if (!plans.length) {
			box.appendChild(Object.assign(document.createElement("div"), { className: "card muted", textContent: "No plan versions — conversational run." }));
			return box;
		}
		const flow = document.createElement("div");
		flow.className = "evo-flow vertical";
		const ordered = [...plans].reverse();
		ordered.forEach((/** @type {any} */ p = undefined, /** @type {any} */ i = undefined) => {
			if (i > 0) {
				const conn = document.createElement("div");
				conn.className = "evo-connector";
				flow.appendChild(conn);
			}
			const card = document.createElement("div");
			card.className = `evo-card ${p.status}`;
			const label = plans.length === 1 ? "Plan (Final)" : `Plan ${p.id.replace("p", "v")}${p.status === "active" ? " (Final)" : ""}`;
			const statusCls = p.status === "active" ? "success" : "muted";
			card.innerHTML = `<div class="evo-title-row"><div class="evo-title">${esc(label)}</div><span class="tl-chip ${statusCls === "success" ? "success" : "stepchip"}">${esc(p.status === "active" ? "Active" : "Superseded")}</span></div><div class="evo-when">${esc(fmtClock(p.createdAt))}</div><div class="evo-desc">${esc(p.label).slice(0, 80)}</div><div class="evo-counts">${p.taskCount} tasks · ${p.stepCount} steps</div>`;
			flow.appendChild(card);
		});
		box.appendChild(flow);
		const transitions = r.evolution?.transitions || [];
		if (transitions.length) {
			const last = transitions[transitions.length - 1];
			const sum = document.createElement("div");
			sum.className = "evo-summary";
			sum.innerHTML = `<b>Evolution summary</b> <span class="evo-chip retained">retained ${last.retained}</span> <span class="evo-chip modified">modified ${last.modified}</span> <span class="evo-chip added">added ${last.added}</span> <span class="evo-chip discarded">discarded ${last.discarded}</span> <span class="evo-chip">divergences ${r.summary?.divergences?.total ?? 0}</span>`;
			box.appendChild(sum);
		}
		return box;
	}

	const EVOLUTION_CHIP = /** @type {Record<string, string>} */ ({ retained: "Retained", modified: "Modified", added: "Added" });
	const STEP_MARK = /** @type {Record<string, string>} */ ({ done: "✓", in_progress: "◐", pending: "○", blocked: "✕", failed: "✕" });

	function buildTaskTree(/** @type {any} */ r = undefined) {
		const wrap = document.createElement("div");
		const head = document.createElement("h3");
		const activePlan = (r.plans || []).find((/** @type {any} */ p = undefined) => p.status === "active");
		head.textContent = activePlan ? `Plan ${activePlan.id.replace("p", "v")} — Tasks & Steps` : "Tasks & Steps";
		wrap.appendChild(head);
		const tasks = (r.board?.tasks || []).filter((/** @type {any} */ t = undefined) => t.origin !== "divergence");
		if (!tasks.length) {
			wrap.appendChild(Object.assign(document.createElement("div"), { className: "card muted", textContent: "No task board — conversational run." }));
			return wrap;
		}
		for (const t of tasks) {
			const card = document.createElement("div");
			card.className = `card task-card${t.status === "stale" ? " stale" : ""}`;
			const chip = t.evolutionClass ? `<span class="evo-chip ${esc(t.evolutionClass)}">${esc(EVOLUTION_CHIP[t.evolutionClass] ?? t.evolutionClass)}</span>` : "";
			const head2 = document.createElement("div");
			head2.className = "task-head";
			head2.innerHTML = `<span class="task-title">${esc(t.id)} · ${esc(t.title)}</span>${chip}<span class="task-dur">${esc(fmtDur(t.durationMs))}</span><span class="pill ${esc(t.status)}">${esc(t.status)}</span>`;
			head2.appendChild(infoBtn({ title: `${t.id} · ${t.title}`, meta: t.acceptance?.kind === "command" ? `acceptance: ${t.acceptance.command}` : `acceptance: ${t.acceptance?.kind}`, actions: t.actions, createdAt: undefined, startedAt: t.startedAt, endedAt: t.endedAt, durationMs: t.durationMs }));
			card.appendChild(head2);
			const meta = document.createElement("div");
			meta.className = "task-meta";
			meta.textContent = t.acceptance?.kind === "command" ? `acceptance: ${t.acceptance.command}` : `acceptance: ${t.acceptance?.kind ?? "?"}`;
			card.appendChild(meta);
			const ul = document.createElement("ul");
			ul.className = "steps";
			for (const s of t.steps || []) {
				const li = document.createElement("li");
				const replaced = s.replacedFrom ? `<span class="step-replaced" title="was: ${esc(s.replacedFrom.text)}">replaced</span>` : "";
				const closeBadge = s.closedBy ? `<span class="close-badge ${esc(s.closedBy)}">${esc(s.closedBy)}</span>` : "";
				li.innerHTML = `<span class="step-mark ${esc(s.status)}">${STEP_MARK[s.status] ?? "○"}</span><span class="step-text">${esc(s.text)}${s.signal ? `<span class="step-signal">on ${esc(s.signal.tool)}${s.signal.path ? ` ${esc(s.signal.path)}` : ""}</span>` : ""}${replaced}${closeBadge}</span><span class="step-runs">${s.toolRuns ? `${s.toolRuns} tool run${s.toolRuns === 1 ? "" : "s"}` : ""}</span><span class="step-dur">${esc(fmtDur(s.durationMs))}</span>`;
				const stepOpts = { title: `${t.id}/${s.id}`, meta: s.text, actions: s.actions, runs: s.runs, startedAt: s.startedAt, endedAt: s.endedAt, durationMs: s.durationMs };
				li.classList.add("step-clickable");
				li.addEventListener("click", (e) => {
					if (e.target instanceof HTMLElement && (e.target.classList.contains("info-btn") || e.target.classList.contains("run-callid"))) return;
					infoPanel(li, stepOpts);
				});
				li.appendChild(infoBtn(stepOpts));
				ul.appendChild(li);
			}
			card.appendChild(ul);
			if (t.dependsOn?.length) {
				const dep = document.createElement("div");
				dep.className = "depends";
				dep.textContent = `depends on ${t.dependsOn.join(", ")}`;
				card.appendChild(dep);
			}
			wrap.appendChild(card);
		}
		return wrap;
	}

	// ---------- Execution timeline tab ----------
	function buildTimelineTab(/** @type {any} */ r = undefined) {
		const wrap = document.createElement("div");
		const KINDS = [["all", "All"], ["turn", "Turns"], ["tool", "Tools"], ["step", "Steps"], ["lifecycle", "Lifecycle"], ["intervention", "Interventions"]];
		const bar = document.createElement("div");
		bar.className = "trace-bar";
		for (const [k, label] of KINDS) {
			const b = document.createElement("button");
			b.className = `evo-chip trace-filter${traceFilter === k ? " active" : ""}`;
			b.textContent = label;
			b.addEventListener("click", () => { traceFilter = k; lastRenderKey = ""; render(); });
			bar.appendChild(b);
		}
		const search = document.createElement("input");
		search.className = "trace-search";
		search.placeholder = "Search events…";
		search.value = traceSearch;
		search.addEventListener("input", () => { traceSearch = search.value; });
		search.addEventListener("keydown", (e) => { if (e.key === "Enter") { lastRenderKey = ""; render(); } });
		bar.appendChild(search);
		wrap.appendChild(bar);
		const allRows = r.timeline || [];
		const rows = allRows.filter((row) => {
			if (traceFilter !== "all" && row.kind !== traceFilter) return false;
			if (traceSearch) {
				const q = traceSearch.toLowerCase();
				if (!(row.label.toLowerCase().includes(q) || (row.detail ?? "").toLowerCase().includes(q))) return false;
			}
			return true;
		});
		const count = document.createElement("div");
		count.className = "omitted";
		count.textContent = `${rows.length} of ${allRows.length} events`;
		wrap.appendChild(count);
		if (!rows.length) {
			wrap.appendChild(Object.assign(document.createElement("div"), { className: "card muted", textContent: "No timeline rows." }));
			return wrap;
		}
		const list = document.createElement("div");
		list.className = "tl-rows";
		for (const row of rows) {
			const item = document.createElement("div");
			item.className = `tl-row kind-${esc(row.kind)}${row.ok === false ? " failed" : ""}`;
			let extra = "";
			if (row.reasoning) extra += `<details class="tl-expander reasoning"><summary>reasoning</summary><pre class="payload-pre reasoning-pre">${esc(row.reasoning)}</pre></details>`;
			if (row.text) extra += `<details class="tl-expander"><summary>reply text</summary><pre class="payload-pre">${esc(row.text)}</pre></details>`;
			if (row.input !== undefined || row.output !== undefined) {
				extra += `<details class="tl-expander"><summary>input / output</summary>${row.input !== undefined ? `<div class="payload-label">input</div><pre class="payload-pre">${esc(row.input)}</pre>` : ""}${row.output !== undefined ? `<div class="payload-label">output</div><pre class="payload-pre">${esc(row.output || "(empty)")}</pre>` : ""}</details>`;
			}
			const cid = row.callId ? `<span class="run-callid mono" title="${esc(row.callId)} — click to copy" data-callid="${esc(row.callId)}">${esc(row.callId.slice(0, 8))}</span>` : "";
			const statusChip = row.kind === "tool" ? `<span class="tl-chip ${row.ok === false ? "failed" : "success"}">${row.ok === false ? "Failed" : "Success"}</span>` : row.kind === "step" ? `<span class="tl-chip stepchip">${esc(row.detail?.includes("done") ? "Completed" : row.detail?.includes("in_progress") ? "Running" : "Updated")}</span>` : "";
			item.innerHTML = `<div class="tl-rowhead"><span class="tl-when">${esc(fmtClock(row.at))}</span><span class="tl-seq mono">${row.seq}</span><span class="tl-kind">${esc(row.kind)}</span><span class="tl-label">${esc(row.label)}</span>${statusChip}${row.detail ? `<span class="tl-detail2">${esc(row.detail).slice(0, 90)}</span>` : ""}${cid}</div>${extra}`;
			list.appendChild(item);
		}
		wrap.appendChild(list);
		if (r.timelineOmitted) {
			const om = document.createElement("div");
			om.className = "omitted";
			om.textContent = `…${r.timelineOmitted} later rows omitted from this report.`;
			wrap.appendChild(om);
		}
		return wrap;
	}

	// ---------- Divergences tab ----------
	function buildDivergenceTab(/** @type {any} */ r = undefined) {
		const wrap = document.createElement("div");
		wrap.className = "div-layout";
		const list = document.createElement("div");
		list.className = "div-list";
		const detail = document.createElement("div");
		detail.className = "div-detail";
		const episodes = r.divergence || [];
		if (!episodes.length) {
			wrap.appendChild(Object.assign(document.createElement("div"), { className: "card muted", textContent: "No divergences — the model stayed on the original plan." }));
			return wrap;
		}
		const KIND_LABEL = /** @type {Record<string, string>} */ ({ "unplanned-work": "Unplanned work", "step-replaced": "Step replaced", "task-added": "Added scope" });
		const showDetail = (/** @type {any} */ d = undefined) => {
			list.querySelectorAll(".div-row").forEach((x) => x.classList.toggle("active", x.getAttribute("data-id") === d.id));
			detail.innerHTML = "";
			const head = document.createElement("div");
			head.className = "div-detail-head";
			head.innerHTML = `<span class="div-kind ${esc(d.kind)}">${esc(KIND_LABEL[d.kind] ?? d.kind)}</span><span class="pill ${esc(d.status)}">${esc(d.status)}</span>`;
			detail.appendChild(head);
			const title = document.createElement("div");
			title.className = "div-title";
			title.textContent = d.title;
			detail.appendChild(title);
			if (d.replacement) {
				const viz = document.createElement("div");
				viz.className = "div-viz";
				viz.innerHTML = `<div class="viz-box before"><div class="viz-tag">before</div>${esc(d.replacement.wasText)}${d.replacement.wasSignal ? `<div class="viz-sig">${esc(d.replacement.wasSignal)}</div>` : ""}</div><div class="viz-arrow">→</div><div class="viz-box after"><div class="viz-tag">after</div>${esc(d.replacement.newText)}${d.replacement.newSignal ? `<div class="viz-sig">${esc(d.replacement.newSignal)}</div>` : ""}</div>`;
				detail.appendChild(viz);
			}
			if (d.cause) {
				const cause = document.createElement("div");
				cause.className = `cause-badge ${esc(d.cause)}`;
				cause.textContent = d.cause === "harness" ? "harness-triggered" : "model-initiated";
				if (d.causeDetail) cause.title = d.causeDetail;
				detail.appendChild(cause);
			}
			if (d.calls?.length) {
				const calls = document.createElement("div");
				calls.className = "proof-row";
				calls.innerHTML = d.calls.map((/** @type {any} */ c = undefined) => `<span class="proof-chip${c.ok ? "" : " failed"}">${esc(c.name)}${c.target ? ` <span class="proof-target">${esc(c.target)}</span>` : ""}</span>`).join("");
				detail.appendChild(calls);
			}
			const life = document.createElement("div");
			life.className = "div-life";
			life.innerHTML = `<b>Lifecycle</b>` + (d.lifecycle || []).map((/** @type {any} */ l = undefined) => `<div class="div-life-row"><span class="life-dot"></span><span class="life-label">${esc(l.label)}</span><span class="life-when">${esc(fmtClock(l.at))}</span></div>`).join("");
			detail.appendChild(life);
		};
		for (const d of episodes) {
			const row = document.createElement("div");
			row.className = "div-row";
			row.setAttribute("data-id", d.id);
			row.innerHTML = `<span class="div-kind ${esc(d.kind)}">${esc(KIND_LABEL[d.kind] ?? d.kind)}</span><span class="div-row-title">${esc(d.title).slice(0, 70)}</span><span class="div-when">${esc(fmtClock(d.startedAt))}</span>`;
			row.addEventListener("click", () => showDetail(d));
			list.appendChild(row);
		}
		wrap.appendChild(list);
		wrap.appendChild(detail);
		showDetail(episodes[episodes.length - 1]);
		return wrap;
	}

	// ---------- Plan comparison tab ----------
	function buildComparisonTab(/** @type {any} */ r = undefined) {
		const wrap = document.createElement("div");
		const plans = r.plans || [];
		if (plans.length < 2) {
			wrap.appendChild(Object.assign(document.createElement("div"), { className: "card muted", textContent: "Only one plan version — no replacements to compare." }));
			return wrap;
		}
		const transitions = r.evolution?.transitions || [];
		for (const tr of transitions) {
			const card = document.createElement("div");
			card.className = "card cmp-card";
			const pairRows = (tr.pairs || []).map((/** @type {any} */ p = undefined) => `<div class="cmp-pair ${esc(p.class)}"><div class="cmp-side"><span class="pair-class">${esc(p.class)}</span>${esc(p.oldTitle)}</div><div class="viz-arrow">→</div><div class="cmp-side${p.newId ? "" : " empty"}">${esc(p.newTitle ?? "(not carried over)")}</div></div>`).join("");
			const addedRows = (tr.addedTasks || []).map((/** @type {any} */ t = undefined) => `<div class="cmp-pair added"><div class="cmp-side empty"></div><div class="viz-arrow"></div><div class="cmp-side"><span class="pair-class">added</span>${esc(t.title)}</div></div>`).join("");
			card.innerHTML = `<div class="cmp-head">Plan ${esc(tr.from.replace("p", "v"))} → Plan ${esc(tr.to.replace("p", "v"))}</div>
				<div class="cmp-counts"><span class="evo-chip retained">retained ${tr.retained}</span><span class="evo-chip modified">modified ${tr.modified}</span><span class="evo-chip added">added ${tr.added}</span><span class="evo-chip discarded">discarded ${tr.discarded}</span></div>
				${pairRows || addedRows ? `<div class="cmp-pairs">${pairRows}${addedRows}</div>` : ""}`;
			wrap.appendChild(card);
		}
		const repls = r.evolution?.stepReplacements || [];
		if (repls.length) {
			const card = document.createElement("div");
			card.className = "card cmp-card";
			const rows = repls.map((/** @type {any} */ x = undefined) => `<div class="cmp-repl"><div class="cmp-step">${esc(x.taskId)}/${esc(x.stepId)}</div><div class="viz-box before">${esc(x.wasText)}</div><div class="viz-arrow">→</div><div class="viz-box after">${esc(x.newText)}</div></div>`).join("");
			card.innerHTML = `<div class="cmp-head">Step replacements across all versions</div><div class="cmp-repls">${rows}</div>`;
			wrap.appendChild(card);
		}
		return wrap;
	}

	// ---------- Artifacts tab ----------
	function buildArtifactsTab(/** @type {any} */ r = undefined) {
		const wrap = document.createElement("div");
		const rows = r.artifacts || [];
		if (!rows.length) {
			wrap.appendChild(Object.assign(document.createElement("div"), { className: "card muted", textContent: "No files written in this run." }));
			return wrap;
		}
		const table = document.createElement("table");
		table.innerHTML = `<thead><tr><th>File</th><th>Tools</th><th class="num">Writes</th><th>First</th><th>Last</th></tr></thead><tbody>${rows
			.map((/** @type {any} */ a = undefined) => `<tr><td class="mono">${esc(a.path)}</td><td>${esc(a.tools.join(", "))}</td><td class="num">${a.writes}</td><td>${esc(fmtClock(a.firstAt))}</td><td>${esc(fmtClock(a.lastAt))}</td></tr>`)
			.join("")}</tbody>`;
		wrap.appendChild(table);
		return wrap;
	}

	// ---------- Run Data tab — parsed JSONL straight from the local log ----------
	function buildRawTab(/** @type {any} */ r = undefined) {
		const wrap = document.createElement("div");
		const lines = rawSession === sessionEl.value ? rawLines : null;
		if (!lines) {
			// Auto-request on first open — the viewer should just be there.
			if (!rawRequestedFor || rawRequestedFor !== sessionEl.value) {
				rawRequestedFor = sessionEl.value;
				vscode.postMessage({ type: "rawEvents", session: sessionEl.value });
			}
			const note = document.createElement("div");
			note.className = "omitted";
			note.textContent = "Loading raw events from the session JSONL…";
			wrap.appendChild(note);
			return wrap;
		}
		const bar2 = document.createElement("div");
		bar2.className = "trace-bar";
		const filter = document.createElement("select");
		filter.className = "trace-search";
		filter.style.width = "170px";
		const types = [...new Set(lines.map((l) => { try { return JSON.parse(l).type; } catch { return "?"; } }))].sort();
		filter.innerHTML = `<option value="">All types (${lines.length})</option>` + types.map((t) => `<option${rawTypeFilter === t ? " selected" : ""}>${esc(t)}</option>`).join("");
		filter.addEventListener("change", () => { rawTypeFilter = filter.value; lastRenderKey = "x"; render(); lastRenderKey = ""; render(); });
		bar2.appendChild(filter);
		const search = document.createElement("input");
		search.className = "trace-search";
		search.placeholder = "Search event JSON…";
		search.value = rawSearch;
		search.addEventListener("keydown", (e) => { if (e.key === "Enter") { rawSearch = search.value; render(); } });
		bar2.appendChild(search);
		wrap.appendChild(bar2);
		let shown = 0;
		for (const line of lines) {
			let ev;
			try { ev = JSON.parse(line); } catch { continue; }
			if (rawTypeFilter && ev.type !== rawTypeFilter) continue;
			if (rawSearch && !line.toLowerCase().includes(rawSearch.toLowerCase())) continue;
			if (shown++ >= 300) continue;
			const det = document.createElement("details");
			det.className = "raw-event";
			const sum = document.createElement("summary");
			const label = ev.type === "model.response" ? `turn ${ev.turn}` : ev.type?.startsWith("tool.") ? `${ev.name ?? ""} ${String(ev.callId ?? "").slice(0, 12)}` : ev.type === "task.created" ? (ev.task?.title ?? "").slice(0, 50) : "";
			sum.innerHTML = `<span class="raw-seq mono">${ev.seq ?? ""}</span><span class="raw-type mono">${esc(ev.type ?? "?")}</span><span class="raw-label">${esc(label)}</span><span class="raw-when">${esc(fmtClock(ev.at))}</span>`;
			det.appendChild(sum);
			const pre = document.createElement("pre");
			pre.className = "payload-pre raw-pre";
			pre.textContent = JSON.stringify(ev, null, 2);
			det.appendChild(pre);
			wrap.appendChild(det);
		}
		const count = document.createElement("div");
		count.className = "omitted";
		count.textContent = `${shown} events shown${shown >= 300 ? " (first 300 — filter or search to narrow)" : ""}`;
		wrap.appendChild(count);
		return wrap;
	}

	// ---------- Analytics tab — cross-run harness health ----------
	function buildAnalyticsTab(/** @type {any} */ _r = undefined) {
		const wrap = document.createElement("div");
		if (!analyticsData) {
			const btn = document.createElement("button");
			btn.className = "tab";
			btn.textContent = "Build cross-run analytics";
			btn.addEventListener("click", () => {
				btn.textContent = "Scanning session logs…";
				vscode.postMessage({ type: "analytics" });
			});
			wrap.appendChild(btn);
			const note = document.createElement("div");
			note.className = "omitted";
			note.textContent = "Scans every session log under .kronyx/harness/ — divergence trends, friction ranked, steering frequency, read thrash.";
			wrap.appendChild(note);
			return wrap;
		}
		const a = analyticsData;
		const barRow = (count, max, color, label) => `<div class="fric-row"><span class="fric-count">${count}×</span><span class="fric-bar"><span class="fric-fill" style="width:${Math.round((count / Math.max(1, max)) * 100)}%;background:${color}"></span></span><span class="fric-label">${esc(label)}</span></div>`;
		const tiles = document.createElement("div");
		tiles.className = "tiles-row";
		tiles.innerHTML = `<div class="tile"><div class="num">${a.runs}</div><div class="lbl">sessions</div></div>
			<div class="tile"><div class="num">${a.divergences.total}</div><div class="lbl">divergences</div></div>
			<div class="tile"><div class="num">${a.divergences.harnessCaused}</div><div class="lbl">harness-caused</div></div>
			<div class="tile"><div class="num">${a.divergences.modelCaused}</div><div class="lbl">model-caused</div></div>
			<div class="tile"><div class="num">${(a.churn.avgVersions ?? 0).toFixed(1)}</div><div class="lbl">avg versions</div></div>
			<div class="tile"><div class="num">${a.churn.stepReplacements}</div><div class="lbl">step repls</div></div>`;
		wrap.appendChild(tiles);
		const fric = document.createElement("div");
		fric.innerHTML = `<h3>Harness friction — why the model couldn't close steps</h3>` +
			((a.friction || []).length ? a.friction.slice(0, 8).map((f) => barRow(f.count, a.friction[0]?.count ?? 1, "#e06c75", f.reason)).join("") : '<div class="card muted">No failed close attempts.</div>');
		wrap.appendChild(fric);
		const steer = document.createElement("div");
		steer.innerHTML = `<h3>Steering rules fired</h3>` +
			((a.steering || []).length ? a.steering.slice(0, 8).map((s) => barRow(s.count, a.steering[0]?.count ?? 1, "#c586c0", s.rule)).join("") : '<div class="card muted">No steering interventions.</div>');
		wrap.appendChild(steer);
		const reads = document.createElement("div");
		reads.innerHTML = `<h3>Repeat reads — file thrash across runs</h3>` +
			((a.repeatReads || []).length ? a.repeatReads.slice(0, 10).map((x) => barRow(x.reads, a.repeatReads[0]?.reads ?? 1, "#e5c07b", x.path)).join("") : '<div class="card muted">No significant thrash.</div>');
		wrap.appendChild(reads);
		const perRun = document.createElement("div");
		perRun.innerHTML = `<h3>Per-run breakdown</h3><table><thead><tr><th>Session</th><th class="num">Divs</th><th class="num">H/M</th><th class="num">Failed closes</th><th class="num">Versions</th><th class="num">Repeat reads</th></tr></thead><tbody>${(a.perRun || [])
			.map((x) => `<tr><td>${esc(x.session ?? "—")}</td><td class="num">${x.divergences.total}</td><td class="num">${x.divergences.harness}/${x.divergences.model}</td><td class="num">${x.failedCloses || ""}</td><td class="num">${x.planVersions}</td><td class="num">${x.repeatReads || ""}</td></tr>`)
			.join("")}</tbody></table>`;
		wrap.appendChild(perRun);
		return wrap;
	}

	// ---------- Context & execution tab (the classic stats) ----------
	function buildContextTab(/** @type {any} */ r = undefined) {
		const wrap = document.createElement("div");
		const c = r.context || {};
		const t = c.tokens || { input: 0, output: 0, cached: 0 };
		const srcv = c.bySource || { model: 0, planner: 0, tools: 0, recap: 0 };
		const total = srcv.model + srcv.planner + srcv.tools + srcv.recap || 1;
		const pct = (/** @type {any} */ n = undefined) => `${Math.round((n / total) * 100)}%`;
		const tiles = document.createElement("div");
		tiles.className = "tiles-row";
		tiles.innerHTML = `<div class="tile"><div class="num">${c.turns ?? 0}</div><div class="lbl">model turns</div></div>
			<div class="tile"><div class="num">${c.toolCalls ?? 0}</div><div class="lbl">tool calls</div></div>
			<div class="tile"><div class="num">${c.toolFailures ?? 0}</div><div class="lbl">failures</div></div>
			<div class="tile"><div class="num">${fmtTok(t.input)}</div><div class="lbl">tokens in</div></div>
			<div class="tile"><div class="num">${fmtTok(t.output)}</div><div class="lbl">tokens out</div></div>
			<div class="tile"><div class="num">${fmtTok(t.cached)}</div><div class="lbl">cached</div></div>`;
		wrap.appendChild(tiles);
		const turns = c.perTurn || [];
		if (turns.length) {
			const peak = Math.max(1, ...turns.map((/** @type {any} */ x = undefined) => x.input));
			const series = document.createElement("div");
			series.innerHTML = `<h3>Per-turn input tokens</h3><div class="turn-series">${turns.map((/** @type {any} */ x = undefined) => `<div class="turn-bar" style="height:${Math.max(2, Math.round((x.input / peak) * 28))}px" title="turn ${x.turn}: ${x.input.toLocaleString()} in / ${x.output.toLocaleString()} out"></div>`).join("")}</div>
			<div class="stat-row"><span class="muted">peak <b>${fmtTok(peak)}</b> · last <b>${fmtTok(turns[turns.length - 1].input)}</b> · run total ${fmtTok(t.input)}</span></div>`;
			wrap.appendChild(series);
		}
		const split = document.createElement("div");
		split.innerHTML = `<h3>Input attribution</h3><div class="split">
			<div class="s-model" style="width:${pct(srcv.model)}" title="model ${pct(srcv.model)}"></div>
			<div class="s-planner" style="width:${pct(srcv.planner)}" title="planner ${pct(srcv.planner)}"></div>
			<div class="s-tools" style="width:${pct(srcv.tools)}" title="tools ${pct(srcv.tools)}"></div>
			<div class="s-recap" style="width:${pct(srcv.recap)}" title="recap ${pct(srcv.recap)}"></div>
		</div>
		<div class="legend"><span class="s-model">model ${fmtTok(srcv.model)}</span><span class="s-planner">planner ${fmtTok(srcv.planner)}</span><span class="s-tools">tools ${fmtTok(srcv.tools)}</span><span class="s-recap">recap ${fmtTok(srcv.recap)}</span></div>
		<div class="stat-row" style="margin-top:8px"><span>recaps <b>${c.recaps ?? 0}</b></span><span>context clears <b>${c.clears ?? 0}</b></span><span>budget warnings <b>${c.budgetWarnings ?? 0}</b></span><span>finish refusals <b>${c.refusals ?? 0}</b></span></div>`;
		wrap.appendChild(split);
		// execution stats
		const e = r.execution || {};
		const toolsRows = (e.tools || []).map((/** @type {any} */ x = undefined) => `<tr><td class="mono">${esc(x.name)}</td><td class="num">${x.calls}</td><td class="num">${x.failures || ""}</td></tr>`).join("");
		const exec = document.createElement("div");
		exec.innerHTML = `<h3>Execution stats</h3><div class="stat-row" style="margin-bottom:8px">
			<span>steps proven by tool calls <b>${e.stepsSignalDone ?? 0}</b></span>
			<span>steps covered by acceptance <b>${e.stepsCoveredAtCloseout ?? 0}</b></span>
			<span>read-only turns <b>${e.exploreTurns ?? 0}</b></span>
			<span>max read streak <b>${e.maxReadOnlyStreak ?? 0}</b></span>
		</div>${toolsRows ? `<table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Failed</th></tr></thead><tbody>${toolsRows}</tbody></table>` : ""}`;
		wrap.appendChild(exec);
		// interventions folded in here as the harness-action record
		const items = (r.interventions || []).filter((/** @type {any} */ i = undefined) => !runId || i.runId === runId);
		const iv = document.createElement("div");
		iv.innerHTML = `<h3>Harness interventions</h3>` + (items.length
			? `<div class="tl">${items.map((/** @type {any} */ i = undefined) => `<div class="tl-item kind-${esc(i.kind)}"><span class="tl-kind">${esc(i.kind)}</span><span class="tl-label">${esc(i.label)}</span><span class="tl-when">${esc(fmtWhen(i.at))}</span>${i.detail ? `<div class="tl-detail">${esc(i.detail)}</div>` : ""}</div>`).join("")}</div>`
			: '<div class="card muted">The harness never had to intervene.</div>');
		wrap.appendChild(iv);
		return wrap;
	}

	sessionEl.addEventListener("change", () => {
		runId = "";
		rawLines = null;
		rawSession = "";
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
	exportBtn.addEventListener("click", () => {
		if (!sessionEl.value) {
			hintEl.textContent = "Pick a session first.";
			return;
		}
		hintEl.textContent = "Choose where to save the event log…";
		vscode.postMessage({ type: "export", session: sessionEl.value });
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
				const key = `${sessionEl.value}|${runId}|${msg.events ?? "?"}|${liveEl.hidden}`;
				if (key !== lastRenderKey) {
					lastRenderKey = key;
					closeInfo();
					render();
				}
				break;
			}
			case "error":
				hintEl.textContent = msg.text;
				break;
			case "queued":
				uploadBtn.disabled = false;
				hintEl.textContent = `Report for run ${msg.runId.slice(0, 8)}… queued — the sync worker uploads it to the dashboard on the next flush.`;
				break;
			case "exported":
				hintEl.textContent = `Event log exported → ${msg.path}`;
				break;
			case "rawEvents":
				rawLines = msg.lines || [];
				rawSession = msg.session || "";
				if (lastTab === "raw") { lastRenderKey = ""; render(); }
				break;
			case "analytics":
				analyticsData = msg.analytics;
				if (lastTab === "analytics") { lastRenderKey = ""; render(); }
				break;
		}
	});

	load();
})();
