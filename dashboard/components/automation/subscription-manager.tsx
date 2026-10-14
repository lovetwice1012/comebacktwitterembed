"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isPaymentEmail } from "@/lib/payment-input";
import {
  subscriptionPrice, subscriptionCadenceLabels as cadences, subscriptionIntervalLabels,
  subscriptionMonthlyPrice, subscriptionMonthlyApproximate, compareSubscriptionMonthlyPrices,
} from "@/lib/subscription-pricing";
export { subscriptionPrice } from "@/lib/subscription-pricing";
import {
  automationResponseError,
  automationRetryDelay,
} from "@/components/automation/automation-feedback";
import type { SquareStatus as BillingStatus } from "@bot/automation/square-billing";
import "./notification-billing.css";

type Plan = {
  planId: string;
  label: string;
  slotLimit: number;
  minuteLimit: number;
  dayLimit: number;
  priority: number;
  variationId: string;
  catalogName: string;
  cadence: string;
  amount: number;
  currency: string;
  billingAnchorDay?: number | null;
  canProrate?: boolean;
  regularAmount?: number;
  firstAmount?: number;
  coupon?: null | {
    code: string;
    label: string;
    type: "fixed" | "percent";
    value: number;
    discountAmount: number;
  };
};
type BillingOptions = { configured: boolean; environment: "sandbox" | "production"; applicationId?: string; locationId?: string; plans: Plan[] };
type Quote = { checkoutId: string; expiresAtMs: number; plan: Plan; email: string; name: string };
type BillingAPI = (path: string, method?: string, body?: unknown) => Promise<any>;
type CardBillingContact = { email?: string; givenName?: string; familyName?: string; countryCode?: string; phone?: string; addressLines?: string[]; city?: string; state?: string; postalCode?: string };
type StoreCardVerificationDetails = { intent: "STORE"; customerInitiated: boolean; sellerKeyedIn: boolean; billingContact: CardBillingContact; amount?: never; currencyCode?: never; total?: never };
type ChargeCardVerificationDetails = { intent: "CHARGE" | "CHARGE_AND_STORE"; customerInitiated: boolean; sellerKeyedIn: boolean; billingContact: CardBillingContact; amount: string; currencyCode: string };
type CardTokenResult = { status: string; token?: string; errors?: unknown };
type Card = { attach: (selector: string) => Promise<void>; destroy: () => Promise<void> | void; tokenize: (options: StoreCardVerificationDetails | ChargeCardVerificationDetails) => Promise<CardTokenResult> };
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

