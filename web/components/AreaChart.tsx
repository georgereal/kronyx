"use client";

import { useEffect, useRef } from "react";

const ACCENT = "#5b8cff";
const GRID = "rgba(31,31,35,0.9)";
const MUTED = "#8b8b93";

export interface Bucket {
	t: number;
	value: number;
}

/** Bucket items into N slots over [min,max], summing `value`. */
export function bucketize<T>(items: T[], at: (t: T) => number, value: (t: T) => number, buckets = 48): Bucket[] {
	if (items.length === 0) return [];
	const times = items.map(at);
	const min = Math.min(...times);
	const max = Math.max(...times, min + 1);
	const span = max - min;
	const out: Bucket[] = Array.from({ length: buckets }, (_, i) => ({
		t: min + (span * (i + 0.5)) / buckets,
		value: 0,
	}));
	for (const item of items) {
		const i = Math.min(buckets - 1, Math.floor(((at(item) - min) / span) * buckets));
		out[i].value += value(item);
	}
	return out;
}

export const fmtTok = (n: number) =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

/** Smooth area chart (Vercel-style): gradient fill under a smoothed line, grid lines, time axis. */
export function AreaChart({ buckets, height = 180 }: { buckets: Bucket[]; height?: number }) {
	const ref = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = ref.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, w, h);
		if (buckets.length === 0) return;

		const padTop = 14;
		const padBottom = 20;
		const plotH = h - padTop - padBottom;
		const peak = Math.max(...buckets.map((b) => b.value), 1);
		const x = (i: number) => (i / Math.max(buckets.length - 1, 1)) * w;
		const y = (v: number) => padTop + plotH - (v / peak) * plotH;

		// Horizontal grid lines (quarters)
		ctx.strokeStyle = "rgba(31,31,35,0.9)";
		ctx.lineWidth = 1;
		for (let g = 0; g <= 3; g++) {
			const gy = padTop + (plotH * g) / 3;
			ctx.beginPath();
			ctx.moveTo(0, gy);
			ctx.lineTo(w, gy);
			ctx.stroke();
		}

		const linePath = () => {
			ctx.beginPath();
			ctx.moveTo(x(0), y(buckets[0].value));
			for (let i = 1; i < buckets.length; i++) {
				const xc = (x(i - 1) + x(i)) / 2;
				const yc = (y(buckets[i - 1].value) + y(buckets[i].value)) / 2;
				ctx.quadraticCurveTo(x(i - 1), y(buckets[i - 1].value), xc, yc);
			}
			ctx.lineTo(x(buckets.length - 1), y(buckets[buckets.length - 1].value));
		};

		// Gradient fill under the line
		linePath();
		ctx.lineTo(x(buckets.length - 1), h - padBottom);
		ctx.lineTo(x(0), h - padBottom);
		ctx.closePath();
		const grad = ctx.createLinearGradient(0, padTop, 0, h - padBottom);
		grad.addColorStop(0, "rgba(91,140,255,0.30)");
		grad.addColorStop(1, "rgba(91,140,255,0)");
		ctx.fillStyle = grad;
		ctx.fill();

		// Stroke the line itself
		linePath();
		ctx.strokeStyle = ACCENT;
		ctx.lineWidth = 1.5;
		ctx.stroke();

		// Time axis labels (first / mid / last)
		ctx.fillStyle = MUTED;
		ctx.font = "10px ui-monospace, Menlo, monospace";
		const fmt = (t: number) =>
			new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
		const first = buckets[0].t;
		const last = buckets[buckets.length - 1].t;
		ctx.textAlign = "left";
		ctx.fillText(fmt(first), 2, h - 6);
		ctx.textAlign = "center";
		ctx.fillText(fmt((first + last) / 2), w / 2, h - 6);
		ctx.textAlign = "right";
		ctx.fillText(fmt(last), w - 2, h - 6);

		// Peak label
		ctx.fillText(`peak ${fmtTok(peak)}`, w - 2, padTop - 4 + 8);
		void GRID;
	}, [buckets]);

	return <canvas ref={ref} className="chart" style={{ height }} />;
}
