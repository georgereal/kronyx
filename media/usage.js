// @ts-check
(() => {
	const vscode = acquireVsCodeApi();
	const rowsEl = document.getElementById("rows");
	const emptyEl = document.getElementById("empty");
	const totalsEl = document.getElementById("totals");
	const chart = document.getElementById("chart");
	const rangeEl = document.getElementById("range");
	const modelEl = document.getElementById("model");
	const statusEl = document.getElementById("status");
	const viewEl = document.getElementById("view");
	const callsTable = document.querySelector("table");
	const ideTable = document.getElementById("ideTable");
	const ideRowsEl = document.getElementById("ideRows");
	const storeView = document.getElementById("storeView");
	const storeRowsEl = document.getElementById("storeRows");
	const syncStatusEl = document.getElementById("syncStatus");
	const flushBtn = document.getElementById("flush");
	let calls = [];
	let ideEvents = [];
	let sync = { status: undefined, tables: [] };

	const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
	const fmtCost = (c) => (c === null || c === undefined ? "—" : c === 0 ? "$0" : `$${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`);
	const fmtDur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
	const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

	function query() {
		const filter = { status: statusEl.value || undefined, model: modelEl.value || undefined };
		const range = Number(rangeEl.value);
		if (range > 0) filter.since = Date.now() - range;
		vscode.postMessage({ type: "query", filter });
	}

	function render() {
		rowsEl.innerHTML = calls
			.map((c) => {
				const t = new Date(Number(c.at));
				const when = `${t.toLocaleDateString(undefined, { month: "short", day: "2-digit" }).toUpperCase()} ${t.toLocaleTimeString()}`;
				const ok = c.status === "ok";
				const provider = c.base_url ? new URL(String(c.base_url)).hostname.replace(/^www\./, "") : c.provider || "";
				return `<tr>
					<td class="time">${esc(when)}</td>
					<td class="status ${ok ? "ok" : "err"}">${esc(c.status === "ok" ? "200" : c.status)}</td>
					<td class="model">${esc(c.model)}</td>
					<td class="provider">${esc(provider)}</td>
					<td class="num">${fmtTok(Number(c.tokens_in))} input · ${fmtTok(Number(c.tokens_out))} output</td>
					<td class="num">${fmtCost(c.cost_usd)}</td>
					<td class="num">${fmtDur(Number(c.duration_ms))}</td>
					<td>${Number(c.synced) ? `<span class="pill ok" title="Uploaded to the dashboard">synced</span>` : `<span class="pill warn" title="Queued locally — uploads on the next flush">pending</span>`}</td>
					<td class="key">${esc(c.key_label)}</td>
				</tr>`;
			})
			.join("");
		emptyEl.hidden = calls.length > 0 || viewEl.value !== "calls";
		emptyEl.textContent = "No API calls recorded yet. Run a task to see per-request usage.";
		const tin = calls.reduce((s, c) => s + Number(c.tokens_in), 0);
		const tout = calls.reduce((s, c) => s + Number(c.tokens_out), 0);
		const known = calls.filter((c) => c.cost_usd !== null && c.cost_usd !== undefined);
		const cost = known.reduce((s, c) => s + Number(c.cost_usd), 0);
		totalsEl.textContent = `${calls.length} request${calls.length === 1 ? "" : "s"} · ${fmtTok(tin)} in · ${fmtTok(tout)} out${known.length ? ` · ${fmtCost(cost)} est.` : ""}`;
		renderIde();
		drawChart();
	}

	function ideDetail(d) {
		const p = [];
		if (d.file) p.push(d.file);
		if (d.query) p.push(`"${d.query}"`);
		if (d.direction) p.push(d.direction);
		if (d.newName) p.push(`→ ${d.newName}`);
		if (d.results != null) p.push(`${d.results} result${d.results === 1 ? "" : "s"}`);
		if (d.defs != null) p.push(`${d.defs} def`);
		if (d.refs != null) p.push(`${d.refs} ref${d.refs === 1 ? "" : "s"}`);
		if (d.impls != null) p.push(`${d.impls} impl`);
		if (d.files != null) p.push(`${d.files} file${d.files === 1 ? "" : "s"}`);
		if (d.edits != null) p.push(`${d.edits} edit${d.edits === 1 ? "" : "s"}`);
		if (d.before && d.after) {
			const dErr = d.after.errors - d.before.errors;
			const dWarn = d.after.warnings - d.before.warnings;
			p.push(`errors ${dErr >= 0 ? "+" : ""}${dErr} · warnings ${dWarn >= 0 ? "+" : ""}${dWarn}`);
		}
		if (d.tookMs != null) p.push(`${d.tookMs}ms`);
		return p.join(" · ") || "—";
	}

	function renderIde() {
		const parsed = ideEvents.map((e) => {
			let d = {};
			try { d = JSON.parse(e.detail || "{}"); } catch { /* keep */ }
			return { e, d };
		});
		ideRowsEl.innerHTML = parsed
			.map(({ e, d }) => {
				const t = new Date(Number(e.at));
				const when = `${t.toLocaleDateString(undefined, { month: "short", day: "2-digit" }).toUpperCase()} ${t.toLocaleTimeString()}`;
				const det = ideDetail(d);
				return `<tr>
					<td class="time">${esc(when)}</td>
					<td class="model">${esc(d.tool || e.op || "")}</td>
					<td class="provider" title="${esc(det)}">${esc(det)}</td>
					<td class="key">${esc(e.session || "")}</td>
				</tr>`;
			})
			.join("");
		if (viewEl.value === "ide") {
			emptyEl.hidden = parsed.length > 0;
			emptyEl.textContent = "No IDE tool events yet — symbol/diagnostic calls from the agent appear here.";
			const perTool = {};
			for (const { e, d } of parsed) {
				const t = d.tool || e.op || "?";
				perTool[t] = (perTool[t] || 0) + 1;
			}
			totalsEl.textContent = `${parsed.length} event${parsed.length === 1 ? "" : "s"} · ` +
				Object.entries(perTool).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}: ${n}`).join(" · ");
		}
	}

	function applyView() {
		const view = viewEl.value;
		const store = view === "store";
		callsTable.hidden = view !== "calls";
		ideTable.hidden = view !== "ide";
		storeView.hidden = !store;
		chart.hidden = view !== "calls";
		modelEl.hidden = view !== "calls";
		statusEl.hidden = view !== "calls";
		rangeEl.hidden = store;
		emptyEl.hidden = store || emptyEl.hidden;
		if (store) {
			renderStore();
			totalsEl.textContent = "";
		} else {
			render();
		}
	}

	const TABLE_LABELS = {
		api_calls: "API calls",
		runs: "Runs",
		session_events: "Run events",
		prs: "Pull requests",
		sandboxes: "Sandbox events",
		memory_events: "Memory events",
	};

	function renderStore() {
		const s = sync.status;
		if (!s) {
			syncStatusEl.textContent = "Sync worker not running.";
		} else {
			const parts = [];
			parts.push(`<span class="pill ${s.enabled ? "ok" : "err"}">${s.enabled ? "sync on" : "sync off"}</span>`);
			parts.push(`<span class="pill ${s.signedIn ? "ok" : "err"}">${s.signedIn ? "signed in" : "signed out"}</span>`);
			parts.push(s.endpoint ? `endpoint ${esc(new URL(s.endpoint).hostname)}` : "no web endpoint configured");
			if (s.lastOkAt) parts.push(`last upload ${new Date(s.lastOkAt).toLocaleTimeString()} (${esc(s.lastUploaded)})`);
			else parts.push("no upload yet this session");
			if (s.lastError) parts.push(`<span class="pill err">${esc(s.lastError)}</span>`);
			if (s.pausedUntil && s.pausedUntil > Date.now() && s.pausedUntil < Number.MAX_SAFE_INTEGER)
				parts.push(`next attempt ${new Date(s.pausedUntil).toLocaleTimeString()}`);
			if (s.pausedUntil === Number.MAX_SAFE_INTEGER) parts.push("paused — sign in to resume");
			if (s.flushing) parts.push("flushing…");
			syncStatusEl.innerHTML = parts.join(" &nbsp;·&nbsp; ");
		}
		storeRowsEl.innerHTML = sync.tables
			.map((t) => {
				const when = t.lastAt ? new Date(t.lastAt).toLocaleString() : "—";
				return `<tr>
					<td>${esc(TABLE_LABELS[t.table] || t.table)}</td>
					<td class="num">${t.total}</td>
					<td class="num">${t.pending ? `<b>${t.pending}</b>` : "0"}</td>
					<td class="num">${t.stuck ? `<span class="pill err">${t.stuck}</span>` : "0"}</td>
					<td class="time">${esc(when)}</td>
				</tr>`;
			})
			.join("");
	}

	flushBtn.addEventListener("click", () => {
		flushBtn.disabled = true;
		vscode.postMessage({ type: "flushNow" });
	});

	function drawChart() {
		const ctx = chart.getContext("2d");
		const dpr = window.devicePixelRatio || 1;
		const w = chart.clientWidth;
		const h = chart.clientHeight;
		chart.width = w * dpr;
		chart.height = h * dpr;
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, w, h);
		if (calls.length === 0) return;
		// Bucket token volume (in+out) across the visible range.
		const times = calls.map((c) => Number(c.at));
		const min = Math.min(...times);
		const max = Math.max(...times, min + 1);
		const buckets = 60;
		const span = max - min;
		const counts = new Array(buckets).fill(0);
		for (const c of calls) {
			const i = Math.min(buckets - 1, Math.floor(((Number(c.at) - min) / span) * buckets));
			counts[i] += Number(c.tokens_in) + Number(c.tokens_out);
		}
		const peak = Math.max(...counts, 1);
		const bw = w / buckets;
		for (let i = 0; i < buckets; i++) {
			if (!counts[i]) continue;
			const bh = Math.max(2, (counts[i] / peak) * (h - 4));
			ctx.fillStyle = "#4f8ef7";
			ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
		}
	}

	rangeEl.addEventListener("change", query);
	viewEl.addEventListener("change", applyView);
	modelEl.addEventListener("change", query);
	statusEl.addEventListener("change", query);
	document.getElementById("refresh").addEventListener("click", query);
	document.getElementById("dashboard").addEventListener("click", () => vscode.postMessage({ type: "openDashboard" }));
	window.addEventListener("resize", drawChart);
	window.addEventListener("message", (e) => {
		const msg = e.data;
		if (msg.type === "noDashboard") {
			document.getElementById("dashboard").hidden = true;
			return;
		}
		if (msg.type === "sync") {
			sync = { status: msg.status, tables: msg.tables || [] };
			flushBtn.disabled = false;
			if (viewEl.value === "store") renderStore();
			return;
		}
		if (msg.type !== "calls") return;
		calls = msg.calls;
		ideEvents = msg.ideEvents || [];
		const current = modelEl.value;
		modelEl.innerHTML = '<option value="">All models</option>' + msg.models.map((m) => `<option${m === current ? " selected" : ""}>${esc(m)}</option>`).join("");
		render();
	});
	vscode.postMessage({ type: "ready" });
})();