const jstDate = (value: number | null) => value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(value) + " JST" : "確認中";
function PlanDetails({ plan, monthlyFirst = false }: { plan: Plan; monthlyFirst?: boolean }) {
  const monthBasedAnchor = ["MONTHLY", "EVERY_TWO_MONTHS", "QUARTERLY", "EVERY_FOUR_MONTHS", "EVERY_SIX_MONTHS", "ANNUAL", "EVERY_TWO_YEARS"].includes(plan.cadence) && Number.isInteger(plan.billingAnchorDay) && Number(plan.billingAnchorDay) >= 1 && Number(plan.billingAnchorDay) <= 31;
  const monthly = <>{subscriptionMonthlyPrice(plan)}<span className="ml-2 text-sm font-normal text-muted-foreground">/ 月{plan.cadence !== "MONTHLY" ? "（換算）" : ""}</span></>;
  const billed = <>{subscriptionPrice(plan)}<span className="ml-2 text-sm font-normal text-muted-foreground">{cadences[plan.cadence] ?? "Squareで設定した周期"}</span></>;
  return <><p className="text-2xl font-semibold">{monthlyFirst ? monthly : billed}</p><p className="text-sm text-muted-foreground">{monthlyFirst ? <>請求額: {billed}</> : <>月あたり: {monthly}</>}</p>{subscriptionMonthlyApproximate(plan.cadence) ? <p className="text-xs text-muted-foreground">月額換算は1か月＝30日として計算した概算です。</p> : null}{monthBasedAnchor ? <p className="rounded-lg bg-muted/30 p-3 text-sm">{plan.cadence === "MONTHLY" ? "毎月" : "課金月の"}{plan.billingAnchorDay}日が課金日です。{plan.canProrate === true ? "初回は日割りで、表示された定期料金と異なる場合があります。初回の請求額はSquareが確定します。" : plan.canProrate === false ? "初回は日割りせず、表示された定期料金が適用されます。次の課金日までの期間が通常より短くなる場合があります。" : "初回の請求条件はSquareで確認されます。"}</p> : null}<p className="text-sm">通知{plan.slotLimit}枠 · 1枠あたり1日{plan.dayLimit}通・1分{plan.minuteLimit}通</p><p className="text-xs text-muted-foreground">{plan.priority > 0 ? "優先処理の対象です。" : "標準の処理順で通知します。"} メッセージ1件＝1通。日次上限は日本時間の0時にリセット。</p></>;
}
function groupedPlans(plans: Plan[], intervals: Record<string, string>, selected: string) {
  const groups = new Map<string, Plan[]>();
  for (const plan of plans) groups.set(plan.planId, [...(groups.get(plan.planId) ?? []), plan]);
  const order = Object.keys(cadences);
  return [...groups].map(([planId, choices]) => {
    const sorted = [...choices].sort((a, b) => order.indexOf(a.cadence) - order.indexOf(b.cadence));
    const plan = sorted.find(item => item.variationId === selected) ?? sorted.find(item => item.variationId === intervals[planId]) ?? sorted.find(item => item.cadence === "MONTHLY") ?? sorted[0];
    return { planId, choices: sorted, plan };
  }).sort((a, b) => compareSubscriptionMonthlyPrices(a.plan, b.plan));
}
function validQuote(quote: Quote | undefined, checkoutId: string): quote is Quote {
  return Boolean(quote && quote.checkoutId === checkoutId && quote.plan && typeof quote.plan.label === "string" && typeof quote.email === "string" && typeof quote.name === "string"
    && Number.isSafeInteger(quote.plan.amount) && quote.plan.amount > 0 && /^[A-Z]{3}$/.test(quote.plan.currency) && Object.hasOwn(cadences, quote.plan.cadence));
}
function verificationError(cause: any): string | null {
  return cause?.code === "SQUARE_PRORATION_UNVERIFIED" && cause instanceof Error ? cause.message : null;
}
function cardTokenizationError(result: CardTokenResult): string {
  const state = result.status.toLowerCase();
  if (state === "cancel" || state === "abort") return "カードの本人認証が中止されました。再度契約するときは、本人認証を完了してください。支払いは実行されていません。";
  if (state === "invalid") {
    const issues = Array.isArray(result.errors) ? result.errors : [];
    if (issues.some(issue => issue && typeof issue === "object" && typeof issue.field === "string" && issue.field.startsWith("verificationDetails."))) return "サービスのカード受付設定に問題があります。運営側での修正が必要です。支払いは実行されていません。";
    return "カード情報の入力内容を確認してください。支払いは実行されていません。";
  }
  return "Squareでカード情報を確認できませんでした。時間をおいて再試行してください。支払いは実行されていません。";
}

