"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, Clock3, Layers3, RefreshCw } from "lucide-react";
import { parseXQuota, type XMonitorQuota } from "./x-monitor-view";
import "./notification-billing.css";

type UsageAPI = (path: string) => Promise<unknown>;
type Entitlements = { plan: { name: string; baseSlotLimit: number; slotLimit: number; dayLimit: number; minuteLimit: number };
  slots: { used: number; max: number; available: number }; registered: number | null };
type Processing = { planLabel: string; effectiveMode: "batch" | "realtime"; requestedMode: "batch" | "realtime";
  intervalMinutes: number | null; configured: boolean; realtimeAllowed: boolean; eligible: boolean };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unavailable usage");
  return value as Record<string, unknown>;
};
const count = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Unavailable usage"); return Number(value); };
const label = (value: unknown): string => { if (typeof value !== "string" || !value.trim() || value.length > 120) throw new Error("Unavailable usage"); return value; };
function parseEntitlements(value: unknown): Entitlements {
  const data = object(value), plan = object(data.plan), slots = object(data.slots);
  if (count(plan.slotLimit) < count(plan.baseSlotLimit)) throw new Error("Unavailable usage");
  return { plan: { name: label(plan.name), baseSlotLimit: count(plan.baseSlotLimit), slotLimit: count(plan.slotLimit), dayLimit: count(plan.dayLimit), minuteLimit: count(plan.minuteLimit) },
    slots: { used: count(slots.used), max: count(slots.max), available: count(slots.available) },
    registered: data.usage && Array.isArray(object(data.usage).entries) ? (object(data.usage).entries as unknown[]).length : null };
}
function parseProcessing(value: unknown): Processing {
  const data = object(value), rollout = object(data.rollout);
  if (!["batch", "realtime"].includes(String(data.effectiveMode)) || !["batch", "realtime"].includes(String(data.requestedMode))
    || typeof data.configured !== "boolean" || typeof data.realtimeAllowed !== "boolean" || typeof rollout.eligible !== "boolean"
    || data.intervalMinutes !== null && (!Number.isSafeInteger(data.intervalMinutes) || Number(data.intervalMinutes) < 5 || Number(data.intervalMinutes) > 10080)
    || data.effectiveMode === "realtime" && !data.realtimeAllowed || data.configured && data.effectiveMode === "batch" && data.intervalMinutes === null) throw new Error("Unavailable processing");
  return { planLabel: label(data.planLabel), effectiveMode: data.effectiveMode as Processing["effectiveMode"], requestedMode: data.requestedMode as Processing["requestedMode"],
    configured: data.configured, realtimeAllowed: data.realtimeAllowed, eligible: rollout.eligible, intervalMinutes: data.intervalMinutes as number | null };
}
export async function notificationUsageAPI(path: string): Promise<unknown> {
  const response = await fetch(`/api/automation/${path}`, { method: "GET", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Unavailable account usage");
  return response.json();
}

/** Display only owner-scoped server results. A failed read never becomes zero. */
export function NotificationUsageOverview({ api = notificationUsageAPI }: { api?: UsageAPI }) {
  const [normal, setNormal] = useState<Entitlements | null>(null), [quota, setQuota] = useState<XMonitorQuota | null>(null), [processing, setProcessing] = useState<Processing | null>(null);
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false);
  const alive = useRef(false), epoch = useRef(0);
  const load = useCallback(async () => {
    const version = ++epoch.current; setLoading(true);
    const results = await Promise.allSettled([api("entitlements").then(parseEntitlements), api("x-monitor-quota").then(parseXQuota), api("x-processing-settings").then(parseProcessing)]);
    if (!alive.current || version !== epoch.current) return;
    setNormal(results[0].status === "fulfilled" ? results[0].value : null);
    setQuota(results[1].status === "fulfilled" ? results[1].value : null);
    setProcessing(results[2].status === "fulfilled" ? results[2].value : null);
    setFailed(results.some(result => result.status === "rejected")); setLoading(false);
  }, [api]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; epoch.current++; }; }, [load]);
  useEffect(() => { const refresh = () => { void load(); }; window.addEventListener("notification:usage-changed", refresh); return () => window.removeEventListener("notification:usage-changed", refresh); }, [load]);
  const total = normal?.slots.max ?? quota?.personal.totalLimit;
  const used = normal?.slots.used ?? quota?.personal.used;
  const available = normal?.slots.available ?? quota?.personal.available;
  const registered = quota?.personal.registeredCount ?? normal?.registered;
  const boost = used !== undefined && registered != null && used >= registered ? used - registered : null;
  const extras = normal ? Math.max(0, normal.plan.slotLimit - normal.plan.baseSlotLimit) : quota?.personal.supporterExtraSlots;
  const specialAvailable = quota ? Math.max(0, quota.x.specialLimit - quota.x.specialUsed) : null;
  const unavailable = "確認待ち";
  const metric = (value: number | null | undefined, unit = "枠") => value == null ? unavailable : `${value}${unit}`;
  const xTiming = processing ? !processing.eligible ? "受付資格を確認してください" : !processing.configured ? "管理者の間隔設定待ち"
    : processing.effectiveMode === "realtime" ? "リアルタイム" : `${processing.intervalMinutes}分ごとにまとめて通知` : unavailable;
  return <section className="notification-usage" aria-label="ご利用中の機能と利用枠" aria-busy={loading}>
    <div className="notification-section-heading"><h2>利用状況</h2>
      <button type="button" className="notification-text-action" disabled={loading} onClick={() => void load()}><RefreshCw size={15} aria-hidden />利用状況を更新</button></div>
    {loading ? <p role="status" className="notification-inline-status">利用状況を読み込み中…</p> : null}
    {failed ? <p role="status" className="notification-inline-status">一部の利用状況は確認待ちです。表示できた情報を残しています。「利用状況を更新」から再確認できます。</p> : null}
    <div className="notification-usage-grid">
      <article className="notification-usage-primary"><div className="notification-card-heading"><Layers3 size={19} aria-hidden /><h3>通知の登録枠</h3></div>
        <p className="notification-usage-value">{used ?? "—"}<span> / {total ?? "—"} 枠使用</span></p>
        <div className="notification-usage-track" role="img" aria-label={used !== undefined && total !== undefined ? `${total}枠のうち${used}枠使用` : "使用枠は確認待ち"}><span style={{ width: `${used !== undefined && total ? Math.min(100, used / total * 100) : 0}%` }} /></div>
        <dl className="notification-usage-facts"><div><dt>新しく使える枠</dt><dd>{metric(available)}</dd></div><div><dt>登録している通知</dt><dd>{metric(registered, "件")}</dd></div>
          <div><dt>通知方法に使う追加枠</dt><dd>{metric(boost)}</dd></div><div><dt>支援による恒久追加</dt><dd>{metric(extras)}</dd></div></dl>
        <p className="notification-card-note">通常通知とX監視の共通枠です。停止中の登録、確認間隔の短縮、Xの5枠リアルタイム利用も含みます。</p>
        {extras !== undefined ? <p className="notification-card-note">{normal?.plan.baseSlotLimit ?? quota?.currentPlan.baseSlotLimit}枠の基本枠に、保有する支援追加{extras}枠を加えています。支援追加枠は月額プランの解約後も引き継ぎます。</p> : null}
      </article>
      <article className="notification-usage-card"><div className="notification-card-heading"><Bell size={19} aria-hidden /><h3>通常通知のプラン</h3></div>
        <p className="notification-plan-name">{normal?.plan.name ?? unavailable}</p>
        {normal ? <p className="notification-card-note">1枠あたり1日{normal.plan.dayLimit}通・1分{normal.plan.minuteLimit}通まで。</p> : null}
        <a className="notification-inline-link" href="/dashboard/automation">通知を管理する<ArrowRight size={15} aria-hidden /></a>
      </article>
      <article className="notification-usage-card"><div className="notification-card-heading"><Clock3 size={19} aria-hidden /><h3>Xの共通設定</h3></div>
        <p className="notification-plan-name">{xTiming}</p><dl className="notification-usage-facts"><div><dt>Xの処理プラン</dt><dd>{processing?.planLabel ?? quota?.currentPlan.label ?? unavailable}</dd></div></dl>
        <p className="notification-card-note">通知方法を個別指定していない既存監視の設定です。リアルタイムの資格と必要枠数は、監視ごとに確認できます。</p>
        {processing?.requestedMode === "realtime" && processing.effectiveMode === "batch" ? <p className="notification-card-note">共通設定のリアルタイム希望は保存済みです。個別の優待・5枠利用は各監視に表示します。</p> : null}
        <a className="notification-inline-link" href="/dashboard/automation#x-notifications">監視ごとの通知方法を選ぶ<ArrowRight size={15} aria-hidden /></a>
      </article>
    </div>
    <div className="notification-x-availability"><h3>X監視の利用状況</h3>
      <dl><div><dt>追加できる監視（1枠利用）</dt><dd>{metric(quota?.x.available, "件")}</dd></div><div><dt>共用無料枠の空き</dt><dd>{quota ? `${quota.pools.free.available} / ${quota.pools.free.limit}枠` : unavailable}</dd></div>
        <div><dt>支援者優先枠の全体空き</dt><dd>{quota ? `${quota.pools.supporter.available} / ${quota.pools.supporter.limit}枠` : unavailable}</dd></div><div><dt>プランの特殊枠の残り</dt><dd>{quota ? `${specialAvailable} / ${quota.x.specialLimit}枠` : unavailable}</dd></div></dl>
    </div>
    {quota?.x.reasonCode === "X_MONITOR_PERSONAL_LIMIT" ? <div className="notification-next-step" role="status"><p>個人の登録枠をすべて使用しています。登録や確認間隔の配分を見直すと、空き枠を確保できます。</p><a href="/dashboard/automation">使用中の通知を確認する<ArrowRight size={16} aria-hidden /></a></div>
      : quota?.x.reasonCode === "X_MONITOR_POOL_FULL" ? <div className="notification-next-step" role="status"><p>X監視に使える全体枠は現在利用中です。個人の登録枠はそのまま利用できます。</p><a href="/dashboard/automation/x">Xの受付状況を確認する<ArrowRight size={16} aria-hidden /></a></div>
        : quota?.x.reasonCode === "X_MONITOR_UNAVAILABLE" || quota?.x.reasonCode === "X_ROLLOUT_DISABLED" ? <div className="notification-next-step" role="status"><p>X通知の新規受付は準備中です。登録済みの監視と受信情報は、Xの接続画面で確認できます。</p><a href="/dashboard/automation/x">Xの受付状況を確認する<ArrowRight size={16} aria-hidden /></a></div>
          : quota?.x.reasonCode?.startsWith("X_ROLLOUT_") || processing && !processing.eligible ? <div className="notification-next-step" role="status"><p>X通知は現在の受付対象となっている方へご案内しています。参加資格と利用枠は別に確認します。</p><a href="/dashboard/automation/x">このアカウントの受付資格を確認する<ArrowRight size={16} aria-hidden /></a></div>
          : processing && !processing.configured ? <div className="notification-next-step" role="status"><p>間隔通知は管理者の間隔設定待ちです。受信データは保持します。リアルタイムは監視ごとの利用資格と必要枠数で判定します。</p><a href="/dashboard/automation#x-notifications">監視ごとの通知方法を選ぶ<ArrowRight size={16} aria-hidden /></a></div> : null}
  </section>;
}
