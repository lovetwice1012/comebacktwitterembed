"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { XMonitorAPI } from "./x-monitor-view";
import { ArrowRight, Clock3, Zap } from "lucide-react";
import "./notification-x.css";

type Mode = "batch" | "realtime";
type Settings = { requestedMode: Mode; effectiveMode: Mode; realtimeAllowed: boolean; planId: string; planLabel: string;
  intervalMinutes: number | null; configured: boolean; reasonCode: string | null; rollout: { eligible: boolean } };
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
const modeName = (mode: Mode) => mode === "realtime" ? "リアルタイム" : "プランの間隔でまとめて通知";

function parse(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const item = value as Record<string, unknown>, rollout = item.rollout as Record<string, unknown> | null;
  if (!["batch", "realtime"].includes(String(item.requestedMode)) || !["batch", "realtime"].includes(String(item.effectiveMode))
    || typeof item.realtimeAllowed !== "boolean" || typeof item.configured !== "boolean"
    || typeof item.planId !== "string" || !item.planId || item.planId.length > 64 || typeof item.planLabel !== "string" || item.planLabel.length > 120
    || item.intervalMinutes !== null && (!Number.isSafeInteger(item.intervalMinutes) || Number(item.intervalMinutes) < 5 || Number(item.intervalMinutes) > 10080)
    || item.reasonCode !== null && (typeof item.reasonCode !== "string" || !/^[A-Z_]{1,80}$/.test(item.reasonCode))
    || !rollout || typeof rollout !== "object" || Array.isArray(rollout) || typeof rollout.eligible !== "boolean"
    || item.effectiveMode === "realtime" && item.realtimeAllowed !== true) throw new Error();
  return { requestedMode: item.requestedMode as Mode, effectiveMode: item.effectiveMode as Mode,
    realtimeAllowed: item.realtimeAllowed, planId: item.planId, planLabel: item.planLabel, intervalMinutes: item.intervalMinutes as number | null,
    configured: item.configured, reasonCode: item.reasonCode as string | null, rollout: { eligible: rollout.eligible } };
}
function feedback(cause: unknown): string {
  const failure = cause && typeof cause === "object" ? cause as { status?: number; code?: string } : {};
  if (failure.code === "X_PROCESSING_CONFLICT" || failure.status === 409) return "別の画面で通知のタイミングが更新されました。選択内容はそのままです。最新の設定を確認してから保存してください。";
  if (failure.code === "X_REALTIME_PLAN_REQUIRED") return "現在のプランで選べるタイミングを確認してください。選択内容はそのままです。「最新の設定を確認」で利用できる設定を読み込めます。";
  if (failure.code === "X_ROLLOUT_SUPPORTERS_ONLY" || failure.code === "X_ROLLOUT_DISABLED") return "X通知は、現在の受付対象となっている支援者の方が設定できます。選択内容はそのままです。";
  return "選択内容はそのままです。少し待ってから、最新の設定を確認してもう一度保存してください。";
}

