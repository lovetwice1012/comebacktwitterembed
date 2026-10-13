"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isPaymentEmail } from "@/lib/payment-input";
import { automationResponseError } from "./automation-feedback";

type Plan = { planId: string; label: string; slotLimit: number; minuteLimit: number; dayLimit: number; priority: number; variationId: string; catalogName: string; cadence: string; amount: number; currency: string; billingAnchorDay?: number | null; canProrate?: boolean };
type BillingOptions = { configured: boolean; environment: "sandbox" | "production"; applicationId?: string; locationId?: string; plans: Plan[] };
type BillingStatus = { configured: boolean; environment: string; subscription: null | { planId: string; label: string; state: string; paidThroughAtMs: number | null; validUntilAtMs: number | null; canceledDate: string | null; active: boolean; cancelScheduled: boolean }; pending: null | { checkoutId: string; state: string; retryable: boolean } };
type Quote = { checkoutId: string; expiresAtMs: number; plan: Plan; email: string; name: string };
type BillingAPI = (path: string, method?: string, body?: unknown) => Promise<any>;
type Card = { attach: (selector: string) => Promise<void>; destroy: () => Promise<void> | void; tokenize: (options: unknown) => Promise<{ status: string; token?: string }> };
type SquareSDK = { payments: (applicationId: string, locationId: string) => { card: () => Promise<Card> } };
type SquareLoader = (environment: "sandbox" | "production") => Promise<SquareSDK>;
const sdkLoads = new Map<string, Promise<SquareSDK>>();

