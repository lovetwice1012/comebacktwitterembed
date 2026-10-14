"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Clock3, Layers3, Zap } from "lucide-react";
import { parseXMonitor, xFeedback, xObject, type XMonitor, type XMonitorAPI, type XMonitorProcessing, type XProcessingMode } from "./x-monitor-view";

const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
export const xTimingLabel = (processing: XMonitorProcessing) => processing.effectiveMode === "realtime" ? "リアルタイム" : processing.intervalMinutes === null ? "間隔の設定待ち" : `${processing.intervalMinutes}分ごと`;
export const xRealtimeBenefit = (processing: XMonitorProcessing) => {
  const source = processing.realtimeEligibilitySource ?? processing.realtimeSource;
  return source === "supporter" ? "支援者特典" : source === "plan" ? "プラン特典" : null;
};
type Review = { revision: number; mode: XProcessingMode; realtimeSlotCost: 1 | 5 };

export function XMonitorTimingEditor({ row, api, active = true, disabled = false, onSaved, onReload, onBusy }: {
  row: XMonitor; api: XMonitorAPI; active?: boolean; disabled?: boolean; onSaved: (saved: XMonitor) => Promise<void> | void;
  onReload: () => Promise<boolean | void>; onBusy?: (busy: boolean) => void;
}) {
  const processing = row.processing;
  const [opened, setOpened] = useState(false), [mode, setMode] = useState<XProcessingMode>(processing?.requestedMode ?? "batch");
  const [review, setReview] = useState<Review | null>(null), [busy, setBusy] = useState(false), [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const alive = useRef(false), activeRef = useRef(active), current = useRef(row), epoch = useRef(0), lock = useRef(false);
  activeRef.current = active; current.current = row;
  const fieldId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { if (!active) epoch.current++; }, [active]);
  const allowed = Boolean(active && !disabled && !busy && processing && !needsReload && (mode === "batch" || processing.canEnableRealtime));
  const desiredCost = processing ? mode === "realtime" ? processing.realtimeSlotCost : 1 : null;
  const changed = Boolean(processing && (mode !== processing.explicitMode || mode !== processing.effectiveMode || desiredCost !== processing.slotCost));
  const validReview = Boolean(processing && review && review.revision === row.revision && review.mode === mode && review.realtimeSlotCost === processing.realtimeSlotCost);
  async function save() {
    if (!allowed || !changed || !validReview || !review || !processing || lock.current) return;
    const version = ++epoch.current, expected = row; lock.current = true; setBusy(true); onBusy?.(true); setError(""); setNotice("");
    try {
      const response = xObject(await api(`x-monitors/${encodeURIComponent(row.id)}`, "PATCH", { expectedRevision: review.revision, processingMode: review.mode,
        ...(review.mode === "realtime" ? { expectedRealtimeSlotCost: review.realtimeSlotCost } : {}) }));
      const saved = parseXMonitor(response.item ?? response);
      if (!saved.processing || saved.id !== expected.id || saved.accountId !== expected.accountId || saved.accountHandle !== expected.accountHandle) throw new Error("Invalid processing result");
      if (!alive.current || !activeRef.current || version !== epoch.current) return;
      if (current.current.id !== saved.id || current.current.revision > saved.revision) { setNeedsReload(true); setReview(null); return; }
      await onSaved(saved);
      if (!alive.current || !activeRef.current || version !== epoch.current) return;
      setMode(saved.processing.requestedMode); setReview(null); setOpened(false); setNeedsReload(false); setNotice("通知方法を保存しました。");
    } catch (cause) {
      if (alive.current && activeRef.current && version === epoch.current) { setError(xFeedback(cause)); setNeedsReload(true); setReview(null); }
    } finally { lock.current = false; if (alive.current) setBusy(false); onBusy?.(false); }
  }
  async function reload() {
    if (!active || disabled || lock.current) return;
    const version = ++epoch.current;
    lock.current = true; setBusy(true); onBusy?.(true); setError("");
    try {
      const refreshed = await onReload();
      if (!alive.current || !activeRef.current || version !== epoch.current) return;
      if (refreshed !== true) throw new Error("Unavailable processing");
      setNeedsReload(false); setReview(null);
    } catch { if (alive.current && activeRef.current && version === epoch.current) setError("通知方法を確認できませんでした。再確認してください。"); }
    finally { lock.current = false; if (alive.current) setBusy(false); onBusy?.(false); }
  }
  return <section aria-label="X監視の通知方法" className="nx-monitor-timing">
    {processing ? <><div className="nx-monitor-timing-status"><span className="nx-timing-chip">{processing.effectiveMode === "realtime" ? <Zap size={14} aria-hidden="true" /> : <Clock3 size={14} aria-hidden="true" />}{xTimingLabel(processing)}</span><span className="nx-timing-chip"><Layers3 size={14} aria-hidden="true" />使用{processing.slotCost}枠</span>{processing.effectiveMode === "realtime" && xRealtimeBenefit(processing) ? <span className="nx-field-note">{xRealtimeBenefit(processing)}</span> : null}</div>
      {processing.requestedMode === "realtime" && processing.effectiveMode !== "realtime" ? <p className="nx-field-note">{processing.modeSource === "owner" ? "共通設定の希望" : "保存した希望"}はリアルタイムです。現在は{xTimingLabel(processing)}で通知します。</p> : null}
      {!opened ? <button className={button} disabled={!active || disabled || busy} onClick={() => { setOpened(true); setMode(processing.requestedMode); setReview(null); setError(""); setNotice(""); }}>通知方法を変更</button> : <form aria-label="X監視の通知方法を選択" noValidate onSubmit={event => { event.preventDefault(); if (allowed && changed && processing) { setReview({ revision: row.revision, mode, realtimeSlotCost: processing.realtimeSlotCost }); setError(""); } }}>
        <fieldset disabled={!active || disabled || busy} className="nx-timing-options"><legend>このアカウントの通知方法</legend>
          <label className="nx-timing-option"><input type="radio" name={fieldId} value="batch" checked={mode === "batch"} onChange={() => { setMode("batch"); setReview(null); setNotice(""); }} /><span><strong>プランの間隔で通知</strong><small>{processing.intervalMinutes === null ? "間隔の設定待ち" : `${processing.intervalMinutes}分ごと`}・1枠</small></span></label>
          <label className="nx-timing-option"><input type="radio" name={fieldId} value="realtime" checked={mode === "realtime"} disabled={!processing.canEnableRealtime} onChange={() => { setMode("realtime"); setReview(null); setNotice(""); }} /><span><strong>リアルタイム</strong><small>受信後すぐに通知・合計{processing.realtimeSlotCost}枠{xRealtimeBenefit(processing) ? `（${xRealtimeBenefit(processing)}）` : ""}</small></span></label>
        </fieldset>
        {!processing.canEnableRealtime ? <p className="nx-field-note">リアルタイムに使える資格と個人の空き枠を確認してください。</p> : null}
        {mode === "realtime" && processing.realtimeSlotCost === 5 ? <p className="nx-slot-consent">この監視に個人の登録枠を合計5枠使用します。{processing.slotCost === 1 ? "確認して保存すると、追加の4枠を確保します。" : "確保済みの5枠を引き続き使用します。"}</p> : null}
        {review ? <section aria-label="X監視の通知方法変更確認" className="nx-review"><dl className="nx-processing-review"><div><dt>変更後の通知方法</dt><dd>{mode === "realtime" ? "リアルタイム" : "プランの間隔で通知"}</dd></div><div><dt>現在の使用枠</dt><dd>{processing.slotCost}枠</dd></div><div><dt>変更後の使用枠</dt><dd>{desiredCost}枠</dd></div></dl>
          {!validReview ? <p role="alert">監視の設定や必要な枠数が変わりました。内容を確認し直してください。</p> : null}
          <div className="nx-actions"><button type="button" className="nx-primary" disabled={!allowed || !changed || !validReview} onClick={() => void save()}>{mode === "realtime" ? `${processing.realtimeSlotCost}枠を使って即時通知` : "プランの間隔で通知に変更"}</button><button type="button" className={button} disabled={busy} onClick={() => setReview(null)}>選び直す</button></div>
        </section> : <button type="submit" className={button} disabled={!allowed || !changed}>通知方法の変更を確認</button>}
        <button type="button" className="nx-text-link" disabled={busy} onClick={() => { setOpened(false); setReview(null); setError(""); }}>閉じる</button>
      </form>}</> : <p className="nx-field-note">通知方法の確認待ち</p>}
    {error ? <p role="alert" className="nx-feedback nx-feedback-error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {needsReload || !processing ? <button className={button} disabled={!active || disabled || busy} onClick={() => void reload()}>最新の通知方法を確認</button> : null}
  </section>;
}
