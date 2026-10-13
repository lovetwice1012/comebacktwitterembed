"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { donationAPI, donationAmount, donationMoney } from "@/components/automation/square-donation-manager";
import { automationRetryDelay } from "@/components/automation/automation-feedback";
import type { DonationPolicy as Policy } from "../../../src/automation/square-donations";

type Draft = { enabled: boolean; currency: string; minimumAmount: string; maximumAmount: string; supporterThreshold: string; validityDays: string };
type PolicyAPI = (path: string, method?: string, body?: unknown) => Promise<any>;
const digits = (currency: string) => { try { return /^[A-Z]{3}$/.test(currency) ? new Intl.NumberFormat("ja-JP", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2 : null; } catch { return null; } };
const draftOf = (policy: Policy): Draft => {
  const scale = digits(policy.currency ?? "") ?? 0;
  const amount = (value: number | null) => value === null ? "" : (value / 10 ** scale).toFixed(scale);
  return { enabled: policy.enabled, currency: policy.currency ?? "", minimumAmount: amount(policy.minimumAmount), maximumAmount: amount(policy.maximumAmount), supporterThreshold: amount(policy.supporterThreshold), validityDays: policy.validityDays === null ? "" : String(policy.validityDays) };
};
const policyFrom = (data: any): Policy => data.policy ?? data.item ?? data;
const period = (days: number | null) => days === null ? "全期間（期限なし）" : `過去${days}日間`;
const settingMoney = (value: number | null, currency: string | null) => value === null ? "未設定" : donationMoney(value, currency);

export function DonationPolicyManager({ api = donationAPI }: { api?: PolicyAPI }) {
  const [baseline, setBaseline] = useState<Policy | null>(null), [draft, setDraft] = useState<Draft | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null), [locationCurrency, setLocationCurrency] = useState<string | null>(null);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [conflict, setConflict] = useState(false), [confirmation, setConfirmation] = useState<{ version: number | null } | null>(null);
  const mounted = useRef(true), version = useRef(0), actionLock = useRef(false);
  async function load() {
    const current = ++version.current; setLoading(true); setError("");
    try {
      const data = await api("policy"), next = policyFrom(data);
      if (!mounted.current || current !== version.current) return;
      setBaseline(next); setDraft(previous => previous ?? draftOf(next)); setConflict(false); setConfirmation(null);
      setConfigured(typeof data.configured === "boolean" ? data.configured : null); setLocationCurrency(typeof data.locationCurrency === "string" ? data.locationCurrency : null);
    } catch { if (mounted.current && current === version.current) setError("寄付の設定を取得できませんでした。入力内容を保持して再試行できます。"); }
    finally { if (mounted.current && current === version.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; version.current++; }; }, [api]);
  const scale = draft ? digits(draft.currency) : null;
  const minimum = draft && scale !== null ? donationAmount(draft.minimumAmount, scale) : null;
  const maximum = draft && scale !== null ? donationAmount(draft.maximumAmount, scale) : null;
  const threshold = draft && scale !== null && draft.supporterThreshold !== "" ? donationAmount(draft.supporterThreshold, scale) : null;
  const validPeriod = Boolean(draft && (draft.validityDays === "" || /^\d+$/.test(draft.validityDays) && Number.isSafeInteger(Number(draft.validityDays)) && Number(draft.validityDays) >= 1 && Number(draft.validityDays) <= 36500));
  const valid = Boolean(configured !== false && draft && scale !== null && validPeriod && (draft.supporterThreshold === "" || threshold !== null && threshold <= 1000000000) && (draft.minimumAmount === "" || minimum !== null && minimum <= 1000000000) && (draft.maximumAmount === "" || maximum !== null && maximum <= 1000000000) && (minimum === null || maximum === null || maximum >= minimum) && (!draft.enabled || minimum !== null && maximum !== null));
  const changed = Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(draftOf(baseline)));
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(previous => previous ? { ...previous, [key]: value } : previous); setConfirmation(null); setMessage(""); }
  async function save() {
    if (actionLock.current || !valid || !draft || !baseline || !confirmation || confirmation.version !== baseline.updatedAtMs || conflict || loading) return;
    actionLock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const next = policyFrom(await api("policy", "PATCH", { enabled: draft.enabled, currency: draft.currency, minimumAmount: minimum, maximumAmount: maximum, supporterThreshold: threshold, validityDays: draft.validityDays === "" ? null : Number(draft.validityDays), expectedUpdatedAtMs: baseline.updatedAtMs }));
      if (mounted.current) { setBaseline(next); setDraft(draftOf(next)); setConfirmation(null); setConflict(false); setMessage("寄付の受付設定を保存しました。確定済みの寄付と現在の条件から支援者枠を判定します。"); }
    } catch (cause: any) {
      if (!mounted.current) return;
      const stale = cause?.status === 409 || cause?.code === "SQUARE_DONATION_POLICY_CONFLICT"; setConflict(stale); setConfirmation(null);
      setError(stale ? "ほかの管理者による変更があります。最新の設定を再取得し、保持された入力内容と比較してから保存してください。" : automationRetryDelay(cause) !== null ? cause.message : "寄付の設定を保存できませんでした。入力内容を保持しています。設定を確認して再試行してください。");
    } finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-label="Square寄付・支援者枠の設定" className="space-y-4 rounded-xl border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Square寄付・支援者枠</h2><p className="mt-1 text-sm text-muted-foreground">1回ごとの寄付受付と、支援者枠の自動適用条件を設定します。</p></div><Button type="button" variant="outline" disabled={loading || busy} onClick={() => void load()}>{conflict ? "最新の寄付設定を再取得" : "寄付設定を更新"}</Button></div>
    {loading ? <p role="status" className="text-sm">寄付の設定を読み込み中…</p> : null}
    {configured === false ? <p role="status" className="rounded-lg bg-muted/30 p-3 text-sm">専用Squareアプリのサーバー設定が未完了です。連携設定後に寄付の受付条件を保存できます。</p> : locationCurrency ? <p className="text-sm text-muted-foreground">Square店舗の通貨: {locationCurrency}</p> : null}
    {baseline && draft ? <form noValidate className="space-y-4" onSubmit={event => { event.preventDefault(); if (valid && changed && !loading && !busy && !conflict) { setConfirmation({ version: baseline.updatedAtMs }); setError(""); setMessage(""); } }}>
      <fieldset disabled={busy || loading} className="space-y-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => update("enabled", event.target.checked)} />Squareで寄付を受け付ける</label><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1 text-sm"><span className="block">寄付の通貨</span><Input value={draft.currency} maxLength={3} onChange={event => update("currency", event.target.value.toUpperCase())} placeholder="Squareロケーションの通貨コード" aria-invalid={scale === null} /><span className="block text-xs text-muted-foreground">Squareロケーションと一致する3文字の通貨コード。金額はこの通貨で入力します。</span></label>{([['minimumAmount', '受付の最低金額'], ['maximumAmount', '受付の最高金額'], ['supporterThreshold', '支援者枠を適用する累計額']] as const).map(([key, label]) => <label key={key} className="space-y-1 text-sm"><span className="block">{label}{draft.currency ? `（${draft.currency}）` : ""}</span><Input inputMode={scale ? "decimal" : "numeric"} value={draft[key]} onChange={event => update(key, event.target.value)} placeholder={key === "supporterThreshold" ? "空欄なら自動適用なし" : "受付を有効にする際に入力"} /></label>)}<label className="space-y-1 text-sm"><span className="block">累計の対象期間（日）</span><Input type="number" inputMode="numeric" min={1} max={36500} step={1} value={draft.validityDays} onChange={event => update("validityDays", event.target.value)} aria-invalid={!validPeriod} placeholder="空欄なら全期間" /><span className="block text-xs text-muted-foreground">過去N日間の返金を除く寄付額の合計で判定します。期間を過ぎた寄付は累計から外れます。</span></label></div></fieldset>
      <p className="rounded-lg bg-muted/30 p-3 text-sm">累計額が空欄なら、寄付履歴を記録し、Square寄付による支援者枠の自動適用は行いません。対象期間が空欄なら、全期間の正味寄付額を集計します。通知枠数・送信上限・優先度は上の「支援者枠」で設定します。</p>
      {confirmation !== null ? <section aria-label="寄付設定の変更確認" className="space-y-3 rounded-lg border border-primary/30 p-4"><h3 className="font-medium">寄付設定の変更確認</h3><div className="overflow-x-auto"><table className="w-full min-w-80 text-left text-sm"><thead><tr><th className="py-2">項目</th><th>現在</th><th>保存後</th></tr></thead><tbody><tr><th className="py-1 font-normal">受付状態</th><td>{baseline.enabled ? "受付中" : "停止中"}</td><td>{draft.enabled ? "受付中" : "停止中"}</td></tr><tr><th className="py-1 font-normal">通貨</th><td>{baseline.currency || "未設定"}</td><td>{draft.currency}</td></tr>{([['minimumAmount', '最低金額', minimum], ['maximumAmount', '最高金額', maximum], ['supporterThreshold', '支援者適用の累計額', threshold]] as const).map(([key, label, value]) => <tr key={key}><th className="py-1 font-normal">{label}</th><td>{settingMoney(baseline[key], baseline.currency)}</td><td>{settingMoney(value, draft.currency)}</td></tr>)}<tr><th className="py-1 font-normal">累計の対象期間</th><td>{period(baseline.validityDays)}</td><td>{period(draft.validityDays === "" ? null : Number(draft.validityDays))}</td></tr></tbody></table></div><p className="text-xs text-muted-foreground">返金・期間の経過・設定変更によって、Square寄付による支援者枠の適用状態が変わります。手動で付与した支援者状態は保持されます。</p><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || loading || !valid || confirmation.version !== baseline.updatedAtMs || conflict} onClick={() => void save()}>この寄付設定で保存</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>寄付設定の編集に戻る</Button></div></section> : <Button type="submit" disabled={busy || loading || !valid || !changed || conflict}>寄付設定の変更を確認</Button>}
    </form> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
