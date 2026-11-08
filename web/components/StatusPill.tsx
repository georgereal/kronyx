export function StatusPill({ status }: { status: string }) {
	const ok = status === "ok";
	return <span className={`pill ${ok ? "ok" : "err"}`}>{ok ? "200" : status}</span>;
}
