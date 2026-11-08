"use client";

import { KeyRound, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Empty } from "@/components/Empty";
import { Modal } from "@/components/Modal";
import { Skeleton } from "@/components/Skeleton";
import { apiFetch, useUser } from "@/lib/api";

interface ApiKeyInfo {
	id: string;
	label: string;
	masked: string;
	createdAt: string;
	lastUsedAt: string | null;
}

export default function KeysPage() {
	const user = useUser();
	const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [newKey, setNewKey] = useState("");
	const [revoking, setRevoking] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!user) return;
		const res = await apiFetch("/api/keys", user);
		if (res.ok) setKeys(((await res.json()) as { keys: ApiKeyInfo[] }).keys);
		setLoading(false);
	}, [user]);

	useEffect(() => {
		void load();
	}, [load]);

	const create = async () => {
		if (!user) return;
		const res = await apiFetch("/api/keys", user, { method: "POST", body: JSON.stringify({ label: "manual" }) });
		if (res.ok) {
			setNewKey(((await res.json()) as { key: string }).key);
			void load();
		}
	};

	const revoke = async (id: string) => {
		if (!user) return;
		await apiFetch(`/api/keys?id=${id}`, user, { method: "DELETE" });
		setRevoking(null);
		void load();
	};

	return (
		<>
			<div className="section-head" style={{ marginTop: 0 }}>
				<div>
					<h1>API Keys</h1>
					<p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
						Connect the Kronyx extension to your account. Keys are stored hashed and shown once.
					</p>
				</div>
				<button className="btn" onClick={() => void create()}>
					<Plus size={14} />
					New key
				</button>
			</div>

			<div className="card table-card">
				{loading ? (
					<div style={{ padding: 16 }}>
						<Skeleton height={40} />
						<Skeleton height={40} />
					</div>
				) : (
					<table>
						<thead>
							<tr>
								<th>Key</th>
								<th>Label</th>
								<th>Created</th>
								<th>Last used</th>
								<th className="num"></th>
							</tr>
						</thead>
						<tbody>
							{keys.map((k) => (
								<tr key={k.id}>
									<td className="mono" style={{ fontSize: 12 }}>
										{k.masked}
									</td>
									<td className="muted">{k.label || "—"}</td>
									<td className="muted">{new Date(k.createdAt).toLocaleDateString()}</td>
									<td className="muted">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}</td>
									<td className="num">
										<button className="btn danger sm" onClick={() => setRevoking(k.id)}>
											Revoke
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{keys.length === 0 && !loading && (
					<Empty>
						<KeyRound size={18} style={{ display: "block", margin: "0 auto 8px", opacity: 0.5 }} />
						No keys yet —{" "}
						<Link href="/connect" style={{ color: "var(--accent)" }}>
							connect your editor
						</Link>{" "}
						to create one automatically.
					</Empty>
				)}
			</div>

			{newKey && (
				<Modal title="API key created" onClose={() => setNewKey("")}>
					<p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
						Copy it now — it won&apos;t be shown again.
					</p>
					<div className="key-reveal">{newKey}</div>
					<div className="actions">
						<CopyButton text={newKey} />
						<button className="btn" onClick={() => setNewKey("")}>
							Done
						</button>
					</div>
				</Modal>
			)}

			{revoking && (
				<Modal title="Revoke key" onClose={() => setRevoking(null)}>
					<p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
						Any extension using this key will stop syncing immediately. This can&apos;t be undone.
					</p>
					<div className="actions">
						<button className="btn ghost" onClick={() => setRevoking(null)}>
							Cancel
						</button>
						<button className="btn danger" onClick={() => void revoke(revoking)}>
							Revoke
						</button>
					</div>
				</Modal>
			)}
		</>
	);
}
