"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { automationRetryDelay } from "./automation-feedback";

export type CadenceRow = { id: string; revision: number; name: string; slotCost?: number; effectiveSlotCost?: number; baseIntervalMinutes?: number; intervalMinutes?: number; cadenceUpdatedAtMs?: number | null; cadenceLimited?: boolean; canAllocateCadence?: boolean };
type Pool = { used: number; max: number; available: number };
type API = (path: string, method?: string, body?: unknown) => Promise<any>;
const validCost = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 10000;
const minutes = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0 ? `${Number(value.toFixed(2))}分` : "確認中";

export function MonitorCadenceEditor({ row, pool, api, disabled = false, draftValue, onDraft, onReload }: { row: CadenceRow; pool: Pool | null; api: API; disabled?: boolean; draftValue?: string; onDraft: (value: string) => void; onReload: () => Promise<CadenceRow | null> }) {
  const current = Number(row.slotCost ?? 1), knownCurrent = validCost(current);
  const [opened, setOpened] = useState(false), [draft, setDraft] = useState(draftValue ?? String(row.slotCost ?? 1)), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false), [confirmation, setConfirmation] = useState<{ revision: number; updatedAtMs: number | null } | null>(null);
  const mounted = useRef(true), actionLock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selected = draft.length <= 5 && /^\d+$/.test(draft) ? Number(draft) : NaN;
  const poolKnown = Boolean(pool && Number.isSafeInteger(pool.used) && Number.isSafeInteger(pool.max) && Number.isSafeInteger(pool.available));
  const projectedUsed = pool && knownCurrent ? pool.used - current + selected : NaN;
  const fits = selected === 1 || poolKnown && Number.isSafeInteger(projectedUsed) && projectedUsed <= pool!.max;
  const valid = knownCurrent && validCost(selected) && fits;
  const changed = knownCurrent && selected !== current;
  const estimate = typeof row.baseIntervalMinutes === "number" && row.baseIntervalMinutes > 0 && validCost(selected) ? Math.max(5, row.baseIntervalMinutes / selected) : undefined;
  const reviewed = confirmation && confirmation.revision === row.revision && confirmation.updatedAtMs === (row.cadenceUpdatedAtMs ?? null);
  function update(value: string) { setDraft(value); onDraft(value); setConfirmation(null); setMessage(""); }
  async function reload() {
    if (actionLock.current || disabled) return; actionLock.current = true; setBusy(true); setError("");
    try { const next = await onReload(); if (!mounted.current) return; if (!next) throw new Error("Missing monitor"); setConflict(false); setConfirmation(null); setMessage("最新の通知を取得しました。入力内容を保持しています。配分・利用枠をもう一度確認してください。"); }
    catch { if (mounted.current) setError("通知・利用枠を再取得できませんでした。入力内容を保持して再試行できます。"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function save() {
    if (actionLock.current || disabled || !row.canAllocateCadence || !valid || !changed || !reviewed || conflict) return;
    actionLock.current = true; setBusy(true); setError(""); setMessage("");
    let accepted = false;
    try {
      const result = await api(`monitors/auto/${encodeURIComponent(row.id)}`, "POST", { action: "cadence", slotCost: selected, expectedRevision: row.revision, expectedUpdatedAtMs: row.cadenceUpdatedAtMs ?? null });
      accepted = true; if (!mounted.current) return;
      const saved = validCost(Number(result.slotCost)) ? String(result.slotCost) : draft; setDraft(saved); onDraft(saved); setConfirmation(null);
      await onReload(); if (!mounted.current) return;
      setMessage(`枠配分を保存しました。サービスの設定間隔は${minutes(Number(result.intervalMs) / 60000)}です。実際の確認は取得先と送信上限の範囲で行います。`);
    } catch (cause: any) {
      if (!mounted.current) return; setConfirmation(null);
      const stale = !accepted && (cause?.status === 409 || ["REVISION_CONFLICT", "AUTOMATION_CADENCE_CONFLICT"].includes(cause?.code)); setConflict(stale);
      setError(accepted ? "枠配分は保存済みです。一覧・利用枠の再取得に失敗しました。最新の設定を再取得してください。" : stale ? "通知または枠配分が別の操作で変更されました。最新の設定を取得し、保持した入力内容と比較してください。" : cause?.code === "AUTOMATION_SLOT_LIMIT" ? "この配分に必要な空き枠が足りません。利用枠を再確認してください。入力内容は保持されています。" : automationRetryDelay(cause) !== null ? cause.message : "枠配分を保存できませんでした。入力内容を保持しています。設定を確認して再試行してください。");
    } finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  if (row.canAllocateCadence !== true) return null;
  return <section aria-label={`${row.name}の確認間隔・使用枠`} className="space-y-3 rounded-lg border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">使用枠 {knownCurrent ? current : "確認中"}枠 · 現在の設定間隔 {minutes(row.intervalMinutes)}</p><Button type="button" variant="outline" disabled={disabled || busy} onClick={() => setOpened(value => !value)}>{opened ? "枠配分を閉じる" : "確認間隔・使用枠"}</Button></div>
    {row.cadenceLimited ? <p role="status" className="text-xs text-muted-foreground">利用可能な枠の変更により、短縮設定は現在適用されていません。配分した枠を保持しています。1枠へ戻すと追加分を解放できます。</p> : null}
    {!opened && draft !== String(row.slotCost ?? 1) ? <p role="status" className="text-xs text-muted-foreground">枠配分の入力を保持しています。</p> : null}
    {opened ? <form noValidate className="space-y-3" onSubmit={event => { event.preventDefault(); if (valid && changed && !disabled && !busy && !conflict) { setConfirmation({ revision: row.revision, updatedAtMs: row.cadenceUpdatedAtMs ?? null }); setError(""); setMessage(""); } }}>
      <p className="text-xs text-muted-foreground">この通知に複数の枠を割り当てると、確認間隔の短縮を選べます。自動では配分しません。停止中も配分した枠を使用します。</p><p className="text-xs text-muted-foreground">{poolKnown ? `通知枠全体: 使用${pool!.used} / ${pool!.max}枠 · 空き${pool!.available}枠` : "利用枠を確認できません。追加の配分には最新の利用枠が必要です。1枠に戻す操作は可能です。"}</p>
      <fieldset disabled={disabled || busy} className="flex flex-wrap items-end gap-2"><label className="space-y-1 text-sm"><span className="block">この通知で使う枠数</span><Input type="number" inputMode="numeric" min={1} max={10000} step={1} value={draft} onChange={event => update(event.target.value)} aria-invalid={!valid} /></label><Button type="button" variant="outline" onClick={() => update("1")}>1枠に戻す</Button></fieldset>
      <p className="text-sm">設定後の目安: {estimate === undefined ? "確認中" : `約${minutes(estimate)}`}<span className="block text-xs text-muted-foreground">最短5分。取得先の制限・負荷・サービス側の送信上限に応じて実際の確認時刻を調整します。</span></p>
      {validCost(selected) && !fits ? <p role="status" className="text-sm text-destructive">空き枠が足りません。この通知の配分を減らすか、利用枠を再確認してください。</p> : null}
      {confirmation ? <div aria-label="確認間隔・枠配分の変更確認" className="space-y-3 rounded-lg bg-muted/30 p-3 text-sm"><h4 className="font-medium">配分の変更確認</h4><table className="w-full text-left"><thead><tr><th>項目</th><th>現在</th><th>保存後</th></tr></thead><tbody><tr><th className="py-1 font-normal">使用枠</th><td>{current}枠</td><td>{selected}枠</td></tr><tr><th className="py-1 font-normal">確認間隔</th><td>{minutes(row.intervalMinutes)}</td><td>{estimate === undefined ? "確認中" : `目安 約${minutes(estimate)}`}</td></tr>{poolKnown ? <tr><th className="py-1 font-normal">通知枠全体の使用</th><td>{pool!.used} / {pool!.max}枠</td><td>{projectedUsed} / {pool!.max}枠</td></tr> : null}</tbody></table>{!reviewed ? <p role="alert">現在の設定が更新されました。編集に戻り、最新の値ともう一度比較してください。</p> : null}<div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled || busy || !reviewed || conflict} onClick={() => void save()}>この枠配分で保存</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>枠配分の編集に戻る</Button></div></div> : <Button type="submit" disabled={disabled || busy || !valid || !changed || conflict}>枠配分の変更を確認</Button>}
      <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => void reload()}>通知・利用枠を再取得</Button>
    </form> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
