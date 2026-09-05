"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Request = { type: "agent.status" | "agent.restart"; input: { expectedInvocationId?: string }; idempotencyKey: string };
type Reply = { id?: string; type?: string; ok: boolean; state?: string; error?: string; data?: { data?: Record<string, unknown>; error?: unknown }; checkedAt?: string };
const STORAGE_KEY = "cbte-admin-agent-recovery-pending-v1";

export function AgentRecoveryPanel({ onRecovered }: { onRecovered: () => Promise<void> }) {
  const [pending, setPending] = useState<Request | null>(null);
  const [receipt, setReceipt] = useState<Reply | null>(null);
  const [unit, setUnit] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
      if (saved && ["agent.status", "agent.restart"].includes(saved.type) && typeof saved.idempotencyKey === "string") setPending(saved);
    } catch { /* The executor remains the authoritative receipt store. */ }
  }, []);

  async function execute(request: Request) {
    setBusy(true); setError(""); setPending(request);
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(request)); } catch { /* Still retain key in visible state. */ }
    if (request.type === "agent.restart") setUnit(null);
    try {
      const response = await fetch("/api/admin/agent-recovery", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(50000) });
      const reply = await response.json() as Reply;
      setReceipt(reply);
      if (reply.state === "unconfirmed" || response.status >= 500) { setError(reply.error || "受付結果を確認できません。同じキーで確認してください。"); return; }
      setPending(null);
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Receipt remains on executor. */ }
      if (!response.ok || !reply.ok) { setError(reply.error || String(reply.data?.error || "復旧操作に失敗しました。記録を確認してください。")); return; }
      if (request.type === "agent.status") setUnit(reply.data?.data || null);
      else await onRecovered();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const invocationId = typeof unit?.InvocationID === "string" ? unit.InvocationID : "";
  return <Card><CardHeader><CardTitle>管理デーモンを確認・復旧</CardTitle><CardDescription>通常ダッシュボードから独立executorへ接続します。対象は cbte-admin.service に固定され、管理デーモンのHTTP応答やDB接続に依存しません。</CardDescription></CardHeader><CardContent className="space-y-3">
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || Boolean(pending)} onClick={() => void execute({ type: "agent.status", input: {}, idempotencyKey: crypto.randomUUID() })}>管理デーモンの状態を確認</Button><Button disabled={busy || Boolean(pending) || !/^[0-9a-f]{32}$/i.test(invocationId)} onClick={() => void execute({ type: "agent.restart", input: { expectedInvocationId: invocationId }, idempotencyKey: crypto.randomUUID() })}>確認した管理デーモンを再起動</Button></div>
    {unit ? <div className="rounded border p-3 text-sm"><p>状態: {String(unit.ActiveState ?? "未取得")} / {String(unit.SubState ?? "未取得")} / PID: {String(unit.MainPID ?? "未取得")}</p><p className="break-all">起動ID: {invocationId || "未取得（再起動不可）"}</p><p>終了結果: {String(unit.Result ?? "未取得")}</p></div> : null}
    {error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}
    {pending ? <div className="rounded border p-3 text-sm"><p className="break-all">受付キー: {pending.idempotencyKey} / {pending.type}</p><p>応答が途切れても新しい操作として再送しません。独立executorの同じ受付記録を確認します。</p><Button className="mt-2" variant="outline" disabled={busy} onClick={() => void execute(pending)}>同じ受付キーで結果を確認</Button></div> : null}
    {receipt ? <details className="rounded border p-3"><summary className="cursor-pointer text-sm">独立executorの受付・状態・実行結果</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(receipt, null, 2)}</pre></details> : null}
    <p className="text-xs text-muted-foreground">再起動後は管理デーモンのHTTP接続も確認します。unitの起動だけでは機能の復旧を確定しません。executor自体に接続できない場合は、その接続エラーを表示します。</p>
  </CardContent></Card>;
}
