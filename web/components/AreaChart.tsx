"use client";

import { useEffect, useRef } from "react";

const ACCENT = "#5b8cff";
const MUTED = "#8b8b93";

export interface Bucket {
	t: number;
	value: number;
}

export interface ChartSeries {
	label: string;
	color: string;
	buckets: Bucket[];
	/** Thinner stroke — for subset metrics like reasoning-inside-output. */
	thin?: boolean;
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

/** Like bucketize but produces one aligned series per extractor in a single pass. */
export function bucketizeSeries<T>(items: T[], at: (t: T) => number, extractors: ((t: T) => number)[], buckets = 48): Bucket[][] {
	if (items.length === 0) return extractors.map(() => []);
	const times = items.map(at);
	const min = Math.min(...times);
	const max = Math.max(...times, min + 1);
	const span = max - min;
	const out: Bucket[][] = extractors.map(() =>
		Array.from({ length: buckets }, (_, i) => ({
			t: min + (span * (i + 0.5)) / buckets,
			value: 0,
		})),
	);
	for (const item of items) {
		const i = Math.min(buckets - 1, Math.floor(((at(item) - min) / span) * buckets));
		extractors.forEach((extract, s) => {
			out[s][i].value += extract(item);
		});
	}
	return out;
}

export const fmtTok = (n: number) =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

const hexToRgba = (hex: string, alpha: number) => {
	const n = parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

/** Smooth line chart supporting multiple aligned series with shared axes. */
export function MultiLineChart({ series, height = 180 }: { series: ChartSeries[]; height?: number }) {
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
		const visible = series.filter((s) => s.buckets.length > 0);
		if (visible.length === 0) return;

		const padTop = 14;
		const padBottom = 20;
		const plotH = h - padTop - padBottom;
		const peak = Math.max(...visible.flatMap((s) => s.buckets.map((b) => b.value)), 1);
		const x = (i: number, len: number) => (i / Math.max(len - 1, 1)) * w;
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

		const linePath = (buckets: Bucket[]) => {
			ctx.beginPath();
			ctx.moveTo(x(0, buckets.length), y(buckets[0].value));
			for (let i = 1; i < buckets.length; i++) {
				const xc = (x(i - 1, buckets.length) + x(i, buckets.length)) / 2;
				const yc = (y(buckets[i - 1].value) + y(buckets[i].value)) / 2;
				ctx.quadraticCurveTo(x(i - 1, buckets.length), y(buckets[i - 1].value), xc, yc);
			}
			ctx.lineTo(x(buckets.length - 1, buckets.length), y(buckets[buckets.length - 1].value));
		};

		for (const s of visible) {
			const fill = visible.length === 1 ? 0.3 : 0.12;
			linePath(s.buckets);
			ctx.lineTo(x(s.buckets.length - 1, s.buckets.length), h - padBottom);
			ctx.lineTo(x(0, s.buckets.length), h - padBottom);
			ctx.closePath();
			const grad = ctx.createLinearGradient(0, padTop, 0, h - padBottom);
			grad.addColorStop(0, hexToRgba(s.color, fill));
			grad.addColorStop(1, hexToRgba(s.color, 0));
			ctx.fillStyle = grad;
			ctx.fill();

			linePath(s.buckets);
			ctx.strokeStyle = s.color;
			ctx.lineWidth = s.thin ? 1 : 1.5;
			ctx.stroke();
		}

		// Time axis labels (first / mid / last) — all series share the same slots.
		ctx.fillStyle = MUTED;
		ctx.font = "10px ui-monospace, Menlo, monospace";
		const fmt = (t: number) =>
			new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
		const axis = visible[0].buckets;
		const first = axis[0].t;
		const last = axis[axis.length - 1].t;
		ctx.textAlign = "left";
		ctx.fillText(fmt(first), 2, h - 6);
		ctx.textAlign = "center";
		ctx.fillText(fmt((first + last) / 2), w / 2, h - 6);
		ctx.textAlign = "right";
		ctx.fillText(fmt(last), w - 2, h - 6);
		ctx.fillText(`peak ${fmtTok(peak)}`, w - 2, padTop - 4 + 8);
	}, [series]);

	return <canvas ref={ref} className="chart" style={{ height }} />;
}

/** Smooth area chart (Vercel-style): single-series convenience wrapper. */
export function AreaChart({ buckets, height = 180 }: { buckets: Bucket[]; height?: number }) {
	return <MultiLineChart series={[{ label: "", color: ACCENT, buckets }]} height={height} />;
}
