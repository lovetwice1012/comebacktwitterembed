"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type RecordValue = Record<string, unknown>;
type RecoveryStatus = RecordValue & { configured?: boolean; available?: boolean; phase?: string; message?: string; fetchedAt?: string; updatedAt?: string; backup?: RecordValue | null; candidate?: RecordValue | null; gates?: unknown[]; lastError?: unknown; primaryEnrolled?: boolean; activeNode?: unknown; epoch?: unknown; manualSwitch?: RecordValue | null };
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const display = (value: unknown) => value == null || value === "" ? "未取得" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
const pretty = (value: unknown) => JSON.stringify(value ?? null, null, 2);

function instant(value: unknown) {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" || typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
  const timestamp = numeric === null ? Date.parse(String(value)) : numeric < 1e12 ? numeric * 1000 : numeric;
  return Number.isFinite(timestamp) ? timestamp : null;
}
function date(value: unknown) { const timestamp = instant(value); return timestamp === null ? "未取得" : new Date(timestamp).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }); }
export function backupAge(value: unknown, now = Date.now()) {
  const timestamp = instant(value);
  if (timestamp === null) return "未取得";
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 0) return "取得元の時刻が未来です（時刻同期を確認）";
  const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const minutes = Math.floor(seconds % 3600 / 60);
  return `${days ? `${days}日 ` : ""}${hours}時間 ${minutes}分前`;
}
const phaseLabels: Record<string, string> = { idle: "待機中", monitoring: "監視中", waiting_for_backup: "バックアップ待ち", downloading: "バックアップ取得中", restoring: "復元中", validating: "復旧候補を検証中", ready: "準備済み（復旧条件を確認）", blocked: "条件不足で停止中", failed: "処理に失敗", active: "稼働中" };

function localDateTime(value = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}

