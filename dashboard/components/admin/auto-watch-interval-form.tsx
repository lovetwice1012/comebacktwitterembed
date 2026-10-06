"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Policy = { userId: string; intervalMinutes: number | null; providers: Array<{ providerId: string; defaultMinutes: number; intervalMinutes: number }> };
export function AutoWatchIntervalForm() {
  const [userId, setUserId] = useState("");
  const [minutes, setMinutes] = useState("");
  const [loadedUser, setLoadedUser] = useState("");
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function execute(save: boolean, reset = false) {
    setBusy(true); setMessage("");
    try {
      const res = await fetch(`/api/admin/auto-watch-intervals${save ? "" : `?userId=${encodeURIComponent(userId)}`}`, {
        method: save ? "PATCH" : "GET", cache: "no-store",
        ...(save ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, intervalMinutes: reset ? null : Number(minutes) }) } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "設定を読み書きできませんでした。");
      setPolicy(data); setLoadedUser(userId); setMinutes(data.intervalMinutes == null ? "" : String(data.intervalMinutes));
      setMessage(save ? "保存しました。" : "現在の設定を読み込みました。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作を完了できませんでした。"); }
    finally { setBusy(false); }
  }
  const valid = Number.isInteger(Number(minutes)) && Number(minutes) >= 5 && Number(minutes) <= 10080;
  return <section className="space-y-4 rounded-lg border bg-card p-5">
    <p className="text-sm text-muted-foreground">寄付制度の判定とは独立した利用者ごとの設定です。未設定は各サービスの通常値を使います。同じ対象の取得は共有し、通知処理へ渡す間隔は各利用者に合わせます。</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 space-y-1 text-sm">利用者ID<Input disabled={busy} value={userId} onChange={event => { setUserId(event.target.value); setPolicy(null); setLoadedUser(""); }} inputMode="numeric" placeholder="Discord利用者ID" /></label>
      <Button onClick={() => execute(false)} disabled={busy || !/^\d{1,32}$/.test(userId)}>読み込む</Button>
    </div>
    {policy && loadedUser === userId ? <>
      <p className="text-sm">現在の設定: {policy.intervalMinutes == null ? "通常値" : `${policy.intervalMinutes}分`}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">間隔（分）<Input disabled={busy} type="number" min={5} max={10080} step={1} value={minutes} onChange={event => setMinutes(event.target.value)} placeholder="5以上" /></label>
        <Button onClick={() => execute(true)} disabled={busy || !valid}>保存</Button>
        <Button variant="outline" onClick={() => execute(true, true)} disabled={busy}>通常値へ戻す</Button>
      </div>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-left">サービス</th><th>通常値</th><th>設定間隔</th></tr></thead><tbody>{policy.providers.map(provider => <tr key={provider.providerId}><td className="py-1">{provider.providerId}</td><td className="text-center">{provider.defaultMinutes}分</td><td className="text-center">{provider.intervalMinutes}分</td></tr>)}</tbody></table></div>
      <p className="text-xs text-muted-foreground">サービスの取得制限・一時的なエラー・通知ルールにより、実際の確認や通知は遅れる場合があります。登録資格や寄付者フラグは変更しません。</p>
    </> : null}
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
