"use client";

import { useRef, useState } from "react";
import { parseXMonitor, xFeedback, xInterval, xObject, xPoolName, type XMonitor, type XMonitorAPI } from "./x-monitor-view";

const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
const pools = ["free", "supporter", "special"] as const;
export function XMonitorMoveEditor({ row, api, disabled = false, onSaved, onReload, onBusy }: {
  row: XMonitor; api: XMonitorAPI; disabled?: boolean; onSaved: (row: XMonitor) => Promise<void> | void;
  onReload: () => Promise<boolean | void>; onBusy?: (busy: boolean) => void;
}) {
  const [opened, setOpened] = useState(false), [selected, setSelected] = useState<XMonitor["poolKind"]>(row.poolKind);
  const [review, setReview] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false), [notice, setNotice] = useState("");
  const lock = useRef(false);
  const changed = selected !== null && pools.includes(selected) && (selected !== row.poolKind || row.state === "suspended");
  async function save() {
    if (lock.current || disabled || !changed || conflict || review !== row.revision || !selected) return;
    lock.current = true; setBusy(true); onBusy?.(true); setError(""); setNotice("");
    try {
      const response = xObject(await api(`x-monitors/${encodeURIComponent(row.id)}/move`, "POST", { poolKind: selected, expectedRevision: row.revision }));
      const moved = parseXMonitor(response.item ?? response);
      if (moved.id !== row.id || moved.accountId !== row.accountId) throw new Error("Invalid moved target");
      await onSaved(moved); setSelected(moved.poolKind); setReview(null); setConflict(false);
      const timing = !moved.processing ? "通知方法は一覧を更新して確認してください。" : moved.processing.effectiveMode === "realtime"
        ? `リアルタイム通知・個人${moved.processing.slotCost}枠を使用しています。` : moved.processing.configured
          ? `プランの間隔（${xInterval(moved.processing.intervalMinutes)}）で通知します。` : "通知方法は設定待ちです。";
      setNotice(`指定した利用枠へ変更しました。監視対象と通知設定を引き継ぎました。${timing}`);
    } catch (cause) {
      const failure = cause && typeof cause === "object" ? cause as { status?: number } : {};
      setConflict(failure.status === 409); setReview(null); setError(xFeedback(cause));
    } finally { lock.current = false; setBusy(false); onBusy?.(false); }
  }
  async function reload() {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); onBusy?.(true);
    try {
      if (await onReload() === false) throw new Error("Unavailable current monitor");
      setConflict(false); setReview(null); setError(""); setNotice("監視設定を再取得しました。選択を保持しています。変更内容をもう一度確認してください。");
    } catch { setError("監視設定を再取得できませんでした。選択を保持して再試行できます。"); }
    finally { lock.current = false; setBusy(false); onBusy?.(false); }
  }
  return <section aria-label="X監視の手動枠変更" className="space-y-2 text-sm">
    {!opened ? <button className={button} disabled={disabled} onClick={() => setOpened(true)}>利用枠の種類を変更</button> : <form noValidate onSubmit={event => {
      event.preventDefault(); if (!disabled && !busy && changed && !conflict) { setReview(row.revision); setError(""); setNotice(""); }
    }} className="space-y-2 rounded border p-3">
      <p>利用枠は、ご自身がこの画面で変更するまで、現在の割り当てを保ちます。移動先を選んで、内容を確認してください。</p>
      <label className="block">変更先の利用枠<select className="mt-1 w-full rounded border bg-background p-2" value={selected ?? ""} disabled={disabled || busy} onChange={event => { setSelected(event.target.value as XMonitor["poolKind"]); setReview(null); setNotice(""); }}>
        <option value="">利用枠を選択</option>{pools.map(kind => <option key={kind} value={kind}>{xPoolName(kind)}</option>)}</select></label>
      <p className="text-xs text-muted-foreground">利用できる枠から、お好きな移動先を選べます。保存時に、プランの条件・個人の登録上限・移動先の空きを確認します。</p>
      {review !== null ? <section aria-label="X監視の手動移動確認" className="space-y-2 rounded border bg-muted/30 p-3"><p>{xPoolName(row.poolKind)} → {xPoolName(selected)}</p>
        {row.processing?.requestedMode === "realtime" ? <p>移動先でリアルタイムの利用条件を確認します。特典の対象外になる場合は、プランの間隔に戻ります。間隔が未設定なら設定待ちになります。追加4枠は自動で確保しません。リアルタイムを続けるには、移動後に「通知方法を変更」から確認してください。</p> : null}
        {review !== row.revision ? <p role="alert">監視設定が更新されています。変更内容を確認し直してください。</p> : null}
        <button className={button} type="button" disabled={disabled || busy || conflict || review !== row.revision} onClick={() => void save()}>指定した利用枠へ移動</button>
        <button className={button} type="button" disabled={busy} onClick={() => setReview(null)}>利用枠の選択に戻る</button></section> : <button className={button} type="submit" disabled={disabled || busy || !changed || conflict}>利用枠の変更を確認</button>}
    </form>}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {conflict ? <button className={button} disabled={disabled || busy} onClick={() => void reload()}>監視設定を再取得</button> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