async function recoveryAction(type: string, input: RecordValue) {
  const idempotencyKey = crypto.randomUUID();
  const create = await fetch("/api/admin/agent/actions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, input, idempotencyKey }), cache: "no-store", signal: AbortSignal.timeout(15000) });
  const first = await create.json() as RecordValue;
  if (!create.ok) throw new Error(display(object(first.error).message || first.error || `HTTP ${create.status}`));
  let action = first;
  for (let attempt = 0; attempt < 120 && ["queued", "running"].includes(String(action.status)); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await fetch(`/api/admin/agent/actions/${encodeURIComponent(String(action.id))}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000) });
    action = await response.json() as RecordValue;
    if (!response.ok) throw new Error(display(object(action.error).message || action.error || `HTTP ${response.status}`));
  }
  return action;
}

function ManualSwitchPanel({ status, onRefresh }: { status: RecoveryStatus; onRefresh: () => Promise<void> }) {
  const active = status.activeNode === "oci" ? "oci" : status.activeNode === "primary" ? "primary" : "";
  const [target, setTarget] = useState(active === "oci" ? "primary" : "oci");
  const [executeAt, setExecuteAt] = useState(localDateTime());
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false); const [risk, setRisk] = useState(false); const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  useEffect(() => { if (active) setTarget(active === "oci" ? "primary" : "oci"); }, [active]);
  const candidate = object(status.candidate), backup = object(status.backup), pending = object(status.manualSwitch);
  const pendingState = String(pending.state || "");
  async function schedule() {
    if (!active || !status.epoch || candidate.phase !== "VALIDATED" && target === "oci") throw new Error("現在の復旧候補を確認してから実行してください");
    const date = new Date(`${executeAt}:00+09:00`); if (!Number.isFinite(date.getTime())) throw new Error("実行日時が不正です");
    setBusy(true); setError(""); setMessage("");
    try {
      const action = await recoveryAction("recovery.manual_switch", { targetNode: target, executeAt: date.toISOString(), expectedEpoch: Number(status.epoch), expectedCandidateId: target === "oci" ? String(candidate.id || "") : "", expectedBackupId: target === "oci" ? String(backup.backupId || "") : "", expectedBackupSha256: target === "oci" ? String(backup.sourceSha256 || "") : "", expectedBackupTimestamp: target === "oci" ? String(backup.sourceTimestamp || "") : "", reason: reason.trim(), confirm, acceptDataRisk: risk, acceptPrimaryIntentOverride: override });
      if (String(action.status) !== "succeeded") throw new Error(display(action.error || action.result || "手動切り替えを受け付けられませんでした"));
      const result = object(action.result); setMessage(`手動切り替えを受け付けました。操作ID: ${String(action.id || "未取得")} / ${display(object(result.manualSwitch).state || action.status)}`); setReason(""); setConfirm(false); setRisk(false); setOverride(false); await onRefresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!pending.operationId || !["scheduled", "blocked"].includes(pendingState)) return;
    setBusy(true); setError(""); setMessage("");
    try { const action = await recoveryAction("recovery.manual_switch.cancel", { operationId: String(pending.operationId) }); if (String(action.status) !== "succeeded") throw new Error(display(action.error || action.result || "予約をキャンセルできませんでした")); setMessage(`予約をキャンセルしました。操作ID: ${String(action.id || "未取得")}`); await onRefresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3 rounded border p-4"><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">復旧先の手動切り替え・日時予約</h3>{pending.operationId ? <span className="text-xs">現在の予約: {String(pending.state)} / {String(pending.targetNode)} / {date(pending.executeAt)}</span> : null}</div><p className="text-sm">指定時刻に復旧条件をもう一度検証してから切り替えます。予約しても、候補・epoch・lease・DB・公開経路の条件が満たされなければ実行せず停止します。</p>{!active ? <p className="text-sm text-muted-foreground">現在の稼働ノードを確認できないため操作できません。</p> : <><div className="grid gap-3 md:grid-cols-2"><label className="text-sm">切り替え先<select className="mt-1 h-10 w-full rounded-md border bg-card px-3" value={target} onChange={e => setTarget(e.target.value)} disabled={busy}><option value="oci">予備のクラウドサーバー</option><option value="primary">メインサーバー</option></select></label><label className="text-sm">実行日時（端末のJST）<input className="mt-1 h-10 w-full rounded-md border bg-card px-3" type="datetime-local" min={localDateTime()} value={executeAt} onChange={e => setExecuteAt(e.target.value)} disabled={busy} /></label></div><label className="block text-sm">切り替え理由<textarea className="mt-1 min-h-24 w-full rounded-md border bg-card p-2" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} disabled={busy} placeholder="調査・切り替えの理由（5文字以上）" /></label><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} disabled={busy} />指定時刻にサービスの切り替え処理を行うことを確認しました</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={risk} onChange={e => setRisk(e.target.checked)} disabled={busy} />データ同期時点によって設定・受付履歴が戻る可能性を確認しました（savedataは移行対象外）</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} disabled={busy} />既存の停止・保守指示に反して切り替える可能性がある場合も、明示操作として確認しました</label><div className="flex flex-wrap gap-2"><Button disabled={busy || !reason.trim() || reason.trim().length < 5 || !confirm || !risk || !override || !active || (target === active) || (target === "oci" && candidate.phase !== "VALIDATED")} onClick={() => void schedule()}>{executeAt && new Date(`${executeAt}:00`).getTime() > Date.now() + 60_000 ? "切り替えを予約" : "今すぐ切り替えを受付"}</Button><Button type="button" variant="outline" disabled={busy || !["scheduled", "blocked"].includes(pendingState)} onClick={() => void cancel()}>予約をキャンセル</Button></div></>}{message ? <p role="status" className="text-sm">{message}</p> : null}{error ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}<details className="rounded border p-2"><summary className="cursor-pointer text-sm">手動切り替えの予約・実行記録</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{pretty(status.manualSwitch || null)}</pre></details></div>;
}

export function RecoveryStatusView({ status, stale = false }: { status: RecoveryStatus; stale?: boolean }) {
  const backup = object(status.backup), candidate = object(status.candidate);
  const checks = Array.isArray(candidate.checks) ? candidate.checks.map((value, index) => [String(object(value).code || object(value).name || index + 1), value] as const) : Object.entries(object(candidate.checks));
  const gates = Array.isArray(status.gates) ? status.gates : [];
  const [rawOpen, setRawOpen] = useState(false);
  return <div className="space-y-4">
    {stale ? <p role="status" className="rounded border p-3 text-sm">現在の状態は取得できていません。以下は {date(status.fetchedAt)} JST に取得できた最後の応答です。</p> : null}
    <div className="grid gap-3 md:grid-cols-3"><div className="rounded border p-3"><p className="text-xs text-muted-foreground">進行段階</p><p className="mt-1 break-all font-semibold">{phaseLabels[status.phase || ""] || display(status.phase)}</p><p className="text-xs">{display(status.phase)}</p></div><div className="rounded border p-3"><p className="text-xs text-muted-foreground">現在の稼働ノード</p><p className="mt-1 whitespace-pre-wrap break-all">{display(status.activeNode)}</p></div><div className="rounded border p-3"><p className="text-xs text-muted-foreground">本番系の登録状態 / 復旧世代</p><p className="mt-1">{status.primaryEnrolled === true ? "登録済み" : status.primaryEnrolled === false ? "未登録" : "未取得"} / {display(status.epoch)}</p></div></div>
    <p className="text-xs text-muted-foreground">コントローラー更新日時: {date(status.updatedAt)} JST / この画面の取得日時: {date(status.fetchedAt)} JST</p>
    <div className="rounded border p-4"><h3 className="mb-3 font-semibold">バックアップ</h3>{status.backup ? <dl className="grid gap-2 text-sm md:grid-cols-[180px_1fr]"><dt>バックアップID</dt><dd className="break-all">{display(backup.backupId)}</dd><dt>取得元の時刻・経過</dt><dd>{date(backup.sourceTimestamp)} JST / {backupAge(backup.sourceTimestamp)}</dd><dt>SHA-256</dt><dd className="break-all font-mono text-xs">{display(backup.sourceSha256)}</dd><dt>取得元のサイズ</dt><dd>{backup.sourceBytes == null ? "未取得" : `${display(backup.sourceBytes)} bytes`}</dd></dl> : <p className="text-sm">バックアップ情報は未取得です。</p>}</div>
    <div className="space-y-3 rounded border p-4"><h3 className="font-semibold">復旧候補</h3><p className="text-sm">候補ID: {display(candidate.id)} / DB状態: {display(candidate.databaseState)}</p>{checks.length ? checks.map(([name, value]) => { const item = object(value); return <div key={name} className="rounded border p-3 text-sm"><p className="font-medium">{name}</p><pre className="mt-1 whitespace-pre-wrap break-words">{display(Object.keys(item).length ? item : value)}</pre></div>; }) : <p className="text-sm text-muted-foreground">検証結果は未取得です。</p>}</div>
    <div className="space-y-3 rounded border p-4"><h3 className="font-semibold">復旧の条件</h3>{gates.length ? gates.map((value, index) => { const gate = object(value); return <div key={String(gate.code || index)} className="rounded border p-3 text-sm"><p className="font-medium">{gate.ready === true ? "条件を確認済み" : gate.ready === false ? "未充足" : "未確認"} / {display(gate.code)}</p><p className="mt-1 whitespace-pre-wrap break-words">{display(gate.message)}</p></div>; }) : <p className="text-sm text-muted-foreground">条件の判定は未取得です。</p>}</div>
    {status.lastError ? <div role="alert" className="rounded border border-destructive p-3"><h3 className="mb-2 text-sm font-semibold">最後に記録されたエラー</h3><pre className="whitespace-pre-wrap break-words text-xs">{display(status.lastError)}</pre></div> : null}
    <details open={rawOpen} onToggle={event => setRawOpen(event.currentTarget.open)} className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">復旧状態の原記録・検証の詳細</summary>{rawOpen ? <pre className="mt-3 max-h-[36rem] overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(status, null, 2)}</pre> : null}</details>
  </div>;
}

export function EmergencyRecoveryPanel() {
  const [snapshot, setSnapshot] = useState<RecoveryStatus | null>(null);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const [connectionState, setConnectionState] = useState("loading");
  const mounted = useRef(true); const inFlight = useRef(false); const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true);
    const request = new AbortController(); controller.current = request;
    try {
      const response = await fetch("/api/admin/recovery", { method: "GET", cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
      const value = await response.json() as RecoveryStatus;
      if (!mounted.current) return;
      if (!response.ok || value.available !== true) { setConnectionState(String(value.state || "unavailable")); setError(display(value.message || value.error || "緊急復旧の状態を取得できません。")); return; }
      setSnapshot(value); setConnectionState("available"); setError("");
    } catch { if (mounted.current) { setConnectionState("unavailable"); setError("緊急復旧の状態を取得できません。他の管理画面は引き続き利用できます。"); } }
    finally { inFlight.current = false; if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; const initial = setTimeout(() => void refresh(), 0); const timer = setInterval(() => void refresh(), 30000); return () => { mounted.current = false; clearTimeout(initial); clearInterval(timer); controller.current?.abort(); }; }, [refresh]);
  return <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>緊急復旧の状態</CardTitle><Button variant="outline" disabled={loading} onClick={() => void refresh()}>{loading ? "取得中" : "状態を更新"}</Button></div><CardDescription>バックアップ、復旧候補、本番系の登録状態と復旧条件を30秒ごとに確認します。</CardDescription></CardHeader><CardContent className="space-y-4">
    {error ? <div role={connectionState === "not_configured" ? "status" : "alert"} className="rounded border p-3 text-sm"><p className="font-medium">{connectionState === "not_configured" || connectionState === "invalid_configuration" ? "緊急復旧コントローラーが未設定です" : "緊急復旧コントローラーの状態は未取得です"}</p><p className="mt-1 whitespace-pre-wrap break-words">{error}</p></div> : null}
    {!snapshot && loading ? <p role="status" className="text-sm text-muted-foreground">復旧状態を取得しています。</p> : null}
    {snapshot ? <><RecoveryStatusView status={snapshot} stale={connectionState !== "available"} /><ManualSwitchPanel status={snapshot} onRefresh={refresh} /></> : null}
  </CardContent></Card>;
}