export async function subscriptionAPI(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/automation/billing/${path}`, { method, cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw automationResponseError(data, response);
  return data;
}

export function loadSquareSubscriptionSDK(environment: "sandbox" | "production"): Promise<SquareSDK> {
  const src = environment === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
  const existing = sdkLoads.get(src); if (existing) return existing;
  const loading = new Promise<SquareSDK>((resolve, reject) => {
    const squareWindow = window as typeof window & { Square?: SquareSDK };
    const script = [...document.querySelectorAll<HTMLScriptElement>("script[src]")].find(item => item.src === src);
    if (squareWindow.Square) { if (script) resolve(squareWindow.Square); else reject(new Error("Squareの支払い画面を読み込めませんでした。")); return; }
    const element = script ?? document.createElement("script");
    element.addEventListener("load", () => squareWindow.Square ? resolve(squareWindow.Square) : reject(new Error("Squareの支払い画面を読み込めませんでした。")), { once: true });
    element.addEventListener("error", () => { element.remove(); reject(new Error("Squareの支払い画面を読み込めませんでした。")); }, { once: true });
    if (!script) { element.src = src; element.async = true; document.head.append(element); }
  });
  sdkLoads.set(src, loading); void loading.catch(() => sdkLoads.delete(src)); return loading;
}

export function subscriptionPrice(plan: Pick<Plan, "amount" | "currency">): string {
  if (!Number.isSafeInteger(plan.amount) || plan.amount < 0 || !/^[A-Z]{3}$/.test(plan.currency)) return "料金を確認できません";
  try { const formatter = new Intl.NumberFormat("ja-JP", { style: "currency", currency: plan.currency }); return formatter.format(plan.amount / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2)); }
  catch { return "料金を確認できません"; }
}
const cadences: Record<string, string> = { DAILY: "毎日", WEEKLY: "毎週", EVERY_TWO_WEEKS: "2週間ごと", THIRTY_DAYS: "30日ごと", SIXTY_DAYS: "60日ごと", NINETY_DAYS: "90日ごと", MONTHLY: "毎月", EVERY_TWO_MONTHS: "2か月ごと", QUARTERLY: "3か月ごと", EVERY_FOUR_MONTHS: "4か月ごと", EVERY_SIX_MONTHS: "6か月ごと", ANNUAL: "毎年", EVERY_TWO_YEARS: "2年ごと" };
const jstDate = (value: number | null) => value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(value) + " JST" : "確認中";
function PlanDetails({ plan }: { plan: Plan }) {
  const monthlyAnchor = plan.cadence === "MONTHLY" && Number.isInteger(plan.billingAnchorDay) && Number(plan.billingAnchorDay) >= 1 && Number(plan.billingAnchorDay) <= 31;
  return <><p className="text-2xl font-semibold">{subscriptionPrice(plan)}<span className="ml-2 text-sm font-normal text-muted-foreground">{cadences[plan.cadence] ?? "Squareで設定した周期"}</span></p>{monthlyAnchor ? <p className="rounded-lg bg-muted/30 p-3 text-sm">毎月{plan.billingAnchorDay}日が課金日です。{plan.canProrate === true ? "初回は日割りで、表示された定期料金と異なる場合があります。初回の請求額はSquareが確定します。" : plan.canProrate === false ? "初回は日割りせず、表示された定期料金が適用されます。次の課金日までの期間が通常より短くなる場合があります。" : "初回の請求条件はSquareで確認されます。"}</p> : null}<p className="text-sm">通知{plan.slotLimit}枠 · 1枠あたり1日{plan.dayLimit}通・1分{plan.minuteLimit}通</p><p className="text-xs text-muted-foreground">優先度 {plan.priority} · メッセージ1件＝1通。日次上限は日本時間の0時にリセット。</p></>;
}

export function SubscriptionManager({ api = subscriptionAPI, loadSquare = loadSquareSubscriptionSDK }: { api?: BillingAPI; loadSquare?: SquareLoader }) {
  const [options, setOptions] = useState<BillingOptions | null>(null), [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(""), [actionError, setActionError] = useState(""), [message, setMessage] = useState("");
  const [selected, setSelected] = useState(""), [email, setEmail] = useState(""), [name, setName] = useState(""), [quote, setQuote] = useState<Quote | null>(null), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [attempt, setAttempt] = useState<{ checkoutId: string } | null>(null), [checkedAttempt, setCheckedAttempt] = useState(false);
  const [cardReady, setCardReady] = useState(false), [cardError, setCardError] = useState(""), [cardVersion, setCardVersion] = useState(0), [cancelConfirm, setCancelConfirm] = useState(false);
  const mounted = useRef(true), loadVersion = useRef(0), actionLock = useRef(false), card = useRef<Card | null>(null);
  const source = useRef<{ checkoutId: string; sourceId: string } | null>(null);
  const cardId = `square-subscription-card-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const terminalExpired = Boolean(status?.subscription && ["CANCELED", "DEACTIVATED", "COMPLETED"].includes(status.subscription.state) && Number(status.subscription.validUntilAtMs ?? 0) <= Date.now());
  const blocked = Boolean(status?.subscription && !terminalExpired || status?.pending || attempt);
  async function refreshStatus() {
    const next: BillingStatus = await api("status");
    if (mounted.current) { setStatus(next); if (attempt) setCheckedAttempt(true); }
    return next;
  }
  async function load() {
    const version = ++loadVersion.current; setLoading(true); setLoadError("");
    const results = await Promise.allSettled([api("options"), api("status")]);
    if (!mounted.current || version !== loadVersion.current) return;
    if (results[0].status === "fulfilled") setOptions(results[0].value);
    if (results[1].status === "fulfilled") { setStatus(results[1].value); if (attempt) setCheckedAttempt(true); }
    if (results.some(result => result.status === "rejected")) setLoadError("プラン・契約状態を確認できませんでした。入力内容は保持されています。再読み込みしてください。");
    setLoading(false);
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loadVersion.current++; source.current = null; }; }, [api]);
  useEffect(() => {
    setCardReady(false); setCardError("");
    if (!quote || attempt || blocked || !options?.configured || !options.applicationId || !options.locationId) return;
    let active = true, created: Card | null = null, destroyed = false;
    async function destroyCard() { if (!created || destroyed) return; destroyed = true; try { await created.destroy(); } catch { /* An expired card frame needs no further action. */ } }
    async function initialize() {
      try {
        const sdk = await loadSquare(options!.environment);
        if (!active) return;
        created = await sdk.payments(options!.applicationId!, options!.locationId!).card();
        if (!active) { await destroyCard(); return; }
        await created.attach(`#${cardId}`);
        if (!active) { await destroyCard(); return; }
        card.current = created; setCardReady(true);
      } catch { if (active) setCardError("カード入力欄を読み込めませんでした。再読み込みしてください。"); }
    }
    void initialize();
    return () => { active = false; if (card.current === created) card.current = null; void destroyCard(); };
  }, [quote, options?.configured, options?.applicationId, options?.locationId, options?.environment, attempt, blocked, cardId, cardVersion, loadSquare]);
  async function review() {
    if (actionLock.current || blocked || loading || !options?.configured || loadError || !selected || !name.trim() || name.trim().length > 120 || !isPaymentEmail(email.trim())) return;
    actionLock.current = true; setBusy(true); setActionError(""); setMessage("");
    try {
      const next: Quote = await api("quote", "POST", { planId: selected, email: email.trim(), name: name.trim() });
      if (mounted.current) { source.current = null; setQuote(next); setConsent(false); }
    } catch (cause) { if (mounted.current) setActionError(cause instanceof Error ? cause.message : "契約内容を確認できませんでした。"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit(retry = false) {
    if (actionLock.current || !quote || !consent || loadError || loading || !options?.configured) return;
    if (retry) { if (!status?.pending?.retryable || status.pending.checkoutId !== quote.checkoutId || source.current?.checkoutId !== quote.checkoutId) return; }
    else if (blocked || !card.current || !cardReady) return;
    else if (quote.expiresAtMs <= Date.now()) { setActionError("契約内容の確認期限が切れました。プランの選択に戻り、現在の料金をもう一度確認してください。"); return; }
    actionLock.current = true; setBusy(true); setActionError(""); setMessage("");
    try {
      if (!retry) {
        const tokenized = await card.current!.tokenize({ intent: "STORE", customerInitiated: true, sellerKeyedIn: false, billingContact: { email: quote.email, givenName: quote.name, countryCode: "JP" }, currencyCode: quote.plan.currency });
        if (!mounted.current) return;
        if (tokenized.status !== "OK" || !tokenized.token) { setActionError("カード情報を確認してください。支払いは実行されていません。"); return; }
        source.current = { checkoutId: quote.checkoutId, sourceId: tokenized.token };
      }
      if (!mounted.current || source.current?.checkoutId !== quote.checkoutId) return;
      setAttempt({ checkoutId: quote.checkoutId }); setCheckedAttempt(false);
      const result: BillingStatus = await api("subscribe", "POST", { checkoutId: quote.checkoutId, sourceId: source.current.sourceId, consent: true });
      if (mounted.current) { setStatus(result); setCheckedAttempt(true); setMessage("契約の受付結果を確認しています。支払い確認後に通知枠へ適用されます。"); if (result.subscription) source.current = null; }
    } catch (cause) {
      if (!mounted.current) return;
      setActionError(source.current ? `${cause instanceof Error && (cause as any).status === 429 ? cause.message + " " : "契約の受付結果を確認できませんでした。"}新しい支払いを始めず、状態を再確認してください。` : "カード情報を確認できませんでした。入力内容を確認して再試行してください。");
      if (source.current) { try { const next = await api("status"); if (mounted.current) { setStatus(next); setCheckedAttempt(true); } } catch { /* The uncertain attempt stays blocked until status can be checked. */ } }
      else if (cause instanceof Error && (cause as any).status === 429) setActionError(cause.message);
    } finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function check() {
    if (actionLock.current) return; actionLock.current = true; setBusy(true); setActionError("");
    try { await refreshStatus(); setMessage("契約状態を再確認しました。"); }
    catch { setActionError("契約状態を確認できませんでした。新しい支払いを始めず、再確認してください。"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function cancel() {
    if (actionLock.current || !cancelConfirm || !status?.subscription) return;
    actionLock.current = true; setBusy(true); setActionError("");
    try { const next: BillingStatus = await api("cancel", "POST", {}); if (mounted.current) { setStatus(next); setCancelConfirm(false); setMessage("解約の受付結果を反映しました。利用期限と契約状態を確認してください。"); } }
    catch { if (mounted.current) setActionError("解約の受付結果を確認できませんでした。契約状態を再確認してください。"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  const pending = status?.pending;
  const canRetry = Boolean(pending?.retryable && pending.checkoutId === source.current?.checkoutId && quote?.checkoutId === pending.checkoutId && consent);
  const resolvedWithoutContract = Boolean(attempt && checkedAttempt && status && !status.pending && (!status.subscription || terminalExpired));
  return <div className="space-y-5">
    <section className="space-y-2 rounded-xl bg-muted/40 p-4 text-sm"><p>無料枠はそのまま利用できます。有償プランはSquareのサブスクリプションとして継続課金されます。</p><p className="text-muted-foreground">カード情報はSquareの入力欄で取り扱い、カードの保存と継続課金への同意後に契約します。</p></section>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted-foreground">{loading ? "プラン・契約状態を読み込み中…" : options?.environment === "sandbox" && options.configured ? "Squareサンドボックス環境" : "プランと契約状態"}</p><Button type="button" variant="outline" disabled={loading || busy} onClick={() => void load()}>再読み込み</Button></div>
    {loadError ? <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{loadError}</p> : null}
    {!loading && options && !options.configured ? <p role="status" className="rounded-lg border p-4 text-sm">有償プランの受付はまだ準備中です。無料枠の通知を引き続き利用できます。</p> : null}
    {status?.subscription ? <section aria-label={terminalExpired ? "前回の契約" : "現在の契約"} className="space-y-3 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">{terminalExpired ? "前回の契約" : "現在の契約"}: {status.subscription.label}</h2><p role="status" className="text-sm">{terminalExpired ? "利用期限終了 · 新しいプランを契約できます" : status.subscription.cancelScheduled ? "解約予定" : status.subscription.active ? "利用中" : "支払い・契約状態を確認中"}</p><dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">支払い確認済みの期間</dt><dd>{jstDate(status.subscription.paidThroughAtMs)}</dd></div><div><dt className="text-muted-foreground">通知枠の利用期限</dt><dd>{jstDate(status.subscription.validUntilAtMs)}</dd></div></dl><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => void check()}>契約状態を再確認</Button>{!terminalExpired && !status.subscription.cancelScheduled ? <Button type="button" variant="outline" disabled={busy} onClick={() => setCancelConfirm(true)}>サブスクリプションを解約</Button> : null}</div>{cancelConfirm ? <div className="space-y-3 rounded-lg border p-4 text-sm"><p>今後の継続課金を停止するため、解約を申し込みます。解約後の利用期限はSquareの契約状態に従って表示します。</p><div className="flex flex-wrap gap-2"><Button type="button" variant="destructive" disabled={busy} onClick={() => void cancel()}>解約を申し込む</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setCancelConfirm(false)}>契約を続ける</Button></div></div> : null}</section> : null}
    {(pending || attempt && (!status?.subscription || terminalExpired)) ? <section aria-label="未完了の契約" className="space-y-3 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">契約の受付結果を確認</h2><p className="text-sm">{resolvedWithoutContract ? "状態を確認しました。現在、新しく作成された契約はありません。" : "受付済みの処理があります。重複を避けるため、新しい契約は開始できません。支払い確認後に通知枠へ適用されます。"}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => void check()}>受付状態を再確認</Button>{canRetry ? <Button type="button" disabled={busy} onClick={() => void submit(true)}>同じ受付内容で再試行</Button> : null}{resolvedWithoutContract ? <Button type="button" variant="outline" disabled={busy} onClick={() => { source.current = null; setAttempt(null); setQuote(null); setConsent(false); setActionError(""); }}>契約内容の選択へ戻る</Button> : null}</div></section> : null}
    {!blocked && !loading && !loadError && options?.configured && !quote ? <section aria-label="有償プランの選択" className="space-y-4"><h2 className="text-lg font-semibold">有償プランを選ぶ</h2>{options.plans.length ? <><div className="grid gap-3 md:grid-cols-2">{options.plans.map(plan => <label key={plan.planId} className={`space-y-3 rounded-xl border bg-card p-5 ${selected === plan.planId ? "border-primary" : ""}`}><div className="flex items-center gap-2"><input type="radio" name="notification-subscription-plan" value={plan.planId} checked={selected === plan.planId} disabled={busy} onChange={() => setSelected(plan.planId)} /><span className="font-semibold">{plan.label}</span></div><PlanDetails plan={plan} /></label>)}</div><form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void review(); }}><label className="min-w-0 flex-1 space-y-1 text-sm"><span className="block">請求名</span><Input autoComplete="name" maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="カードの名義人のお名前" /></label><label className="min-w-0 flex-1 space-y-1 text-sm"><span className="block">請求先メールアドレス</span><Input type="email" autoComplete="email" maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} placeholder="請求の連絡先" /></label><Button type="submit" disabled={busy || !selected || !name.trim() || name.trim().length > 120 || !isPaymentEmail(email.trim())}>契約内容を確認</Button></form></> : <p className="rounded-lg border p-4 text-sm">現在、購入できる有償プランはありません。無料枠の通知を引き続き利用できます。</p>}</section> : null}
    {quote && !blocked ? <section aria-label="契約内容の確認" className="space-y-4 rounded-xl border bg-card p-5"><div><h2 className="text-lg font-semibold">{quote.plan.label}の契約内容</h2><p className="mt-1 text-sm text-muted-foreground">Squareで現在の料金・請求周期を確認しました。請求先: {quote.email}</p></div><PlanDetails plan={quote.plan} /><p className="text-xs text-muted-foreground">この確認の有効期限: {jstDate(quote.expiresAtMs)}</p><div id={cardId} className="min-h-24" aria-label="Squareカード情報" />{!cardReady && !cardError ? <p role="status" className="text-sm">カード入力欄を準備中…</p> : null}{cardError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{cardError}</p><Button type="button" variant="outline" disabled={busy} onClick={() => setCardVersion(version => version + 1)}>カード入力欄を再読み込み</Button></div> : null}<label className="flex items-start gap-2 rounded-lg bg-muted/30 p-3 text-sm"><input type="checkbox" className="mt-1" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>カードをSquareに保存し、{subscriptionPrice(quote.plan)}が{cadences[quote.plan.cadence] ?? "Squareで設定した周期"}継続課金されることに同意します。表示された通知枠・送信上限を確認しました。</span></label><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || loading || Boolean(loadError) || !options?.configured || !cardReady || !consent} onClick={() => void submit()}>{busy ? "契約の受付中…" : "同意してサブスクリプションを契約"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { setQuote(null); setConsent(false); source.current = null; setActionError(""); }}>プランの選択に戻る</Button></div><p className="text-xs text-muted-foreground">受付後、支払いを確認してから通知枠へ適用します。</p></section> : null}
    {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}{message ? <p role="status" className="text-sm">{message}</p> : null}
  </div>;
}
