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
	let calls = [];

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
					<td class="key">${esc(c.key_label)}</td>
				</tr>`;
			})
			.join("");
		emptyEl.hidden = calls.length > 0;
		const tin = calls.reduce((s, c) => s + Number(c.tokens_in), 0);
		const tout = calls.reduce((s, c) => s + Number(c.tokens_out), 0);
		const known = calls.filter((c) => c.cost_usd !== null && c.cost_usd !== undefined);
		const cost = known.reduce((s, c) => s + Number(c.cost_usd), 0);
		totalsEl.textContent = `${calls.length} request${calls.length === 1 ? "" : "s"} · ${fmtTok(tin)} in · ${fmtTok(tout)} out${known.length ? ` · ${fmtCost(cost)} est.` : ""}`;
		drawChart();
	}

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
		if (msg.type !== "calls") return;
		calls = msg.calls;
		const current = modelEl.value;
		modelEl.innerHTML = '<option value="">All models</option>' + msg.models.map((m) => `<option${m === current ? " selected" : ""}>${esc(m)}</option>`).join("");
		render();
	});
	vscode.postMessage({ type: "ready" });
})();
