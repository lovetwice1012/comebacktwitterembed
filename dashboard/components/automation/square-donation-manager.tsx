"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isPaymentEmail } from "@/lib/payment-input";
import { automationResponseError, automationRetryDelay } from "./automation-feedback";
import { loadSquareSubscriptionSDK } from "./subscription-manager";
import type { DonationOptions as Options, DonationStatus as Status, DonationQuote as Quote, DonationHistory } from "../../../src/automation/square-donations";

type DonationAPI = (path: string, method?: string, body?: unknown) => Promise<any>;
type SquareLoader = typeof loadSquareSubscriptionSDK;
type Card = Awaited<ReturnType<ReturnType<Awaited<ReturnType<SquareLoader>>["payments"]>["card"]>>;

export async function donationAPI(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/automation/billing/donations/${path}`, { method, cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw automationResponseError(data, response);
  return data;
}

export function donationAmount(value: string, digits: number): number | null {
  if (!Number.isInteger(digits) || digits < 0 || digits > 3 || value.length > 32 || value.trim() !== value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > digits) return null;
  const amount = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
export function donationMoney(amount: number, currency: string | null): string {
  if (!Number.isSafeInteger(amount) || amount < 0 || !currency || !/^[A-Z]{3}$/.test(currency)) return "金額を確認できません";
  try { const formatter = new Intl.NumberFormat("ja-JP", { style: "currency", currency }); return formatter.format(amount / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2)); }
  catch { return "金額を確認できません"; }
}
const jst = (value: number | null) => value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(value) + " JST" : "期限なし";
const terminalStates = new Set(["COMPLETED", "FAILED", "CANCELED", "REFUNDED", "PARTIALLY_REFUNDED"]);
function paymentLabel(entry: DonationHistory): string {
  if (entry.state === "QUOTED") return "内容確認済み（未送信）";
  if (["FAILED", "CANCELED"].includes(entry.state)) return entry.state === "FAILED" ? "支払い未完了" : "取消";
  if (!entry.verified) return "支払い確認中";
  if (entry.refundedAmount >= entry.amount) return "全額返金";
  if (entry.refundedAmount > 0) return "一部返金";
  return entry.state === "COMPLETED" ? "支払い確定" : "支払い確認中";
}
function safeError(cause: any, fallback: string): string {
  if (automationRetryDelay(cause) !== null) return cause.message;
  const messages: Record<string, string> = {
    SQUARE_DONATION_DISABLED: "現在、寄付の受付を停止しています。入力内容は保持されています。",
    SQUARE_DONATION_AMOUNT_INVALID: "受付できる金額を確認してください。入力内容は保持されています。",
    SQUARE_DONATION_QUOTE_EXPIRED: "確認期限が切れました。金額の入力に戻り、内容をもう一度確認してください。",
    SQUARE_DONATION_POLICY_CONFLICT: "受付条件が変更されました。金額の入力に戻り、現在の条件を確認してください。",
    SQUARE_DONATION_QUOTE_CHANGED: "受付条件が変更されました。金額の入力に戻り、現在の条件を確認してください。",
    SQUARE_DONATION_UNAVAILABLE: "現在、寄付の受付を停止しています。入力内容は保持されています。",
    SQUARE_NAME_REQUIRED: "領収名を1〜120文字で入力してください。入力内容は保持されています。",
    SQUARE_EMAIL_REQUIRED: "領収先メールアドレスを確認してください。入力内容は保持されています。",
  };
  return messages[cause?.code] ?? fallback;
}

export function SquareDonationManager({ api = donationAPI, loadSquare = loadSquareSubscriptionSDK }: { api?: DonationAPI; loadSquare?: SquareLoader }) {
  const [options, setOptions] = useState<Options | null>(null), [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [amount, setAmount] = useState(""), [name, setName] = useState(""), [email, setEmail] = useState(""), [quote, setQuote] = useState<Quote | null>(null), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [attempt, setAttempt] = useState<string | null>(null), [checked, setChecked] = useState(false), [cardReady, setCardReady] = useState(false), [cardError, setCardError] = useState(""), [cardVersion, setCardVersion] = useState(0);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const mounted = useRef(true), loadVersion = useRef(0), actionLock = useRef(false), card = useRef<Card | null>(null), source = useRef<{ attemptId: string; sourceId: string } | null>(null);
  const cardId = `square-donation-card-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const blocked = Boolean(attempt || status?.pending);
  const refresh = status?.refresh;
  const retryAt = Number(refresh?.retryAtMs), retryDelay = Number.isFinite(retryAt) && retryAt > currentTime ? Math.min(24 * 60 * 60 * 1000, retryAt - currentTime) : 0;
  const refreshWaiting = retryDelay > 0;
  const parsed = options?.minorUnitDigits !== null && options?.minorUnitDigits !== undefined ? donationAmount(amount, options.minorUnitDigits) : null;
  const valid = Boolean(options && parsed !== null && options.minimumAmount !== null && options.maximumAmount !== null && parsed >= options.minimumAmount && parsed <= options.maximumAmount && name.trim() && name.trim().length <= 120 && isPaymentEmail(email.trim()));
  async function load() {
    const version = ++loadVersion.current; setLoading(true); setLoadError("");
    const results = await Promise.allSettled([api("options"), api("status")]);
    if (!mounted.current || version !== loadVersion.current) return;
    if (results[0].status === "fulfilled") setOptions(results[0].value);
    if (results[1].status === "fulfilled") { setStatus(results[1].value); setChecked(true); setCurrentTime(Date.now()); }
    if (results.some(result => result.status === "rejected")) setLoadError("寄付の受付条件・支払い状態を取得できませんでした。入力内容を保持しています。再読み込みしてください。");
    setLoading(false);
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loadVersion.current++; source.current = null; }; }, [api]);
  useEffect(() => {
    if (!refreshWaiting) return;
    const timer = setTimeout(() => setCurrentTime(Date.now()), Math.min(1000, retryDelay + 1));
    return () => clearTimeout(timer);
  }, [refreshWaiting, retryDelay, currentTime]);
  useEffect(() => {
    setCardReady(false); setCardError("");
    if (!quote || blocked || !options?.configured || !options.applicationId || !options.locationId || !options.environment) return;
    let active = true, created: Card | null = null, destroyed = false;
    async function destroy() { if (created && !destroyed) { destroyed = true; try { await created.destroy(); } catch { /* The retired frame no longer accepts payment. */ } } }
    void (async () => {
      try {
        const sdk = await loadSquare(options.environment!); if (!active) return;
        created = await sdk.payments(options.applicationId!, options.locationId!).card(); if (!active) { await destroy(); return; }
        await created.attach(`#${cardId}`); if (!active) { await destroy(); return; }
        card.current = created; setCardReady(true);
      } catch { if (active) setCardError("カード入力欄を読み込めませんでした。再読み込みしてください。"); }
    })();
    return () => { active = false; if (card.current === created) card.current = null; void destroy(); };
  }, [quote, blocked, options?.configured, options?.applicationId, options?.locationId, options?.environment, cardId, cardVersion, loadSquare]);
  async function review() {
    if (actionLock.current || blocked || !valid || loading || loadError || !options?.configured || !options.enabled) return;
    actionLock.current = true; setBusy(true); setError(""); setMessage("");
    try { const next: Quote = await api("quote", "POST", { amount: parsed, name: name.trim(), email: email.trim() }); if (mounted.current) { setQuote(next); setConsent(false); source.current = null; } }
    catch (cause) { if (mounted.current) setError(safeError(cause, "寄付内容を確認できませんでした。入力内容を保持しています。時間をおいて再試行してください。")); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit(retry = false) {
    if (actionLock.current || !quote || !consent || loading || loadError || !options?.configured) return;
    if (retry) { if (!status?.pending?.retryable || status.pending.attemptId !== quote.attemptId || source.current?.attemptId !== quote.attemptId) return; }
    else if (blocked || !cardReady || !card.current) return;
    else if (quote.expiresAtMs <= Date.now()) { setError("確認期限が切れました。金額の入力に戻り、内容をもう一度確認してください。"); return; }
    actionLock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      if (!retry) {
        const tokenized = await card.current!.tokenize({ intent: "CHARGE", amount: (quote.amount / 10 ** quote.minorUnitDigits).toFixed(quote.minorUnitDigits), currencyCode: quote.currency, customerInitiated: true, sellerKeyedIn: false, billingContact: { givenName: quote.name, email: quote.email, countryCode: "JP" } });
        if (!mounted.current) return;
        if (tokenized.status !== "OK" || !tokenized.token) { setError("カード情報を確認してください。支払いは実行されていません。"); return; }
        source.current = { attemptId: quote.attemptId, sourceId: tokenized.token };
      }
      if (!mounted.current || source.current?.attemptId !== quote.attemptId) return;
      setAttempt(quote.attemptId); setChecked(false);
      const next: Status = await api("donate", "POST", { attemptId: quote.attemptId, sourceId: source.current.sourceId, consent: true });
      if (mounted.current) { setStatus(next); setChecked(true); setCurrentTime(Date.now()); setMessage("支払いの受付結果を確認しました。確定した結果は寄付履歴に表示されます。"); }
    } catch (cause) {
      if (!mounted.current) return;
      if (source.current) {
        setError(`${automationRetryDelay(cause) !== null ? safeError(cause, "") + " " : ""}支払い結果を確認できませんでした。新しい支払いを始めず、状態を再確認してください。`);
        try { const next: Status = await api("status"); if (mounted.current) { setStatus(next); setChecked(true); setCurrentTime(Date.now()); } } catch { /* An uncertain payment remains blocked. */ }
      } else setError("カード情報を確認できませんでした。入力内容を確認して再試行してください。");
    } finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  async function check() {
    if (actionLock.current || refreshWaiting) return; actionLock.current = true; setBusy(true); setError("");
    try { const next: Status = await api("status"); if (mounted.current) { setStatus(next); setChecked(true); setCurrentTime(Date.now()); setMessage(next.refresh && next.refresh.state !== "checked" ? "保存された支払い結果を取得しました。Squareとの最新の確認状態は下の案内をご覧ください。" : "Squareで支払い状態を再確認しました。"); } }
    catch { if (mounted.current) setError("支払い状態を確認できませんでした。新しい支払いを始めず、再確認してください。"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }
  const current = attempt && status?.history.find(item => item.attemptId === attempt);
  const slotPolicy = options?.slotGrantPolicy;
  const validSlotPolicy = slotPolicy?.currency === "JPY" && slotPolicy.unitAmount === 500 && slotPolicy.slotsPerUnit === 1 && slotPolicy.permanent === true;
  const holding = status?.permanentSupport;
  const validHolding = Boolean(holding && typeof holding.isSupporter === "boolean"
    && [holding.totalSupporterSlots, holding.legacySlots, holding.newPaidSlots].every(value => Number.isSafeInteger(value) && value >= 0)
    && holding.totalSupporterSlots === holding.legacySlots + holding.newPaidSlots);
  const resolved = checked && current && (current.state === "QUOTED" || terminalStates.has(current.state) && (current.verified || ["FAILED", "CANCELED"].includes(current.state))) && !status?.pending;
  const canRetry = Boolean(status?.pending?.retryable && source.current?.attemptId === status.pending.attemptId && quote?.attemptId === status.pending.attemptId && consent);
  return <div className="space-y-5">
    <section aria-label="寄付とX通知の利用条件" className="space-y-2 rounded-xl bg-muted/40 p-4 text-sm"><p>サービスの運営をSquareで支援できます。今回の金額を1回だけ支払い、継続課金は発生しません。</p><p>寄付は寄付として受け付け、そのお礼として申込資格と個人の追加上限を付与します。X通知のベータ版は既存の寄付者が対象です。新しく寄付しても、ベータへの参加やX監視の容量確保を保証するものではありません。</p><p>個人の追加上限と、X監視の共有枠の空きは別です。現在の受付対象・利用枠・共有枠の空きは、通知一覧で確認してください。</p><p className="text-muted-foreground">カード情報はSquareの入力欄で取り扱います。現在の追加登録枠はサーバーの保有記録で確認します。過去の集計値と分けて表示します。</p></section>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted-foreground">{loading ? "受付条件・履歴を読み込み中…" : options?.configured && options.environment === "sandbox" ? "Squareサンドボックス環境" : "寄付の受付条件と履歴"}</p><Button type="button" variant="outline" disabled={loading || busy || refreshWaiting} onClick={() => void load()}>再読み込み</Button></div>
    {refresh && (refresh.state !== "checked" || refreshWaiting) ? <p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm">{refresh.state === "checked" ? "Squareで支払い・返金状態を確認しました。" : refresh.state === "failed" ? "Squareとの最新の支払い・返金状態を確認できませんでした。保存された確認結果を表示しています。" : refresh.state === "busy" ? "Squareとの支払い状態の確認が進行中です。保存された確認結果を表示しています。" : "Squareとの確認は直前に行われました。現在は保存された確認結果を表示しています。"}{refreshWaiting ? ` 約${Math.ceil(retryDelay / 1000)}秒後に再確認できます。` : " 再読み込み、または支払い状態の再確認で最新の確認を試せます。"}{status?.pending ? " 支払い結果が不明な受付があるため、新しい支払いは開始できません。" : ""}</p> : null}
    {loadError ? <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">{loadError}</p> : null}
    {!loading ? <section aria-label="恒久支援枠の保有記録" className="space-y-2 rounded-xl border p-4 text-sm"><h2 className="font-medium">現在の支援者追加枠</h2>
      {validHolding && holding ? <><p>保有合計 {holding.totalSupporterSlots}枠（旧制度・管理者記録 {holding.legacySlots}枠＋新制度の支援決済 {holding.newPaidSlots}枠）</p><p className="text-muted-foreground">寄付へのお礼として個人の総登録上限に加算される枠です。有効期限はなく、月額プランを解約しても保有枠は残ります。</p></> : <p>現在の恒久追加枠を取得できません。旧集計の倍率・口数・期限から個人の利用枠は計算しません。通知一覧でサーバーの利用枠を確認してください。</p>}
    </section> : null}
    {!loading && options ? <section aria-label="寄付の受付条件" className="space-y-2 rounded-xl border p-4 text-sm">
      <p>{options.configured && options.enabled ? `受付金額: ${donationMoney(options.minimumAmount!, options.currency)}〜${donationMoney(options.maximumAmount!, options.currency)}` : "寄付の受付は準備中、または停止中です。無料枠の通知は引き続き利用できます。"}</p>
      <div aria-label="恒久追加枠の付与条件" className="space-y-1">{validSlotPolicy ? <><p>新制度: 検証済みのJPY支援1決済につき、500円ごとに1枠を付与します。500円未満の端数を別決済と合算しません。</p><p>お礼の追加上限に有効期限はありません。新制度の付与条件は、下の旧制度集計用の金額・倍率設定では変わりません。</p>{options.currency !== "JPY" ? <p className="text-muted-foreground">現在の受付通貨は{options.currency ?? "未設定"}です。JPY以外の支払いは新制度の500円ごとの追加枠付与の対象になりません。</p> : null}</> : <p>新制度の恒久追加枠の付与条件を取得できません。旧制度の金額・倍率設定を新制度の付与条件として扱いません。</p>}</div>
      <details aria-label="旧制度の支援集計" className="space-y-2 border-t pt-2"><summary className="cursor-pointer font-medium">旧制度の支援集計（現在の恒久保有枠とは別の記録）</summary>
      <p>{options.supporterThreshold === null ? "旧集計: 支援者枠の自動適用は未設定です。寄付は支払い履歴として記録されます。" : `旧集計: ${options.validityDays === null ? "全期間" : `過去${options.validityDays}日間`}の返金を除いた累計支援額が${donationMoney(options.supporterThreshold, options.currency)}以上かどうかで、旧制度の支援者状態を判定します。${options.validityDays === null ? "集計期間の有効期限はありません。" : "対象期間を過ぎた寄付は累計から外れ、旧制度の適用状態が変わります。"}`}</p>
      {status?.supporter ? <p>現在: {status.supporter.active ? `Square寄付の支援者枠を利用中 · ${jst(status.supporter.validUntilAtMs)}` : status.supporter.manualActive ? "手動で付与された支援者枠を利用中" : "Square寄付による支援者枠の適用なし"} · 対象期間内の正味支援額 {donationMoney(status.supporter.netAmount, options.currency)}</p> : null}
      {status?.supporter && status.supporter.paymentCount !== undefined ? <p className="text-sm">対象期間内の支援回数 {status.supporter.paymentCount}回 · 有効な購入口数 {status.supporter.purchaseUnits}口 · 追加の通知枠 {status.supporter.extraSlots}枠{status.supporter.unitsValidUntilAtMs ? ` · 次に口数が変わる期限 ${jst(status.supporter.unitsValidUntilAtMs)}` : ""}</p> : null}
      {options.unitAmount != null && options.slotsPerUnit != null ? <p className="text-sm">旧集計の設定: 支援1口 {donationMoney(options.unitAmount, options.currency)}につき {options.slotsPerUnit}枠追加の計算値です。返金後の支援額に応じた旧口数を表示しています。現在の恒久保有枠を保証する倍率ではありません。追加枠の配分と確認間隔は通知一覧で選べます。</p> : null}
      </details>
    </section> : null}
    {blocked ? <section aria-label="寄付の受付結果" className="space-y-3 rounded-xl border p-5"><h2 className="text-lg font-semibold">支払い結果を確認</h2><p className="text-sm">{resolved ? current.verified && current.refundedAmount > 0 ? "返金が履歴に反映されました。返金後の累計額と支援者枠の状態を確認できます。" : current.state === "COMPLETED" ? "寄付の支払いが確定しました。履歴と支援者枠の状態を確認できます。" : "今回の支払いは完了していません。新しく寄付内容を確認できます。" : "支払い結果を確認しています。重複を避けるため、新しい支払いは開始できません。"}</p><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy || refreshWaiting} onClick={() => void check()}>支払い状態を再確認</Button>{canRetry ? <Button type="button" disabled={busy} onClick={() => void submit(true)}>同じ受付内容で再試行</Button> : null}{resolved ? <Button type="button" variant="outline" disabled={busy} onClick={() => { source.current = null; setAttempt(null); setQuote(null); setConsent(false); setError(""); }}>新しい寄付内容を入力</Button> : null}</div></section> : null}
    {!blocked && !loading && !loadError && options?.configured && options.enabled && !quote ? <form noValidate aria-label="寄付金額の入力" className="space-y-4 rounded-xl border p-5" onSubmit={event => { event.preventDefault(); void review(); }}>
      <h2 className="text-lg font-semibold">寄付する金額を入力</h2><fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2"><label className="space-y-1 text-sm"><span className="block">寄付金額（{options.currency}）</span><Input inputMode={options.minorUnitDigits ? "decimal" : "numeric"} value={amount} onChange={event => setAmount(event.target.value)} aria-invalid={Boolean(amount) && (parsed === null || parsed < options.minimumAmount! || parsed > options.maximumAmount!)} /><span className="text-xs text-muted-foreground">{donationMoney(options.minimumAmount!, options.currency)}〜{donationMoney(options.maximumAmount!, options.currency)}</span></label><label className="space-y-1 text-sm"><span className="block">領収名</span><Input value={name} maxLength={120} autoComplete="name" onChange={event => setName(event.target.value)} /></label><label className="space-y-1 text-sm sm:col-span-2"><span className="block">領収先メールアドレス</span><Input type="email" value={email} maxLength={254} autoComplete="email" onChange={event => setEmail(event.target.value)} /></label></fieldset><Button type="submit" disabled={busy || !valid}>寄付内容を確認</Button>
    </form> : null}
    {quote && !blocked ? <section aria-label="寄付内容の確認" className="space-y-4 rounded-xl border p-5"><h2 className="text-lg font-semibold">寄付内容の確認</h2><p className="text-2xl font-semibold">{donationMoney(quote.amount, quote.currency)}<span className="ml-2 text-sm font-normal text-muted-foreground">今回1回のみ</span></p><p className="text-sm">領収名: {quote.name}<br />領収先: {quote.email}</p><div id={cardId} aria-label="Squareカード入力欄" />{cardError ? <p role="alert" className="text-sm text-destructive">{cardError}<Button type="button" variant="outline" className="ml-2" disabled={busy} onClick={() => setCardVersion(value => value + 1)}>カード入力欄を再読み込み</Button></p> : !cardReady ? <p role="status" className="text-sm">カード入力欄を読み込み中…</p> : null}<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>{donationMoney(quote.amount, quote.currency)}を今回1回だけ支払うことに同意します。継続課金は発生しません。</span></label><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || !consent || !cardReady || Boolean(loadError)} onClick={() => void submit()}>同意して寄付を支払う</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { source.current = null; setQuote(null); setConsent(false); setError(""); }}>金額の入力へ戻る</Button></div></section> : null}
    {error ? <p role="alert" className="rounded-lg border p-4 text-sm text-destructive">{error}</p> : null}{message ? <p role="status" className="text-sm">{message}</p> : null}
    {status ? <section aria-label="寄付履歴" className="space-y-3"><h2 className="text-lg font-semibold">寄付履歴</h2>{status.history.length ? <div className="overflow-x-auto"><table className="w-full min-w-[32rem] text-left text-sm"><thead><tr><th className="py-2">受付日時</th><th>金額</th><th>返金済み</th><th>支援額</th><th>状態</th></tr></thead><tbody>{status.history.map(item => <tr key={item.attemptId} className="border-t"><td className="py-3">{jst(item.createdAtMs)}</td><td>{donationMoney(item.amount, item.currency)}</td><td>{donationMoney(item.refundedAmount, item.currency)}</td><td>{donationMoney(item.netAmount, item.currency)}</td><td>{paymentLabel(item)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-muted-foreground">寄付履歴はまだありません。</p>}</section> : null}
  </div>;
}
