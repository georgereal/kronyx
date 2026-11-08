import type { ReactNode } from "react";

export function Stat({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon?: ReactNode }) {
	return (
		<div className="card stat">
			<div className="label">
				{icon}
				{label}
			</div>
			<div className="value">{value}</div>
			{sub && <div className="sub">{sub}</div>}
		</div>
	);
}
