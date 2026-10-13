"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { automationResponseError } from "@/components/automation/automation-feedback";

export type NotificationPlanPolicy = {
  tier: "free" | "supporter" | "paid"; planId: string; label: string;
  slotLimit: number; minuteLimit: number; dayLimit: number; priority: number;
  enabled: boolean; isBuiltin: boolean; updatedAtMs: number;
};
export type NotificationPlanAPI = (path: string, method?: string, body?: unknown) => Promise<any>;
type SquareBinding = { planId: string; variationId: string; enabled: boolean; catalogName: string | null; cadence: string | null; amount: number | null; currency: string | null; verifiedAtMs: number | null };
type SquareVariation = { variationId: string; catalogName: string; cadence: string; amount: number; currency: string };
type SquareAdmin = { configured: boolean; environment: string | null; missing: string[]; bindings: SquareBinding[]; availableVariations?: SquareVariation[] };
type BillingState = { data: SquareAdmin | null; loading: boolean; error: string; refresh: () => Promise<void>; saved: (binding: SquareBinding) => void };

export async function notificationPlanAPI(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/automation/${path}`, {
    method, cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw automationResponseError(data, response);
  return data;
}

const numericFields = [
  { key: "slotLimit", label: "通知枠数", minimum: 1, maximum: 10000, unit: "枠" },
  { key: "dayLimit", label: "枠あたりの日次上限", minimum: 1, maximum: 1000000, unit: "通／日" },
  { key: "minuteLimit", label: "枠あたりの分次上限", minimum: 1, maximum: 10000, unit: "通／分" },
  { key: "priority", label: "処理の優先度", minimum: 0, maximum: 100, unit: "" },
] as const;
type Draft = { planId: string; label: string; slotLimit: string; dayLimit: string; minuteLimit: string; priority: string; enabled: boolean };
const draftOf = (plan?: NotificationPlanPolicy): Draft => ({
  planId: plan?.planId ?? "", label: plan?.label ?? "", slotLimit: plan ? String(plan.slotLimit) : "",
  dayLimit: plan ? String(plan.dayLimit) : "", minuteLimit: plan ? String(plan.minuteLimit) : "",
  priority: plan ? String(plan.priority) : "", enabled: plan?.enabled ?? true,
});
const validNumber = (value: string, minimum: number, maximum: number) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
const tierName = { free: "無料枠", supporter: "支援者枠", paid: "有償プラン" };

function PlanEditor({ plan, api, billing, onSaved, onCancel }: { plan?: NotificationPlanPolicy; api: NotificationPlanAPI; billing: BillingState; onSaved: (plan: NotificationPlanPolicy) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState(() => draftOf(plan));
  const baseline = plan;
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false);
  const [confirmedVersion, setConfirmedVersion] = useState<number | null>(null);
  const [error, setError] = useState(""), [conflict, setConflict] = useState(false), [status, setStatus] = useState("");
  const validId = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(draft.planId) && (baseline || !["free", "supporter"].includes(draft.planId.toLowerCase()));
  const validLabel = draft.label.trim().length > 0 && draft.label.trim().length <= 120;
  const valid = validId && validLabel && numericFields.every(field => validNumber(draft[field.key], field.minimum, field.maximum));
  const changed = !baseline || JSON.stringify(draft) !== JSON.stringify(draftOf(baseline));
  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(previous => ({ ...previous, [key]: value })); setConfirming(false); setStatus("");
  }
  async function save() {
    if (!valid || !confirming || busy || conflict || confirmedVersion !== (baseline?.updatedAtMs ?? 0)) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const body = {
        planId: draft.planId, label: draft.label.trim(), slotLimit: Number(draft.slotLimit), dayLimit: Number(draft.dayLimit),
        minuteLimit: Number(draft.minuteLimit), priority: Number(draft.priority), enabled: baseline?.isBuiltin ? true : draft.enabled,
        expectedUpdatedAtMs: baseline?.updatedAtMs ?? 0,
      };
      const saved = await api(baseline ? `plans/${encodeURIComponent(baseline.planId)}` : "plans", baseline ? "PATCH" : "POST", body);
      const next: NotificationPlanPolicy = saved.item ?? saved;
      setDraft(draftOf(next)); setConfirming(false); setConflict(false); setStatus("保存しました。次の登録・送信から適用されます。"); onSaved(next);
    } catch (cause: any) {
      const stale = cause?.status === 409 || cause?.code === "AUTOMATION_PLAN_CONFLICT";
      setConflict(stale); setConfirming(false);
      setError(stale ? "ほかの管理者による変更があります。最新の設定を再取得し、入力内容と比較してから保存してください。入力内容は保持されています。" : cause instanceof Error ? cause.message : "保存できませんでした。入力内容は保持されています。");
    } finally { setBusy(false); }
  }
  async function reloadBaseline() {
    setBusy(true); setError("");
    try {
      const data = await api("plans");
      const latest = (data.items as NotificationPlanPolicy[]).find(item => item.planId === draft.planId);
      if (!latest) throw new Error("プランを再取得できませんでした。入力内容を保持して再試行できます。");
      onSaved(latest); setConflict(false); setConfirming(false);
      setStatus("最新の設定を再取得しました。入力内容を保持しています。変更内容をもう一度確認してください。");
    } catch { setError("最新の設定を再取得できませんでした。入力内容を保持して再試行できます。"); }
    finally { setBusy(false); }
  }
  return <article aria-label={`${baseline?.label ?? "新しい有償プラン"}の通知設定`} className="space-y-4 rounded-xl border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs text-muted-foreground">{baseline ? tierName[baseline.tier] : "有償プランを追加"}</p><h2 className="mt-1 text-lg font-semibold">{baseline?.label ?? "新しい有償プラン"}</h2></div>{baseline?.isBuiltin ? <span className="rounded-full bg-muted px-3 py-1 text-xs">常に有効</span> : null}</div>
    <form noValidate className="space-y-4" onSubmit={event => { event.preventDefault(); if (valid && changed && !busy && !conflict) { setConfirming(true); setConfirmedVersion(baseline?.updatedAtMs ?? 0); setError(""); setStatus(""); } }}>
      <fieldset disabled={busy} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {!baseline ? <label className="space-y-1 text-sm"><span className="block">プランID</span><Input value={draft.planId} maxLength={64} onChange={event => update("planId", event.target.value)} aria-invalid={Boolean(draft.planId) && !validId} placeholder="英字から始まる識別子" /><span className="block text-xs text-muted-foreground">英数字・ハイフン・アンダースコア、64文字以内。作成後は変更できません。</span></label> : null}
          <label className="space-y-1 text-sm"><span className="block">表示名</span><Input value={draft.label} maxLength={120} onChange={event => update("label", event.target.value)} aria-invalid={!validLabel} placeholder="利用者に表示する名前" /></label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{numericFields.map(field => <label key={field.key} className="space-y-1 text-sm"><span className="block">{field.label}</span><div className="flex items-center gap-2"><Input type="number" inputMode="numeric" step={1} min={field.minimum} max={field.maximum} value={draft[field.key]} onChange={event => update(field.key, event.target.value)} aria-invalid={!validNumber(draft[field.key], field.minimum, field.maximum)} /><span className="shrink-0 text-xs text-muted-foreground">{field.unit}</span></div><span className="block text-xs text-muted-foreground">{field.minimum.toLocaleString("ja-JP")}〜{field.maximum.toLocaleString("ja-JP")}の整数</span></label>)}</div>
        {!baseline?.isBuiltin ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => update("enabled", event.target.checked)} />プランを有効にする</label> : null}
      </fieldset>
      {confirming ? <section aria-label="変更内容の確認" className="space-y-3 rounded-lg border border-primary/30 bg-muted/30 p-4">
        <h3 className="font-medium">変更内容の確認</h3>
        <div className="overflow-x-auto"><table className="w-full min-w-80 text-left text-sm"><thead><tr><th className="py-2">項目</th><th className="py-2">現在</th><th className="py-2">保存後</th></tr></thead><tbody>
          <tr><th className="py-1 font-normal">表示名</th><td>{baseline?.label ?? "未作成"}</td><td className="font-medium">{draft.label.trim()}</td></tr>
          {numericFields.map(field => <tr key={field.key}><th className="py-1 font-normal">{field.label}</th><td>{baseline?.[field.key] ?? "未設定"}</td><td className="font-medium">{Number(draft[field.key])}{field.unit}</td></tr>)}
          {!baseline?.isBuiltin ? <tr><th className="py-1 font-normal">状態</th><td>{baseline ? baseline.enabled ? "有効" : "無効" : "未作成"}</td><td>{draft.enabled ? "有効" : "無効"}</td></tr> : null}
        </tbody></table></div>
        <p className="text-xs text-muted-foreground">上限を下げても登録済み通知と送信件数は保持されます。枠を超えた通知は送信・再開が制限され、停止・削除できます。</p>
        {confirmedVersion !== (baseline?.updatedAtMs ?? 0) ? <p role="alert" className="text-sm text-destructive">現在の設定が更新されました。編集に戻り、変更内容をもう一度確認してください。</p> : null}
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || confirmedVersion !== (baseline?.updatedAtMs ?? 0)} onClick={() => void save()}>{busy ? "保存中…" : "この内容で保存"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>編集に戻る</Button></div>
      </section> : <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || !valid || !changed || conflict}>変更内容を確認</Button>{onCancel ? <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>追加を取り消す</Button> : null}</div>}
    </form>
    {error ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p>{conflict ? <Button type="button" variant="outline" disabled={busy} onClick={() => void reloadBaseline()}>最新の設定を再取得</Button> : null}</div> : null}
    {status ? <p role="status" className="text-sm">{status}</p> : null}
    {baseline?.tier === "paid" ? <SquarePlanBinding plan={baseline} api={api} billing={billing} /> : null}
  </article>;
}

function squarePrice(binding: Pick<SquareBinding, "amount" | "currency">) {
  if (binding.amount == null || !Number.isSafeInteger(binding.amount) || !/^[A-Z]{3}$/.test(binding.currency ?? "")) return "未検証";
  try {
    const format = new Intl.NumberFormat("ja-JP", { style: "currency", currency: binding.currency! });
    return format.format(binding.amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return "未検証"; }
}
function SquarePlanBinding({ plan, api, billing }: { plan: NotificationPlanPolicy; api: NotificationPlanAPI; billing: BillingState }) {
  const binding = billing.data?.bindings.find(item => item.planId === plan.planId);
  const [draft, setDraft] = useState<{ variationId: string; enabled: boolean } | null>(null);
  const value = draft ?? { variationId: binding?.variationId ?? "", enabled: binding?.enabled ?? true };
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("");
  const valid = /^[A-Za-z0-9:_-]{1,255}$/.test(value.variationId.trim());
  const configured = billing.data?.configured === true;
  const available = billing.data?.availableVariations ?? [];
  const changed = value.variationId.trim() !== (binding?.variationId ?? "") || value.enabled !== (binding?.enabled ?? true);
  async function save() {
    if (!configured || !valid || !confirming || busy) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const saved: SquareBinding = await api(`billing/bindings/${encodeURIComponent(plan.planId)}`, "PATCH", { variationId: value.variationId.trim(), enabled: value.enabled });
      billing.saved(saved); setDraft(null); setConfirming(false); setStatus("Squareの料金・請求周期を確認し、プランを紐付けました。");
    } catch (cause) { setConfirming(false); setError(cause instanceof Error ? cause.message : "Squareプランを紐付けできませんでした。入力内容は保持されています。"); }
    finally { setBusy(false); }
  }
  return <section aria-label={`${plan.label}のSquare連携`} className="space-y-3 border-t pt-4">
    <h3 className="text-sm font-medium">Squareサブスクリプション</h3>
    <p className="text-sm text-muted-foreground">料金と請求周期はSquareで設定したサブスクリプションプランを使います。保存時にSquareで現在の内容を検証します。</p>
    {billing.loading ? <p role="status" className="text-sm">Square連携を確認中…</p> : null}
    {binding ? <dl className="grid gap-2 rounded-lg bg-muted/30 p-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Squareプラン</dt><dd className="break-words font-medium">{binding.catalogName || "名称未取得"}</dd></div><div><dt className="text-muted-foreground">料金・請求周期</dt><dd>{squarePrice(binding)} · {({ MONTHLY: "月ごと", ANNUAL: "年ごと", WEEKLY: "週ごと", DAILY: "日ごと" } as Record<string, string>)[binding.cadence ?? ""] ?? binding.cadence ?? "周期未取得"}</dd></div><div><dt className="text-muted-foreground">購入受付</dt><dd>{binding.enabled ? "有効" : "停止中"}</dd></div><div><dt className="text-muted-foreground">最終確認</dt><dd>{binding.verifiedAtMs ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(binding.verifiedAtMs) + " JST" : "未確認"}</dd></div></dl> : <p className="text-sm">Squareプランの紐付けは未設定です。</p>}
    {!configured && !billing.loading && !billing.error ? <p className="text-sm text-muted-foreground">サーバー側のSquare設定が未完了です。接続設定を完了すると紐付けできます。</p> : null}
    <form noValidate className="space-y-3" onSubmit={event => { event.preventDefault(); if (configured && valid && changed && !busy) { setConfirming(true); setError(""); setStatus(""); } }}>
      <fieldset disabled={!configured || busy} className="space-y-3">
        {available.length ? <label className="block max-w-xl space-y-1 text-sm"><span className="block">Squareのプランから選ぶ</span><select className="h-10 w-full rounded-md border bg-card px-3 text-sm" value={available.some(item => item.variationId === value.variationId) ? value.variationId : ""} onChange={event => { if (event.target.value) { setDraft({ ...value, variationId: event.target.value }); setConfirming(false); setStatus(""); } }}><option value="">プランを選択</option>{available.map(item => <option key={item.variationId} value={item.variationId}>{item.catalogName} · {squarePrice(item)} · {({ MONTHLY: "月ごと", ANNUAL: "年ごと", WEEKLY: "週ごと", DAILY: "日ごと" } as Record<string, string>)[item.cadence] ?? item.cadence}</option>)}</select></label> : null}
        <label className="block max-w-xl space-y-1 text-sm"><span className="block">SquareプランバリエーションID</span><Input value={value.variationId} maxLength={255} onChange={event => { setDraft({ ...value, variationId: event.target.value }); setConfirming(false); setStatus(""); }} aria-invalid={Boolean(value.variationId) && !valid} placeholder="Squareで作成したプランのID" /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} onChange={event => { setDraft({ ...value, enabled: event.target.checked }); setConfirming(false); setStatus(""); }} />このSquareプランの購入を受け付ける</label>
      </fieldset>
      {confirming ? <div aria-label="Square紐付けの確認" className="space-y-3 rounded-lg border bg-muted/30 p-3"><p className="break-words text-sm">{plan.label}に {value.variationId.trim()} を紐付け、購入受付を{value.enabled ? "有効" : "停止"}にします。料金・請求周期はSquare側の現在の設定を使います。</p><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "確認・保存中…" : "Squareで検証して紐付け"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>紐付けの編集に戻る</Button></div></div> : <Button type="submit" variant="outline" disabled={!configured || busy || !valid || !changed}>紐付け内容を確認</Button>}
    </form>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{status ? <p role="status" className="text-sm">{status}</p> : null}
  </section>;
}

export function NotificationPlanManager({ api = notificationPlanAPI }: { api?: NotificationPlanAPI }) {
  const [items, setItems] = useState<NotificationPlanPolicy[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [creating, setCreating] = useState(false);
  const [billingData, setBillingData] = useState<SquareAdmin | null>(null), [billingLoading, setBillingLoading] = useState(true), [billingError, setBillingError] = useState("");
  const request = useRef(0), alive = useRef(true);
  const billingRequest = useRef(0);
  async function load() {
    const version = ++request.current; setLoading(true); setError("");
    try { const data = await api("plans"); if (alive.current && version === request.current) setItems(data.items); }
    catch (cause) { if (alive.current && version === request.current) setError(cause instanceof Error ? cause.message : "通知プランを読み込めませんでした。"); }
    finally { if (alive.current && version === request.current) setLoading(false); }
  }
  async function loadBilling() {
    const version = ++billingRequest.current; setBillingLoading(true); setBillingError("");
    try { const data = await api("billing/admin"); if (alive.current && version === billingRequest.current) setBillingData(data); }
    catch (cause) { if (alive.current && version === billingRequest.current) setBillingError(cause instanceof Error ? cause.message : "Square連携の状態を取得できませんでした。"); }
    finally { if (alive.current && version === billingRequest.current) setBillingLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); void loadBilling(); return () => { alive.current = false; request.current++; billingRequest.current++; }; }, [api]);
  function saved(plan: NotificationPlanPolicy) { setItems(previous => [...previous.filter(item => item.planId !== plan.planId), plan].sort((a, b) => (a.isBuiltin ? a.planId === "free" ? 0 : 1 : 2) - (b.isBuiltin ? b.planId === "free" ? 0 : 1 : 2) || a.planId.localeCompare(b.planId))); }
  const billing: BillingState = { data: billingData, loading: billingLoading, error: billingError, refresh: loadBilling, saved: binding => setBillingData(previous => previous ? { ...previous, bindings: [...previous.bindings.filter(item => item.planId !== binding.planId), binding] } : previous) };
  return <div className="space-y-5">
    <section className="space-y-2 rounded-xl bg-muted/40 p-4 text-sm"><p>ユーザーごとの通知枠と、1枠あたりの送信件数を設定します。新着・価格通知で枠を共有し、停止中の登録も1枠を使います。</p><p className="text-muted-foreground">実際に送信したメッセージ1件＝1通。分割送信は通数を加算し、日次件数は日本時間の0時にリセットします。優先度は0が通常で、値が大きいプランほど先に処理します。</p></section>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">無料枠・支援者枠は無効にできません。</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={loading} onClick={() => void load()}>設定を更新</Button><Button type="button" disabled={creating || loading || Boolean(error)} onClick={() => setCreating(true)}>有償プランを追加</Button></div></div>
    {loading ? <p role="status" className="text-sm">通知プランを読み込み中…</p> : null}
    {error ? <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 p-4 text-sm"><p>{error}</p><Button type="button" variant="outline" onClick={() => void load()}>読み込みを再試行</Button></div> : null}
    <section aria-label="Square連携の状態" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm"><div><p className="font-medium">Square連携: {billingLoading ? "確認中" : billingData?.configured ? billingData.environment === "production" ? "本番環境" : "サンドボックス" : "未設定"}</p>{billingError ? <p role="alert" className="mt-1 text-destructive">{billingError}</p> : null}<p className="mt-1 text-muted-foreground">有償プランのサブスクリプション料金・請求周期はSquare側で管理します。</p>{billingData && !billingData.configured && billingData.missing.length ? <details className="mt-2 text-muted-foreground"><summary className="cursor-pointer">接続に必要な設定</summary><ul className="mt-2 list-inside list-disc">{billingData.missing.map(key => <li key={key}>{({ SQUARE_ENVIRONMENT: "Squareの接続環境が未設定、または不正です。", SQUARE_ACCESS_TOKEN: "Squareの接続トークンが未設定です。", SQUARE_APPLICATION_ID: "SquareのアプリケーションIDが未設定、または不正です。", SQUARE_LOCATION_ID: "Squareの店舗IDが未設定、または不正です。", SQUARE_MERCHANT_ID: "Squareの加盟店IDが未設定、または不正です。", SQUARE_WEBHOOK_SIGNATURE_KEY: "Webhookの署名キーが未設定です。", SQUARE_WEBHOOK_NOTIFICATION_URL: "Webhookの通知先URLが未設定、または不正です。" } as Record<string, string>)[key] ?? "Squareのサーバー設定に不足があります。"}</li>)}</ul></details> : null}</div><Button type="button" variant="outline" disabled={billingLoading} onClick={() => void loadBilling()}>Square連携を再確認</Button></section>
    {items.map(plan => <PlanEditor key={plan.planId} plan={plan} api={api} billing={billing} onSaved={saved} />)}
    {creating ? <PlanEditor key="new-plan" api={api} billing={billing} onSaved={plan => { saved(plan); setCreating(false); }} onCancel={() => setCreating(false)} /> : null}
  </div>;
}