export function SubscriptionManager({ api = subscriptionAPI, loadSquare = loadSquareSubscriptionSDK }: { api?: BillingAPI; loadSquare?: SquareLoader }) {
  const [options, setOptions] = useState<BillingOptions | null>(null), [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(""), [actionError, setActionError] = useState(""), [message, setMessage] = useState("");
  const [selected, setSelected] = useState(""), [email, setEmail] = useState(""), [name, setName] = useState(""), [quote, setQuote] = useState<Quote | null>(null), [consent, setConsent] = useState(false);
  const [intervals, setIntervals] = useState<Record<string, string>>({});
  const [couponCode, setCouponCode] = useState("");
  const [busy, setBusy] = useState(false), [attempt, setAttempt] = useState<{ checkoutId: string } | null>(null), [checkedAttempt, setCheckedAttempt] = useState(false);
  const [cardReady, setCardReady] = useState(false), [cardError, setCardError] = useState(""), [cardVersion, setCardVersion] = useState(0), [cancelConfirm, setCancelConfirm] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [abortConfirmation, setAbortConfirmation] = useState<{ checkoutId: string } | null>(null);
  const [needsStatusRefresh, setNeedsStatusRefresh] = useState(false);
  const mounted = useRef(true), loadVersion = useRef(0), actionLock = useRef(false), card = useRef<Card | null>(null);
  const source = useRef<{ checkoutId: string; sourceId: string } | null>(null);
  const restoredTerms = useRef<string | null>(null);
  const cardId = `square-subscription-card-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const terminalExpired = Boolean(status?.subscription && ["CANCELED", "DEACTIVATED", "COMPLETED"].includes(status.subscription.state) && Number(status.subscription.validUntilAtMs ?? 0) <= Date.now());
  const blocked = Boolean(status?.subscription && !terminalExpired || status?.pending || attempt);
  const selectedPlan = options?.plans.find(plan => plan.variationId === selected);
  const planGroups = groupedPlans(options?.plans ?? [], intervals, selected);
  const currencies = new Set(planGroups.map(group => group.plan.currency));
  const unsupportedCouponPlan = Boolean(selectedPlan && (selectedPlan.canProrate || selectedPlan.billingAnchorDay != null));
  const availableCoupon = couponCode.trim() === "" || !unsupportedCouponPlan;
  const validCouponCode = couponCode.trim() === "" || couponCode.trim().length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(couponCode.trim());
  const validCouponQuote = !quote?.plan.coupon || Number.isSafeInteger(quote.plan.firstAmount) && Number(quote.plan.firstAmount) > 0 && Number.isSafeInteger(quote.plan.regularAmount) && quote.plan.regularAmount === quote.plan.amount && Number(quote.plan.firstAmount) < quote.plan.amount;
  const refresh = status?.refresh;
  const retryAt = Number(refresh?.retryAtMs), retryDelay = Number.isFinite(retryAt) && retryAt > currentTime ? Math.min(24 * 60 * 60 * 1000, retryAt - currentTime) : 0;
  const refreshWaiting = retryDelay > 0;
  function applyStatus(next: BillingStatus) {
    setStatus(next); setCurrentTime(Date.now()); setNeedsStatusRefresh(false); if (needsStatusRefresh) setConsent(false);
    setAbortConfirmation(previous => next.pending?.abortAllowed === true && next.pending.checkoutId === previous?.checkoutId ? previous : null);
    if (next.pending) {
      const pending = next.pending;
      setAttempt(previous => previous?.checkoutId === pending.checkoutId ? previous : { checkoutId: pending.checkoutId }); setCheckedAttempt(true);
      if (validQuote(pending.quote, pending.checkoutId)) {
        setSelected(previous => previous || pending.quote.plan.variationId); setIntervals(previous => ({ ...previous, [pending.quote.plan.planId]: pending.quote.plan.variationId })); setEmail(previous => previous || pending.quote.email); setName(previous => previous || pending.quote.name); setCouponCode(previous => previous || pending.quote.plan.coupon?.code || "");
      }
    }
    if (next.pending?.resumeAllowed === true && validQuote(next.pending.quote, next.pending.checkoutId)) {
      const terms = JSON.stringify(next.pending.quote);
      if (restoredTerms.current !== terms) { setQuote(next.pending.quote); setConsent(false); restoredTerms.current = terms; }
      source.current = null;
    } else restoredTerms.current = null;
  }
  async function refreshStatus() {
    const next: BillingStatus = await api("status");
    if (mounted.current) { applyStatus(next); if (attempt) setCheckedAttempt(true); }
    return next;
  }
  async function load() {
    const version = ++loadVersion.current; setLoading(true); setLoadError("");
    const results = await Promise.allSettled([api("options"), api("status")]);
    if (!mounted.current || version !== loadVersion.current) return;
    if (results[0].status === "fulfilled") setOptions(results[0].value);
    if (results[1].status === "fulfilled") { applyStatus(results[1].value); if (attempt) setCheckedAttempt(true); }
    if (results.some(result => result.status === "rejected")) { const warning = results.find(result => result.status === "rejected" && verificationError(result.reason)); setLoadError(warning?.status === "rejected" ? verificationError(warning.reason)! : "プラン・契約状態を確認できませんでした。入力内容は保持されています。再読み込みしてください。"); }
    setLoading(false);
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loadVersion.current++; source.current = null; }; }, [api]);
  // A verified contract refresh can change the allowance shown above. Keep the
  // account overview current without changing checkout or recovery semantics.
  useEffect(() => { if (status) window.dispatchEvent(new Event("notification:usage-changed")); }, [status]);
  useEffect(() => {
    if (!refreshWaiting) return;
    const timer = setTimeout(() => setCurrentTime(Date.now()), Math.min(1000, retryDelay + 1));
    return () => clearTimeout(timer);
  }, [refreshWaiting, retryDelay, currentTime]);
  useEffect(() => {
    setCardReady(false); setCardError("");
    if (!quote || attempt || blocked || !options?.configured || !options.applicationId || !options.locationId || !validCouponQuote) return;
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
  }, [quote, options?.configured, options?.applicationId, options?.locationId, options?.environment, attempt, blocked, cardId, cardVersion, loadSquare, validCouponQuote]);
  async function review() {
    if (actionLock.current || blocked || loading || !options?.configured || loadError || !selectedPlan || !name.trim() || name.trim().length > 120 || !isPaymentEmail(email.trim()) || !validCouponCode || !availableCoupon) return;
    actionLock.current = true; setBusy(true); setActionError(""); setMessage("");
    try {
      const next: Quote = await api("quote", "POST", { planId: selectedPlan.planId, variationId: selectedPlan.variationId, email: email.trim(), name: name.trim(), ...(couponCode.trim() ? { couponCode: couponCode.trim() } : {}) });
      if (mounted.current) { source.current = null; setQuote(next); setConsent(false); }
    } catch (cause) { if (mounted.current) setActionError(cause instanceof Error ? cause.message : "契約内容を確認できませんでした。"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit(retry = false) {
    if (actionLock.current || !quote || !consent || loadError || loading || !options?.configured || !validCouponQuote) return;
    if (retry) { if (!status?.pending?.retryable || status.pending.checkoutId !== quote.checkoutId || source.current?.checkoutId !== quote.checkoutId) return; }
    else if (blocked || !card.current || !cardReady) return;
    else if (quote.expiresAtMs <= Date.now()) { setActionError("契約内容の確認期限が切れました。プランの選択に戻り、現在の料金をもう一度確認してください。"); return; }
    actionLock.current = true; setBusy(true); setActionError(""); setMessage("");
    try {
      if (!retry) {
        const tokenized = await card.current!.tokenize({ intent: "STORE", customerInitiated: true, sellerKeyedIn: false, billingContact: { email: quote.email, givenName: quote.name, countryCode: "JP" } });
        if (!mounted.current) return;
        if (tokenized.status !== "OK" || !tokenized.token) { setActionError(cardTokenizationError(tokenized)); return; }
        source.current = { checkoutId: quote.checkoutId, sourceId: tokenized.token };
      }
      if (!mounted.current || source.current?.checkoutId !== quote.checkoutId) return;
      setAttempt({ checkoutId: quote.checkoutId }); setCheckedAttempt(false);
      const result: BillingStatus = await api("subscribe", "POST", { checkoutId: quote.checkoutId, sourceId: source.current.sourceId, consent: true });
      if (mounted.current) { applyStatus(result); setCheckedAttempt(true); setMessage("契約の受付結果を確認しています。支払い確認後に通知枠へ適用されます。"); if (result.subscription) source.current = null; }
    } catch (cause) {
      if (!mounted.current) return;
      const warning = verificationError(cause);
      setActionError(warning ? `${warning} 新しい支払いを始めず、契約状態を再確認してください。` : source.current ? `${cause instanceof Error && (cause as any).status === 429 ? cause.message + " " : "契約の受付結果を確認できませんでした。"}新しい支払いを始めず、状態を再確認してください。` : "カード情報を確認できませんでした。入力内容を確認して再試行してください。");
      if (source.current) { try { const next = await api("status"); if (mounted.current) { applyStatus(next); setCheckedAttempt(true); } } catch { /* The uncertain attempt stays blocked until status can be checked. */ } }
      else if (cause instanceof Error && (cause as any).status === 429) setActionError(cause.message);
    } finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function check() {
    if (actionLock.current || loading || refreshWaiting) return; actionLock.current = true; setBusy(true); setActionError("");
    try { const next = await refreshStatus(); if (mounted.current) setMessage(next.refresh && next.refresh.state !== "checked" ? "保存された契約状態を取得しました。Squareとの最新の確認状態は上の案内をご覧ください。" : "契約状態を再確認しました。"); }
    catch (cause) { if (mounted.current) setActionError(verificationError(cause) ?? "契約状態を確認できませんでした。新しい支払いを始めず、再確認してください。"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function resume() {
    const pending = status?.pending;
    if (actionLock.current || loading || loadError || needsStatusRefresh || !options?.configured || pending?.resumeAllowed !== true || !validQuote(quote ?? undefined, pending.checkoutId) || !validCouponQuote || !consent) return;
    actionLock.current = true; setBusy(true); setActionError(""); setMessage("");
    const checkoutId = pending.checkoutId;
    setAttempt({ checkoutId }); setCheckedAttempt(false);
    try { const next: BillingStatus = await api("resume", "POST", { checkoutId, consent: true }); if (mounted.current) { applyStatus(next); setCheckedAttempt(true); setMessage("契約の再開を受け付けました。支払い確認後に通知枠へ適用されます。"); } }
    catch (cause) {
      if (!mounted.current) return;
      setConsent(false); setNeedsStatusRefresh(true);
      setActionError(`${verificationError(cause) ?? (automationRetryDelay(cause) !== null && cause instanceof Error ? cause.message : "契約の受付結果を確認できませんでした。")} 新しい支払いを始めず、状態を再確認してください。`);
      try { const next: BillingStatus = await api("status"); if (mounted.current) { applyStatus(next); setCheckedAttempt(true); } } catch { /* The original checkout remains blocked until it is checked. */ }
    } finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function abort() {
    const pending = status?.pending;
    if (actionLock.current || pending?.abortAllowed !== true || abortConfirmation?.checkoutId !== pending.checkoutId || loading || loadError || needsStatusRefresh) return;
    actionLock.current = true; setBusy(true); setActionError(""); setMessage("");
    const previousQuote = pending.quote;
    setAbortConfirmation(null);
    try {
      const next: BillingStatus = await api("abort", "POST", { checkoutId: pending.checkoutId });
      if (!mounted.current) return;
      applyStatus(next);
      if (!next.pending) {
        setSelected(previous => previous || previousQuote?.plan.variationId || ""); setEmail(previous => previous || previousQuote?.email || ""); setName(previous => previous || previousQuote?.name || ""); setCouponCode(previous => previous || previousQuote?.plan.coupon?.code || "");
        source.current = null; restoredTerms.current = null; setAttempt(null); setQuote(null); setConsent(false); setCheckedAttempt(false);
        setMessage("申し込みを中止しました。保持した入力内容から、現在の料金をもう一度確認できます。");
      } else setMessage("中止の受付結果を取得しました。現在の申し込み状態を確認してください。");
    } catch (cause) {
      if (!mounted.current) return;
      setConsent(false); setNeedsStatusRefresh(true); setActionError(automationRetryDelay(cause) !== null && cause instanceof Error ? cause.message : "申し込みを中止できませんでした。新しい支払いを始めず、現在の状態を再確認してください。");
      try { const next: BillingStatus = await api("status"); if (mounted.current) { applyStatus(next); if (attempt) setCheckedAttempt(true); } } catch { /* A failed abort never permits another checkout. */ }
    } finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function cancel() {
    if (actionLock.current || !cancelConfirm || !status?.subscription) return;
    actionLock.current = true; setBusy(true); setActionError("");
    try {
      const next: BillingStatus = await api("cancel", "POST", {});
      if (mounted.current) {
        applyStatus(next); setCancelConfirm(false);
        const deferred = next.subscription && !next.subscription.cancelScheduled && !["CANCELED", "DEACTIVATED", "COMPLETED"].includes(next.subscription.state);
        setMessage(deferred && next.refresh?.state === "busy" ? "解約の処理が進行中です。表示は保存された確認結果です。待機時間の後に契約状態を再確認してください。" : deferred && next.refresh?.state === "cooldown" ? "前回の解約の受付結果を確認するまで、新しい解約操作を待機しています。待機時間の後に契約状態を再確認してください。" : "解約の受付結果を反映しました。利用期限と契約状態を確認してください。");
      }
    }
    catch (cause) { if (mounted.current) setActionError(verificationError(cause) ?? "解約の受付結果を確認できませんでした。契約状態を再確認してください。"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  const pending = status?.pending;
  const canRetry = Boolean(pending?.retryable && pending.checkoutId === source.current?.checkoutId && quote?.checkoutId === pending.checkoutId && consent);
  const canResume = pending?.resumeAllowed === true && validQuote(quote ?? undefined, pending.checkoutId);
  const resolvedWithoutContract = Boolean(attempt && checkedAttempt && status && !status.pending && (!status.subscription || terminalExpired));
  const currentContract = status?.subscription;
  const currentContractPrice = currentContract && Number.isSafeInteger(currentContract.amount) && Number(currentContract.amount) > 0 && typeof currentContract.currency === "string" && /^[A-Z]{3}$/.test(currentContract.currency) && typeof currentContract.cadence === "string" && Object.hasOwn(cadences, currentContract.cadence)
    ? { amount: currentContract.amount!, currency: currentContract.currency, cadence: currentContract.cadence } : null;
  return <div className="notification-billing" aria-label="お支払いの契約">
    <div className="notification-billing-intro"><div><h2>月額プランとお支払い</h2><p>表示された周期で継続課金します。保有する支援者追加枠も引き続き使えます。</p></div><span className="notification-billing-kind">定期的なお支払い</span></div>
    <div className="notification-billing-toolbar"><p>{loading ? "プラン・契約状態を読み込み中…" : options?.environment === "sandbox" && options.configured ? "Squareサンドボックス環境" : "お支払いの契約状態"}</p><Button type="button" variant="outline" disabled={loading || busy || refreshWaiting} onClick={() => void load()}>再読み込み</Button></div>
    {!loading && !status?.subscription && options?.configured ? <ol className="notification-checkout-progress" aria-label="月額プランの申し込み手順">{["プランを選ぶ", "内容・カードを確認", "受付結果を確認"].map((step, index) => <li key={step} aria-current={(pending || attempt ? 2 : quote ? 1 : 0) === index ? "step" : undefined}><span>{index + 1}</span>{step}</li>)}</ol> : null}
    {refresh && (refresh.state !== "checked" || refreshWaiting) ? <p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm">{refresh.state === "checked" ? "Squareで契約・支払い状態を確認しました。" : refresh.state === "failed" ? "Squareとの最新の契約・支払い状態を確認できませんでした。保存された確認結果を表示しています。" : refresh.state === "busy" ? "Squareとの契約状態の確認が進行中です。保存された確認結果を表示しています。" : "Squareとの確認は直前に行われました。保存された確認結果を表示しています。"}{refreshWaiting ? ` 約${Math.ceil(retryDelay / 1000)}秒後に再確認できます。` : " 契約状態の再確認で最新の確認を試せます。"}{pending ? " 未完了の申し込みがあるため、新しい契約は開始できません。" : ""}</p> : null}
    {loadError ? <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{loadError}</p> : null}
    {status?.verificationWarning?.code === "SQUARE_PRORATION_UNVERIFIED" ? <p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{status.verificationWarning.message} 支払いが検証されるまで有償の通知枠は適用されません。解約操作は引き続き利用できます。</p> : null}
    {!loading && options && !options.configured ? <p role="status" className="rounded-lg border p-4 text-sm">有償プランの受付はまだ準備中です。無料枠の通知を引き続き利用できます。</p> : null}
    {!loading && !loadError && status && !status.subscription && !pending && !attempt ? <section aria-label="継続課金の契約状況" className="notification-billing-context"><div><h3 className="text-sm font-semibold">Squareの継続課金契約はありません</h3><p className="notification-card-note">管理者が設定したプランや支援特典を含む現在の利用権は、「利用状況」に表示します。</p></div><a href="/dashboard/automation/support" className="text-primary underline">1回の支援を選ぶ</a></section> : null}
    {status?.subscription ? <section aria-label={terminalExpired ? "前回の契約" : "現在の契約"} className="space-y-3 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">{terminalExpired ? "前回の契約" : "現在の契約"}: {status.subscription.label}</h2>{currentContractPrice ? <p className="text-sm">通常料金: {subscriptionPrice(currentContractPrice)} · {cadences[currentContractPrice.cadence]}（月あたり{subscriptionMonthlyPrice(currentContractPrice)}{subscriptionMonthlyApproximate(currentContractPrice.cadence) ? "・概算" : ""}）</p> : null}<p role="status" className="text-sm">{terminalExpired ? "利用期限終了 · 新しいプランを契約できます" : status.subscription.cancelScheduled ? "解約予定" : status.subscription.active ? "利用中" : "支払い・契約状態を確認中"}</p><dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">支払い確認済みの期間</dt><dd>{jstDate(status.subscription.paidThroughAtMs)}</dd></div><div><dt className="text-muted-foreground">通知枠の利用期限</dt><dd>{jstDate(status.subscription.validUntilAtMs)}</dd></div></dl><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || loading || refreshWaiting} onClick={() => void check()}>契約状態を再確認</Button>{!terminalExpired && !status.subscription.cancelScheduled ? <Button type="button" variant="outline" disabled={busy} onClick={() => setCancelConfirm(true)}>サブスクリプションを解約</Button> : null}</div>{cancelConfirm ? <div className="space-y-3 rounded-lg border p-4 text-sm"><p>今後の継続課金を停止するため、解約を申し込みます。解約後の利用期限はSquareの契約状態に従って表示します。</p><div className="flex flex-wrap gap-2"><Button type="button" variant="destructive" disabled={busy} onClick={() => void cancel()}>解約を申し込む</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setCancelConfirm(false)}>契約を続ける</Button></div></div> : null}</section> : null}
    {(pending || attempt && (!status?.subscription || terminalExpired)) ? <section aria-label="未完了の契約" className="space-y-3 rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">契約の受付結果を確認</h2><p className="text-sm">{resolvedWithoutContract ? "状態を確認しました。現在、新しく作成された契約はありません。" : "受付済みの処理があります。重複を避けるため、新しい契約は開始できません。支払い確認後に通知枠へ適用されます。"}</p>
      {needsStatusRefresh ? <p role="status" className="text-sm">受付状態を再確認してから、再開・中止の内容をもう一度確認してください。</p> : null}
      {canResume && quote ? <section aria-label="受付済み契約の再開確認" className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">受付済みの契約内容を確認して再開</h3><p className="text-sm">{quote.plan.label} · 請求名: {quote.name} · 請求先: {quote.email}</p><PlanDetails plan={quote.plan} />{quote.plan.coupon ? validCouponQuote ? <div aria-label="再開する契約の初回割引" className="text-sm"><p>クーポン: {quote.plan.coupon.label} · {quote.plan.coupon.code}</p><p>初回請求: {subscriptionPrice({ amount: quote.plan.firstAmount!, currency: quote.plan.currency })}</p><p>次回以降: {subscriptionPrice({ amount: quote.plan.regularAmount!, currency: quote.plan.currency })} · {cadences[quote.plan.cadence]}。割引は初回の1回だけです。</p></div> : <p role="alert" className="text-sm text-destructive">初回請求額を確認できませんでした。受付状態を再確認してください。</p> : null}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={busy || loading || needsStatusRefresh || !validCouponQuote} onChange={event => setConsent(event.target.checked)} /><span>Squareに保存済みのカードを使って、この受付済みの契約を再開することに同意します。{quote.plan.coupon && validCouponQuote ? `初回${subscriptionPrice({ amount: quote.plan.firstAmount!, currency: quote.plan.currency })}、次回以降` : ""}{subscriptionPrice(quote.plan)}が{cadences[quote.plan.cadence]}継続課金されます。</span></label><Button type="button" disabled={busy || loading || Boolean(loadError) || needsStatusRefresh || !options?.configured || !consent || !validCouponQuote} onClick={() => void resume()}>保存済みカードで契約を再開</Button></section> : null}
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || loading || refreshWaiting} onClick={() => void check()}>受付状態を再確認</Button>{canRetry ? <Button type="button" disabled={busy} onClick={() => void submit(true)}>同じ受付内容で再試行</Button> : null}{pending?.abortAllowed === true ? <Button type="button" variant="outline" disabled={busy || loading || Boolean(loadError) || needsStatusRefresh} onClick={() => { setAbortConfirmation({ checkoutId: pending.checkoutId }); setActionError(""); }}>申し込みを中止してやり直す</Button> : null}{resolvedWithoutContract ? <Button type="button" variant="outline" disabled={busy} onClick={() => { source.current = null; setAttempt(null); setQuote(null); setConsent(false); setActionError(""); }}>契約内容の選択へ戻る</Button> : null}</div>
      {abortConfirmation && pending?.abortAllowed === true && abortConfirmation.checkoutId === pending.checkoutId ? <div aria-label="申し込み中止の確認" className="space-y-3 rounded-lg border p-4 text-sm"><p>この未完了の申し込みを中止します。入力内容を保持し、現在の料金を確認してから新しい申し込みを開始できます。</p><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={() => void abort()}>確認して申し込みを中止</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setAbortConfirmation(null)}>申し込み中止を取り消す</Button></div></div> : null}
    </section> : null}
    {!blocked && !loading && !loadError && options?.configured && !quote ? <section aria-label="有償プランの選択" className="space-y-4"><h2 className="text-lg font-semibold">有償プランを選ぶ</h2><p className="text-sm text-muted-foreground">選択した支払い間隔の月額換算が安い順に表示しています。年払いなどは、表示された請求額をまとめてお支払いいただきます。</p>{options.plans.length ? <><div className="grid gap-3 md:grid-cols-2">{planGroups.map(({ planId, choices, plan }, index) => <section key={planId} aria-label={`${plan.label}の支払い間隔`} className={`space-y-3 rounded-xl border bg-card p-5 ${selected === plan.variationId ? "border-primary" : ""}`}>
      {currencies.size > 1 && (index === 0 || planGroups[index - 1].plan.currency !== plan.currency) ? <p className="text-xs font-medium text-muted-foreground">{plan.currency}のプラン（月額換算順）</p> : null}
      <label className="flex items-center gap-2"><input type="radio" name="notification-subscription-plan" value={plan.variationId} checked={selected === plan.variationId} disabled={busy} onChange={() => setSelected(plan.variationId)} /><span className="font-semibold">{plan.label}</span></label>
      <PlanDetails plan={plan} monthlyFirst />
      {choices.length > 1 ? <label className="block space-y-1 text-sm"><span className="block">支払い間隔</span><select aria-label={`${plan.label}の支払い間隔を選択`} className="h-10 w-full rounded-md border bg-card px-3 text-sm" value={plan.variationId} disabled={busy} onChange={event => { const variationId = event.target.value; setIntervals(previous => ({ ...previous, [planId]: variationId })); setSelected(variationId); }}>
        {choices.map(choice => <option key={choice.variationId} value={choice.variationId}>{subscriptionIntervalLabels[choice.cadence] ?? cadences[choice.cadence]} · {subscriptionPrice(choice)} / {cadences[choice.cadence]} · 月あたり{subscriptionMonthlyPrice(choice)}{subscriptionMonthlyApproximate(choice.cadence) ? "（概算）" : ""}</option>)}
      </select></label> : null}
    </section>)}</div><form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void review(); }}><label className="min-w-0 flex-1 space-y-1 text-sm"><span className="block">請求名</span><Input autoComplete="name" maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder="カードの名義人のお名前" /></label><label className="min-w-0 flex-1 space-y-1 text-sm"><span className="block">請求先メールアドレス</span><Input type="email" autoComplete="email" maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} placeholder="請求の連絡先" /></label><label className="min-w-0 flex-1 space-y-1 text-sm"><span className="block">クーポンコード（任意）</span><Input value={couponCode} maxLength={64} disabled={busy} onChange={event => setCouponCode(event.target.value)} aria-invalid={!validCouponCode} autoComplete="off" /><span className="block text-xs text-muted-foreground">初回請求だけに適用します。次回以降は通常料金です。</span>{unsupportedCouponPlan ? <span role="status" className="block text-xs text-muted-foreground">日割り・固定課金日のあるプランはクーポンに未対応です。通常の契約内容を確認する場合は、コードを空欄にしてください。</span> : null}</label><Button type="submit" disabled={busy || !selectedPlan || !name.trim() || name.trim().length > 120 || !isPaymentEmail(email.trim()) || !validCouponCode || !availableCoupon}>契約内容を確認</Button></form></> : <p className="rounded-lg border p-4 text-sm">現在、購入できる有償プランはありません。無料枠の通知を引き続き利用できます。</p>}</section> : null}
    {quote && !blocked ? <section aria-label="契約内容の確認" className="space-y-4 rounded-xl border bg-card p-5"><div><h2 className="text-lg font-semibold">{quote.plan.label}の契約内容</h2><p className="mt-1 text-sm text-muted-foreground">Squareで現在の料金・請求周期を確認しました。請求先: {quote.email}</p></div><PlanDetails plan={quote.plan} />{quote.plan.coupon ? <section aria-label="初回請求の割引" className="space-y-2 rounded-lg border p-4 text-sm"><p>適用クーポン: {quote.plan.coupon.label} · {quote.plan.coupon.code}</p>{validCouponQuote ? <><p className="font-semibold">初回請求: {subscriptionPrice({ amount: quote.plan.firstAmount!, currency: quote.plan.currency })}</p><p>次回以降の通常料金: {subscriptionPrice({ amount: quote.plan.regularAmount!, currency: quote.plan.currency })} · {cadences[quote.plan.cadence] ?? "Squareで設定した周期"}</p><p>割引は初回請求の1回だけです。確認済みの金額は契約受付時に再検証します。</p></> : <p role="alert" className="text-destructive">初回請求額を確認できませんでした。プランの選択に戻り、契約内容をもう一度確認してください。</p>}</section> : null}<p className="text-xs text-muted-foreground">この確認の有効期限: {jstDate(quote.expiresAtMs)}</p><div id={cardId} className="min-h-24" aria-label="Squareカード情報" />{!cardReady && !cardError ? <p role="status" className="text-sm">カード入力欄を準備中…</p> : null}{cardError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{cardError}</p><Button type="button" variant="outline" disabled={busy} onClick={() => setCardVersion(version => version + 1)}>カード入力欄を再読み込み</Button></div> : null}<label className="flex items-start gap-2 rounded-lg bg-muted/30 p-3 text-sm"><input type="checkbox" className="mt-1" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>カードをSquareに保存し、{quote.plan.coupon && validCouponQuote ? `初回は${subscriptionPrice({ amount: quote.plan.firstAmount!, currency: quote.plan.currency })}、次回以降は通常料金の` : ""}{subscriptionPrice(quote.plan)}が{cadences[quote.plan.cadence] ?? "Squareで設定した周期"}継続課金されることに同意します。表示された通知枠・送信上限を確認しました。</span></label><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || loading || Boolean(loadError) || !options?.configured || !cardReady || !consent || !validCouponQuote} onClick={() => void submit()}>{busy ? "契約の受付中…" : "同意してサブスクリプションを契約"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { setQuote(null); setConsent(false); source.current = null; setActionError(""); }}>プランの選択に戻る</Button></div><p className="text-xs text-muted-foreground">受付後、支払いを確認してから通知枠へ適用します。</p></section> : null}
    {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}{message ? <p role="status" className="text-sm">{message}</p> : null}
  </div>;
}