export function XProcessingSettings({ api, active = true, compact = false }: { api: XMonitorAPI; active?: boolean; compact?: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null), [mode, setMode] = useState<Mode | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [needsReview, setNeedsReview] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const alive = useRef(false), activeRef = useRef(active), request = useRef(0), action = useRef(false);
  activeRef.current = active;
  const load = useCallback(async (manual = false) => {
    if (!activeRef.current || action.current) return;
    const version = ++request.current;
    setLoading(true); setError("");
    try {
      const next = parse(await api("x-processing-settings"));
      if (!alive.current || !activeRef.current || version !== request.current) return;
      setSettings(next); setMode(previous => previous ?? next.requestedMode); setNeedsReview(false);
      if (manual) setNotice("最新の設定を確認しました。現在の設定と選択内容を確認してから保存できます。");
    } catch {
      if (alive.current && activeRef.current && version === request.current) { setNeedsReview(true); setError("通知のタイミングを読み込めませんでした。監視の登録・編集は引き続き利用できます。「最新の設定を確認」で再試行できます。"); }
    } finally { if (alive.current && version === request.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    if (active) void load();
    return () => { alive.current = false; request.current++; };
  }, [active, load]);
  const canSave = Boolean(active && settings && mode && mode !== settings.requestedMode
    && (mode === "batch" || settings.rollout.eligible && settings.realtimeAllowed) && !loading && !busy && !needsReview);
  async function save() {
    if (!canSave || action.current || !settings || !mode || !activeRef.current) return;
    action.current = true; const version = ++request.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = parse(await api("x-processing-settings", "PUT", { mode, expectedMode: settings.requestedMode }));
      if (!alive.current || !activeRef.current || version !== request.current) return;
      setSettings(saved); setMode(saved.requestedMode); setNeedsReview(false); setNotice("通知のタイミングを保存しました。");
    } catch (cause) {
      if (alive.current && activeRef.current && version === request.current) { setNeedsReview(true); setError(feedback(cause)); }
    } finally {
      action.current = false;
      if (alive.current) {
        setBusy(false);
        // Returning to this panel while its save is still in flight must read
        // the committed state after completion; it must not reuse an old CAS.
        if (activeRef.current && version !== request.current) void load();
      }
    }
  }
  if (compact) return <section aria-label="X通知のタイミング" className="notification-x nx-compact-status"><header><Clock3 size={17} aria-hidden="true" /><h3>通知のタイミング</h3></header>
    {settings && (loading || error) ? <p role={error ? "alert" : "status"}>{error ? "最新の設定を確認できませんでした。前回確認した内容を表示しています。接続と設定の画面で再確認できます。" : "最新の設定を確認中です。前回確認した内容を表示しています。"}</p> : null}
    {settings ? <><strong>{loading || error ? "前回確認時：" : ""}{!settings.rollout.eligible ? "受付資格を確認中" : settings.effectiveMode === "realtime" ? "リアルタイム" : settings.intervalMinutes === null ? "間隔の設定待ち" : `${settings.intervalMinutes}分ごとにまとめて通知`}</strong>
      {settings.requestedMode === "realtime" && settings.effectiveMode !== "realtime" ? <p>リアルタイムの希望は保存済みです。現在は契約プランの間隔を適用しています。</p> : null}</> : <p role={error ? "alert" : "status"}>{error ? "通知のタイミングを再確認してください。監視設定は引き続き使えます。" : "通知のタイミングを確認中…"}</p>}
    <a className="nx-text-link" href="/dashboard/automation/x#x-processing">通知のタイミングを変更<ArrowRight size={14} aria-hidden="true" /></a></section>;
  return <section id="x-processing" aria-label="X通知のタイミング" className="notification-x nx-timing-screen">
    <header className="nx-section-heading"><div><h2>X通知のタイミング</h2></div><Clock3 size={25} aria-hidden="true" /></header>
    {loading ? <p role="status">通知のタイミングを読み込み中…</p> : null}
    {settings ? <>
      <div className="nx-inline-note"><p>現在のプラン：{settings.planLabel}</p><p>現在の通知方法：<strong>{settings.rollout.eligible ? <>{modeName(settings.effectiveMode)}{settings.effectiveMode === "batch" && settings.intervalMinutes !== null ? `（${settings.intervalMinutes}分ごと）` : ""}</> : "支援者向けの受付対象になると利用できます"}</strong></p></div>
      {settings.requestedMode === "realtime" && settings.effectiveMode === "batch" ? <p role="status">リアルタイムの選択は保存されています。現在はプランの間隔を適用し、リアルタイムを利用できるプランになったら、保存した選択を適用します。</p> : null}
      {!settings.configured && settings.effectiveMode === "batch" ? <p role="status">まとめて通知する間隔は、管理者が設定すると適用されます。{settings.realtimeAllowed ? "現在のプランでは、リアルタイムを選んで保存することもできます。" : "受信した通知は、設定が整うまで保持されます。"}</p> : null}
      {!settings.rollout.eligible ? <p role="status">X通知は、現在の受付対象となっている支援者の方へご案内しています。</p> : null}
      <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-3">
        <fieldset disabled={!active || loading || busy} className="space-y-3">
          <legend className="mb-2 font-medium">希望する通知方法</legend>
          <div className="nx-timing-options"><label className="nx-timing-option"><input type="radio" name="x-processing-mode" value="batch" checked={mode === "batch"} onChange={() => { setMode("batch"); setNotice(""); }} /><span><Clock3 size={18} aria-hidden="true" /><strong>プランの間隔でまとめて通知</strong></span></label>
          <label className="nx-timing-option"><input type="radio" name="x-processing-mode" value="realtime" checked={mode === "realtime"} disabled={!settings.realtimeAllowed || !settings.rollout.eligible} onChange={() => { setMode("realtime"); setNotice(""); }} /><span><Zap size={18} aria-hidden="true" /><strong>リアルタイム</strong><small>受信後すぐに通知</small></span></label></div>
          {!settings.realtimeAllowed ? <p className="text-xs text-muted-foreground">リアルタイムは、管理者が対象に設定したプランで選べます。現在のプランでは、プランの間隔でまとめて通知できます。</p> : null}
        </fieldset>
        <button className="nx-primary" type="submit" disabled={!canSave}>{busy ? "保存中…" : "通知のタイミングを保存"}</button>
      </form>
    </> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <button className={button} type="button" disabled={!active || busy || loading} onClick={() => void load(true)}>最新の設定を確認</button>
  </section>;
}
