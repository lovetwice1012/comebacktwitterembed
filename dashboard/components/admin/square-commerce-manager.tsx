"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { automationRetryDelay } from "@/components/automation/automation-feedback";
import { donationAmount, donationMoney } from "@/components/automation/square-donation-manager";
import { subscriptionCadenceLabels as cadenceLabels } from "@/lib/subscription-pricing";
import type { CatalogCreation as Creation, Coupon, createSquareCommerce } from "../../../src/automation/square-commerce";

export type CommerceAPI = (path: string, method?: string, body?: unknown) => Promise<any>;
export type CommercePlan = { planId: string; label: string; tier: "free" | "supporter" | "paid"; enabled: boolean };
type Admin = Awaited<ReturnType<ReturnType<typeof createSquareCommerce>["getAdmin"]>>;
const moneyDigits = (currency: string) => { try { return /^[A-Z]{3}$/.test(currency) ? new Intl.NumberFormat("ja-JP", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2 : null; } catch { return null; } };
const positiveInteger = (value: string) => value.length <= 16 && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const dateLabel = (value: number | null) => value === null ? "期限なし" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(value) + " JST";
const dateInput = (value: number | null) => value === null ? "" : new Date(value + 9 * 60 * 60 * 1000).toISOString().slice(0, 16);
export function couponExpiry(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}:00+09:00`);
  return Number.isFinite(timestamp) && dateInput(timestamp) === value ? timestamp : null;
}
function errorMessage(cause: any, fallback: string) { return automationRetryDelay(cause) !== null ? cause.message : fallback; }

export function SquareCatalogCreator({ plan, configured, api, onCreated, occupiedCadences = [] }: { plan: CommercePlan; configured: boolean; api: CommerceAPI; onCreated: () => Promise<void>; occupiedCadences?: string[] }) {
  const [opened, setOpened] = useState(false), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [name, setName] = useState(plan.label), [amount, setAmount] = useState(""), [currency, setCurrency] = useState(""), [cadence, setCadence] = useState(""), [storeCurrency, setStoreCurrency] = useState<string | null>(null);
  const [creation, setCreation] = useState<Creation | null>(null), [consent, setConsent] = useState(false);
  const actionLock = useRef(false);
  const digits = moneyDigits(currency), minorAmount = digits === null ? null : donationAmount(amount, digits);
  const valid = Boolean(name.trim() && name.trim().length <= 120 && minorAmount !== null && minorAmount <= 1000000000 && cadenceLabels[cadence] && !occupiedCadences.includes(cadence) && (!storeCurrency || currency === storeCurrency));
  async function open() {
    if (actionLock.current) return; setOpened(true); actionLock.current = true; setBusy(true); setError("");
    try {
      const data: Admin = await api("billing/commerce/admin"); setStoreCurrency(data.locationCurrency ?? null); setCurrency(previous => previous || data.locationCurrency || ""); setLoaded(true);
      const pending = data.creations.find(item => item.planId === plan.planId && (["UNKNOWN", "SUBMITTING"].includes(item.state) || item.state === "QUOTED" && item.expiresAtMs > Date.now()));
      if (pending) { setCreation(pending); setConsent(false); }
    } catch (cause) { setError(errorMessage(cause, "Squareの作成状態を取得できませんでした。入力内容を保持しています。再確認してください。")); }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function review() {
    if (actionLock.current || !loaded || !valid || !configured || !plan.enabled || creation) return;
    actionLock.current = true; setBusy(true); setError(""); setMessage("");
    try { const next: Creation = await api("billing/catalog/quote", "POST", { planId: plan.planId, name: name.trim(), amount: minorAmount, currency, cadence }); setCreation(next); setConsent(false); }
    catch (cause) { setError(errorMessage(cause, "Square料金プランの内容を確認できませんでした。入力内容を保持しています。設定を確認して再試行してください。")); }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function confirm() {
    if (actionLock.current || !creation || !consent || !configured || !(creation.state === "QUOTED" || creation.retryable)) return;
    if (creation.state === "QUOTED" && creation.expiresAtMs <= Date.now()) { setError("作成内容の確認期限が切れました。料金の入力に戻り、内容をもう一度確認してください。"); return; }
    actionLock.current = true; setBusy(true); setError("");
    const previous = creation; setCreation({ ...previous, state: "SUBMITTING", retryable: false });
    try {
      const next: Creation = await api("billing/catalog/create", "POST", { creationId: previous.creationId, consent: true }); setCreation(next);
      if (next.state === "COMPLETE") { setMessage("Square料金プランを作成し、通知プランに紐付けました。新しい契約の受付に利用できます。"); await onCreated(); }
    } catch (cause) { setCreation(current => current?.state === "COMPLETE" ? current : { ...previous, state: "UNKNOWN", retryable: false }); setError(errorMessage(cause, "作成結果を確認できませんでした。新しい作成を始めず、受付状態を確認してください。")); }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function check() {
    if (actionLock.current || !creation) return; actionLock.current = true; setBusy(true); setError("");
    try { const next: Creation = await api(`billing/catalog/${encodeURIComponent(creation.creationId)}`); setCreation(next); if (next.state === "COMPLETE") { setMessage("作成済みのSquare料金プランを確認しました。"); await onCreated(); } }
    catch (cause) { setError(errorMessage(cause, "作成状態を確認できませんでした。新しい作成を始めず、再確認してください。")); }
    finally { actionLock.current = false; setBusy(false); }
  }
  const unresolved = creation && ["UNKNOWN", "SUBMITTING"].includes(creation.state);
  return <section aria-label={`${plan.label}のSquare料金作成`} className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">新しい支払い間隔のSquare料金を作成</h4>{!opened ? <Button type="button" variant="outline" disabled={!configured || !plan.enabled} onClick={() => void open()}>Square料金プランを作成</Button> : null}</div>
    {!plan.enabled ? <p className="text-sm text-muted-foreground">通知プランを有効にしてから、料金プランを作成できます。</p> : null}
    {opened ? <><p className="text-xs text-muted-foreground">月額・年額など、まだ登録していない支払い間隔を追加できます。通知枠・送信上限は保存済みの「{plan.label}」を使います。ここで入力する料金・周期は、作成後の新しいサブスクリプションに適用します。</p>{storeCurrency ? <p className="text-xs text-muted-foreground">Square店舗の通貨: {storeCurrency}</p> : null}
      {!loaded && !busy ? <Button type="button" variant="outline" onClick={() => void open()}>Square作成状態を再確認</Button> : null}
      {!creation ? <form noValidate className="space-y-3" onSubmit={event => { event.preventDefault(); void review(); }}><fieldset disabled={busy || !loaded} className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span className="block">Squareでの料金プラン名</span><Input value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label><label className="space-y-1 text-sm"><span className="block">請求周期</span><select className="h-10 w-full rounded-md border bg-card px-3" value={cadence} onChange={event => setCadence(event.target.value)}><option value="">周期を選択</option>{Object.entries(cadenceLabels).map(([value, label]) => <option key={value} value={value} disabled={occupiedCadences.includes(value)}>{label}{occupiedCadences.includes(value) ? "（登録済み）" : ""}</option>)}</select></label><label className="space-y-1 text-sm"><span className="block">料金の通貨</span><Input value={currency} readOnly={Boolean(storeCurrency)} maxLength={3} placeholder="Square店舗の通貨コード" onChange={event => setCurrency(event.target.value.toUpperCase())} /></label><label className="space-y-1 text-sm"><span className="block">継続課金の料金</span><Input value={amount} inputMode={digits ? "decimal" : "numeric"} onChange={event => setAmount(event.target.value)} /><span className="block text-xs text-muted-foreground">入力した通貨での金額。料金・周期を確認してからSquareへ作成します。</span></label></fieldset><Button type="submit" variant="outline" disabled={busy || !loaded || !valid}>Square料金の作成内容を確認</Button></form> : <div aria-label="Square料金の作成確認" className="space-y-3 rounded-lg bg-muted/30 p-3"><p className="font-medium">{creation.name}</p><p>{donationMoney(creation.amount, creation.currency)} · {cadenceLabels[creation.cadence] ?? creation.cadence}</p><p className="text-xs">通知プラン: {plan.label} · 確認期限: {dateLabel(creation.expiresAtMs)}</p>{creation.state === "COMPLETE" ? <p role="status" className="text-sm">作成・紐付け済み{creation.variationId ? `: ${creation.variationId}` : ""}</p> : <>{unresolved ? <p role="status" className="text-sm">作成結果を確認中です。新しい作成を始めず、同じ受付の状態を確認してください。</p> : null}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>この料金・周期でSquare料金プランを作成し、「{plan.label}」に紐付けることを確認しました。</span></label></>}
        <div className="flex flex-wrap gap-2">{creation.state === "QUOTED" || creation.retryable ? <Button type="button" disabled={busy || !consent} onClick={() => void confirm()}>{creation.state === "QUOTED" ? "確認してSquareに作成" : "同じ作成内容で再試行"}</Button> : null}{unresolved ? <Button type="button" variant="outline" disabled={busy} onClick={() => void check()}>Square料金の受付状態を確認</Button> : null}{["QUOTED", "FAILED", "COMPLETE"].includes(creation.state) ? <Button type="button" variant="outline" disabled={busy} onClick={() => { setCreation(null); setConsent(false); setError(""); }}>料金の入力へ戻る</Button> : null}</div>
      </div>}
    </> : null}{busy ? <p role="status" className="text-xs">Squareの作成内容を確認しています…</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}

type CouponDraft = { code: string; label: string; type: "" | "fixed" | "percent"; value: string; currency: string; planIds: string[]; enabled: boolean; expires: string; totalLimit: string; userLimit: string };
const couponDraft = (coupon?: Coupon): CouponDraft => ({ code: coupon?.code ?? "", label: coupon?.label ?? "", type: coupon?.type ?? "", value: coupon ? coupon.type === "percent" ? String(coupon.value) : (coupon.value / 10 ** (moneyDigits(coupon.currency ?? "") ?? 0)).toFixed(moneyDigits(coupon.currency ?? "") ?? 0) : "", currency: coupon?.currency ?? "", planIds: coupon?.planIds ?? [], enabled: coupon?.enabled ?? false, expires: dateInput(coupon?.expiresAtMs ?? null), totalLimit: coupon?.totalLimit === undefined || coupon.totalLimit === null ? "" : String(coupon.totalLimit), userLimit: coupon?.userLimit === undefined || coupon.userLimit === null ? "" : String(coupon.userLimit) });
function CouponEditor({ coupon, plans, api, refreshing, onSaved, onCancel }: { coupon?: Coupon; plans: CommercePlan[]; api: CommerceAPI; refreshing: boolean; onSaved: (coupon: Coupon) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState(() => couponDraft(coupon)), [confirmation, setConfirmation] = useState<{ version: number | null } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState(""), [conflict, setConflict] = useState(false);
  const actionLock = useRef(false), digits = moneyDigits(draft.currency);
  const discountValue = draft.type === "percent" ? positiveInteger(draft.value) && Number(draft.value) <= 99 ? Number(draft.value) : null : draft.type === "fixed" && digits !== null ? donationAmount(draft.value, digits) : null;
  const expiry = draft.expires === dateInput(coupon?.expiresAtMs ?? null) ? coupon?.expiresAtMs ?? null : draft.expires ? couponExpiry(draft.expires) : null;
  const valid = draft.code.length <= 64 && /^[A-Z0-9][A-Z0-9_-]*$/.test(draft.code) && draft.label.trim().length > 0 && draft.label.trim().length <= 120 && discountValue !== null && discountValue <= 1000000000 && draft.planIds.length > 0 && draft.planIds.length <= 100 && draft.planIds.every(id => plans.some(plan => plan.planId === id)) && (!draft.expires || expiry !== null && expiry > 0 && (!draft.enabled || expiry > Date.now())) && (!draft.totalLimit || positiveInteger(draft.totalLimit) && Number(draft.totalLimit) <= 1000000) && (!draft.userLimit || positiveInteger(draft.userLimit) && Number(draft.userLimit) <= 1000000);
  const changed = !coupon || JSON.stringify(draft) !== JSON.stringify(couponDraft(coupon));
  function update<K extends keyof CouponDraft>(key: K, value: CouponDraft[K]) { setDraft(previous => ({ ...previous, [key]: value })); setConfirmation(null); setMessage(""); }
  function generate() { const values = new Uint8Array(12); crypto.getRandomValues(values); const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; update("code", `CBTE-${[...values].map(value => alphabet[value & 31]).join("")}`); }
  async function save() {
    if (actionLock.current || refreshing || !valid || !confirmation || confirmation.version !== (coupon?.updatedAtMs ?? null) || conflict) return;
    actionLock.current = true; setBusy(true); setError("");
    try {
      const next: Coupon = await api(coupon ? `billing/coupons/${encodeURIComponent(coupon.code)}` : "billing/coupons", coupon ? "PATCH" : "POST", { code: draft.code, label: draft.label.trim(), type: draft.type, value: discountValue, currency: draft.type === "fixed" ? draft.currency : null, planIds: draft.planIds, enabled: draft.enabled, expiresAtMs: expiry, totalLimit: draft.totalLimit === "" ? null : Number(draft.totalLimit), userLimit: draft.userLimit === "" ? null : Number(draft.userLimit), expectedUpdatedAtMs: coupon?.updatedAtMs ?? null });
      setDraft(couponDraft(next)); setConfirmation(null); setMessage("クーポンの設定を保存しました。初回請求だけに適用され、次回以降は通常料金です。"); onSaved(next);
    } catch (cause: any) { const stale = cause?.status === 409 || cause?.code === "SQUARE_COUPON_CONFLICT"; setConflict(stale); setConfirmation(null); setError(stale ? "ほかの管理者による変更があります。最新のクーポンを取得し、保持した入力内容と比較してください。" : errorMessage(cause, "クーポンを保存できませんでした。入力内容を保持しています。設定を確認して再試行してください。")); }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function reload() {
    if (actionLock.current || !coupon) return; actionLock.current = true; setBusy(true); setError("");
    try { const data: Admin = await api("billing/commerce/admin"); const next = data.coupons.find(item => item.code === coupon.code); if (!next) throw new Error("Missing coupon"); onSaved(next); setConflict(false); setConfirmation(null); setMessage("最新の設定を取得しました。入力内容を保持しています。変更内容をもう一度確認してください。"); }
    catch { setError("クーポンを再取得できませんでした。入力内容を保持して再試行できます。"); }
    finally { actionLock.current = false; setBusy(false); }
  }
  const description = (source: CouponDraft) => source.type === "percent" ? `${source.value}%引き` : source.type === "fixed" ? donationMoney(donationAmount(source.value, moneyDigits(source.currency) ?? 0) ?? 0, source.currency) + "引き" : "未設定";
  const rows = [{ label: "表示名", before: coupon?.label ?? "未作成", after: draft.label.trim() }, { label: "割引", before: coupon ? description(couponDraft(coupon)) : "未設定", after: description(draft) }, { label: "対象プラン", before: coupon?.planIds.map(id => plans.find(plan => plan.planId === id)?.label ?? id).join("、") ?? "未設定", after: draft.planIds.map(id => plans.find(plan => plan.planId === id)?.label ?? id).join("、") }, { label: "期限", before: dateLabel(coupon?.expiresAtMs ?? null), after: dateLabel(expiry) }, { label: "全体の利用上限", before: coupon?.totalLimit ?? "無制限", after: draft.totalLimit || "無制限" }, { label: "ユーザーごとの上限", before: coupon?.userLimit ?? "無制限", after: draft.userLimit || "無制限" }, { label: "受付状態", before: coupon ? coupon.enabled ? "有効" : "停止中" : "未作成", after: draft.enabled ? "有効" : "停止中" }];
  return <article aria-label={`${coupon?.code ?? "新しいクーポン"}の設定`} className="space-y-3 rounded-xl border p-4"><h3 className="font-medium">{coupon ? `${coupon.label} · ${coupon.code}` : "クーポンを発行"}</h3>{coupon ? <p className="text-xs text-muted-foreground">確定した利用 {coupon.used}件 · 受付中の予約 {coupon.reserved}件</p> : null}
    <form noValidate className="space-y-4" onSubmit={event => { event.preventDefault(); if (valid && changed && !busy && !refreshing && !conflict) { setConfirmation({ version: coupon?.updatedAtMs ?? null }); setError(""); setMessage(""); } }}><fieldset disabled={busy || refreshing} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span className="block">クーポンコード</span><Input value={draft.code} readOnly={Boolean(coupon)} maxLength={64} onChange={event => update("code", event.target.value.toUpperCase())} /><span className="block text-xs text-muted-foreground">英数字・ハイフン・アンダースコア。発行後は変更できません。</span></label><label className="space-y-1 text-sm"><span className="block">クーポンの表示名</span><Input value={draft.label} maxLength={120} onChange={event => update("label", event.target.value)} /></label>{!coupon ? <Button type="button" variant="outline" onClick={generate}>読みやすいコードを生成</Button> : null}<label className="space-y-1 text-sm"><span className="block">割引方法</span><select className="h-10 w-full rounded-md border bg-card px-3" value={draft.type} onChange={event => update("type", event.target.value as CouponDraft["type"])}><option value="">割引方法を選択</option><option value="percent">割合（%）</option><option value="fixed">固定額</option></select></label>{draft.type === "fixed" ? <label className="space-y-1 text-sm"><span className="block">割引額の通貨</span><Input value={draft.currency} maxLength={3} onChange={event => update("currency", event.target.value.toUpperCase())} /><span className="block text-xs text-muted-foreground">対象プランと同じ通貨で指定します。</span></label> : null}<label className="space-y-1 text-sm"><span className="block">{draft.type === "fixed" ? "割引金額" : "割引率（%）"}</span><Input value={draft.value} inputMode={draft.type === "fixed" && digits ? "decimal" : "numeric"} onChange={event => update("value", event.target.value)} /><span className="block text-xs text-muted-foreground">{draft.type === "percent" ? "1〜99の整数。" : "入力した通貨での割引額。"}割引後の初回請求は、通貨の最小単位で1以上必要です。</span></label><label className="space-y-1 text-sm"><span className="block">有効期限（日本時間）</span><Input type="datetime-local" value={draft.expires} onChange={event => update("expires", event.target.value)} /><span className="block text-xs text-muted-foreground">空欄なら期限なし。</span></label>{([['totalLimit', '全体の利用上限'], ['userLimit', 'ユーザーごとの利用上限']] as const).map(([key, label]) => <label key={key} className="space-y-1 text-sm"><span className="block">{label}</span><Input type="number" min={1} max={1000000} step={1} inputMode="numeric" value={draft[key]} onChange={event => update(key, event.target.value)} /><span className="block text-xs text-muted-foreground">1〜1,000,000の整数。空欄なら無制限。</span></label>)}</div><fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">対象の有償プラン</legend>{plans.length ? plans.map(plan => <label key={plan.planId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.planIds.includes(plan.planId)} onChange={event => update("planIds", event.target.checked ? [...draft.planIds, plan.planId] : draft.planIds.filter(id => id !== plan.planId))} />{plan.label}{!plan.enabled ? "（停止中）" : ""}</label>) : <p className="text-sm text-muted-foreground">先に有償の通知プランを保存してください。</p>}</fieldset><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => update("enabled", event.target.checked)} />このクーポンを有効にする</label></fieldset>
      {confirmation ? <section aria-label="クーポン設定の変更確認" className="space-y-3 rounded-lg border border-primary/30 p-3"><h4 className="text-sm font-medium">クーポン設定の変更確認</h4><p className="text-sm">コード: {draft.code} · 初回請求だけに適用</p><div className="overflow-x-auto"><table className="w-full min-w-80 text-left text-sm"><thead><tr><th className="py-2">項目</th><th>現在</th><th>保存後</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}><th className="py-1 font-normal">{row.label}</th><td>{row.before}</td><td>{row.after}</td></tr>)}</tbody></table></div><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || refreshing || conflict || confirmation.version !== (coupon?.updatedAtMs ?? null)} onClick={() => void save()}>このクーポン設定で保存</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>クーポンの編集に戻る</Button></div></section> : <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || refreshing || !valid || !changed || conflict}>クーポンの変更を確認</Button>{onCancel ? <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>クーポン発行を取り消す</Button> : null}</div>}
    </form>{error ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p>{conflict ? <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>最新のクーポンを再取得</Button> : null}</div> : null}{message ? <p role="status" className="text-sm">{message}</p> : null}
  </article>;
}

export function SquareCouponManager({ plans, configured, api }: { plans: CommercePlan[]; configured: boolean; api: CommerceAPI }) {
  const [opened, setOpened] = useState(false), [loading, setLoading] = useState(false), [items, setItems] = useState<Coupon[]>([]), [error, setError] = useState(""), [creating, setCreating] = useState(false);
  const version = useRef(0);
  async function load() { setOpened(true); const current = ++version.current; setLoading(true); setError(""); try { const data: Admin = await api("billing/commerce/admin"); if (current === version.current) setItems(data.coupons); } catch (cause) { if (current === version.current) setError(errorMessage(cause, "クーポンを取得できませんでした。入力内容を保持して再試行できます。")); } finally { if (current === version.current) setLoading(false); } }
  const saved = (coupon: Coupon) => setItems(previous => [...previous.filter(item => item.code !== coupon.code), coupon].sort((a, b) => a.code.localeCompare(b.code)));
  const paid = plans.filter(plan => plan.tier === "paid");
  return <section aria-label="初回請求の割引クーポン" className="space-y-4 rounded-xl border p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">割引クーポン</h2><p className="mt-1 text-sm text-muted-foreground">有償プランの初回請求に固定額・割合の割引を設定します。次回以降の継続課金は通常料金です。</p></div><Button type="button" variant="outline" disabled={!configured || loading} onClick={() => void load()}>{opened ? "クーポン一覧を更新" : "割引クーポンを管理"}</Button></div>{!configured ? <p className="text-sm text-muted-foreground">Square連携を完了すると、クーポンを発行・管理できます。</p> : null}
    {opened ? <>{loading ? <p role="status" className="text-sm">クーポンを読み込み中…</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{!loading && !error ? <Button type="button" disabled={creating || !paid.length} onClick={() => setCreating(true)}>クーポンを発行</Button> : null}{!loading && !items.length && !error ? <p className="text-sm text-muted-foreground">発行済みのクーポンはありません。</p> : null}{items.map(coupon => <CouponEditor key={coupon.code} coupon={coupon} plans={paid} api={api} refreshing={loading} onSaved={saved} />)}{creating ? <CouponEditor key="new-coupon" plans={paid} api={api} refreshing={loading} onSaved={coupon => { saved(coupon); setCreating(false); }} onCancel={() => setCreating(false)} /> : null}</> : null}
  </section>;
}
