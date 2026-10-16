"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock3, Layers3, Zap } from "lucide-react";
import { XMonitorMoveEditor } from "../automation/x-monitor-move-editor";
import { parseXMonitor, parseXPool, xCount, xObject, xPoolName, type XMonitor, type XMonitorAPI, type XPool } from "../automation/x-monitor-view";

type Owner = { userId: string; totalSupporterSlots: number; legacySlots: number | null; paidSlots: number | null };
type Issue = { code: string; id?: string; ownerUserId?: string; poolKind?: XMonitor["poolKind"]; used: number | null; limit: number | null };
type Audit = { id: string; actor: string; entity: string; action: string; at: number | null };
type InvalidRegistration = { id: string; ownerUserId: string };
type Summary = { pools: { free: XPool; supporter: XPool }; owners: Owner[]; invalidOwners: string[]; nextCursor: string | null; registrations: (XMonitor & { ownerUserId: string })[]; invalidRegistrations: InvalidRegistration[]; registrationNextCursor: string | null; audits: Audit[]; auditNextCursor: string | null; issues: Issue[] };
type Grant = { id: string; kind: string; slots: number; purchasedSlots: number; amountYen: number | null; refunded: number; financialReview: boolean; at: number | null; actor: string | null; reason: string | null };
type Payment = { id: string; amountYen: number | null; state: string; verified: boolean; at: number | null };
type PaymentScope = { environment: "sandbox" | "production"; merchantId: string };
type History = { grants: Grant[]; payments: Payment[]; paymentScope: PaymentScope | null; nextCursor: string | null; paymentNextCursor: string | null };
type GrantDraft = { userId: string; slots: string; reference: string; reason: string; purchasedAt: string; included: boolean };
const emptyGrant: GrantDraft = { userId: "", slots: "", reference: "", reason: "", purchasedAt: "", included: false };
const numeric = (value: unknown): number | null => xCount(value) ? value : typeof value === "string" && /^\d{1,16}$/u.test(value) && xCount(Number(value)) ? Number(value) : null;
const ownerId = (value: unknown): string => { if (typeof value !== "string" || !/^\d{1,32}$/u.test(value)) throw new Error("Invalid admin owner"); return value; };
function displayDate(value: number | null): string { if (value === null) return "日時未取得"; try { return new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(value) + " JST"; } catch { return "日時未確認"; } }
function receiptTime(value: string): number | undefined | null {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const stamp = Date.parse(`${value}:00+09:00`);
  return Number.isSafeInteger(stamp) && stamp >= 0 && stamp <= Date.now() && new Date(stamp + 9 * 3600000).toISOString().slice(0, 16) === value ? stamp : null;
}
function parseSummary(value: unknown): Summary {
  const data = xObject(value), pools = xObject(data.pools), integrity = xObject(data.integrity);
  if (!Array.isArray(data.owners) || !Array.isArray(data.registrations) || !Array.isArray(data.audits) || !Array.isArray(integrity.issues)) throw new Error("Invalid admin summary");
  return { pools: { free: parseXPool(pools.free), supporter: parseXPool(pools.supporter) },
    owners: data.owners.map(value => { const row = xObject(value); if (!xCount(row.totalSupporterSlots)) throw new Error("Invalid holding"); return { userId: ownerId(row.userId), totalSupporterSlots: row.totalSupporterSlots, legacySlots: numeric(row.legacySlots), paidSlots: numeric(row.paidSlots) }; }),
    invalidOwners: Array.isArray(data.invalidOwners) ? data.invalidOwners.map(value => ownerId(xObject(value).userId)) : [],
    nextCursor: data.nextCursor == null ? null : ownerId(data.nextCursor),
    registrations: data.registrations.map(value => ({ ...parseXMonitor(value), ownerUserId: ownerId(xObject(value).ownerUserId) })),
    invalidRegistrations: Array.isArray(data.invalidRegistrations) ? data.invalidRegistrations.map(value => { const row = xObject(value); if (typeof row.id !== "string" || !/^\d{1,20}$/u.test(row.id)) throw new Error("Invalid diagnostic reference"); return { id: row.id, ownerUserId: ownerId(row.ownerUserId) }; }) : [],
    registrationNextCursor: typeof data.registrationNextCursor === "string" ? data.registrationNextCursor : null,
    auditNextCursor: typeof data.auditNextCursor === "string" ? data.auditNextCursor : null,
    audits: data.audits.map(value => { const row = xObject(value); return { id: String(row.id), actor: typeof row.actor_user_id === "string" && /^\d{1,32}$/u.test(row.actor_user_id) ? row.actor_user_id : "記録なし", entity: typeof row.entity_id === "string" && /^x:\d{1,20}$/u.test(row.entity_id) ? row.entity_id : "登録参照未確認", action: typeof row.action === "string" ? row.action : "", at: numeric(row.created_at_ms) }; }),
    issues: integrity.issues.map(value => { const row = xObject(value); return { code: typeof row.code === "string" ? row.code : "UNKNOWN", used: numeric(row.used), limit: numeric(row.limit), ...(typeof row.id === "string" && /^\d{1,20}$/u.test(row.id) ? { id: row.id } : {}), ...(typeof row.ownerUserId === "string" && /^\d{1,32}$/u.test(row.ownerUserId) ? { ownerUserId: row.ownerUserId } : {}), ...(row.poolKind === "free" || row.poolKind === "supporter" || row.poolKind === "special" ? { poolKind: row.poolKind } : {}) }; }) };
}
function parseHistory(value: unknown): History {
  const data = xObject(value);
  if (!Array.isArray(data.grants) || !Array.isArray(data.payments)) throw new Error("Invalid admin history");
  const scope = data.paymentScope == null ? null : xObject(data.paymentScope);
  if (scope && (!["sandbox", "production"].includes(String(scope.environment)) || typeof scope.merchantId !== "string" || !/^[A-Za-z0-9:_-]{1,255}$/u.test(scope.merchantId)) || data.payments.length && !scope) throw new Error("Invalid payment scope");
  return { grants: data.grants.map(value => { const row = xObject(value); if (!Number.isSafeInteger(row.slots) || !xCount(row.purchasedSlots)) throw new Error("Invalid support grant");
    return { id: String(row.grantId), kind: typeof row.kind === "string" ? row.kind : "", slots: Number(row.slots), purchasedSlots: row.purchasedSlots, amountYen: numeric(row.amountYen), refunded: numeric(row.confirmedRefundedAmount) ?? 0, financialReview: row.financialReviewRequired === true, at: numeric(row.createdAtMs), actor: typeof row.actorUserId === "string" && /^\d{1,32}$/u.test(row.actorUserId) ? row.actorUserId : null, reason: typeof row.reason === "string" && row.reason.length <= 240 ? row.reason : null }; }),
    payments: data.payments.map(value => { const row = xObject(value); if (typeof row.attemptId !== "string") throw new Error("Invalid payment history"); return { id: row.attemptId, amountYen: numeric(row.amountYen ?? (row.currency === "JPY" ? row.amount : null)), state: typeof row.state === "string" ? row.state : "", verified: row.verified === true || row.verified === 1, at: numeric(row.createdAtMs ?? row.created_at_ms) }; }),
    paymentScope: scope ? { environment: scope.environment as PaymentScope["environment"], merchantId: scope.merchantId as string } : null,
    nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null, paymentNextCursor: typeof data.paymentNextCursor === "string" ? data.paymentNextCursor : null };
}
function safeFailure(cause: unknown): string {
  const error = cause && typeof cause === "object" ? cause as { status?: number } : {};
  if (error.status === 401 || error.status === 403) return "管理者権限を確認できません。再ログインして確認してください。";
  if (error.status === 409) return "同じ購入記録で異なる付与が記録されています。入力を保持しています。履歴を確認してください。";
  if (error.status === 422) return "利用者ID・購入記録の参照ID・付与枠数を確認してください。入力内容は保持されています。";
  return "管理情報を取得・保存できませんでした。入力内容を保持して再試行できます。";
}
const grantKind = (kind: string) => ({ historical_admin: "過去購入の管理者記録", square_payment: "検証済み支援決済", manual_adjustment: "管理者による既存枠の調整" } as Record<string, string>)[kind] ?? "支援枠の記録";
const auditAction = (action: string) => ({ "x.quota.allocate": "新規枠割当", "x.quota.release": "登録解除・枠解放", "x.quota.move": "手動の枠変更", "x.quota.manual_move": "手動の枠変更", "x.quota.suspend": "資格・上限による停止", "x.monitor.update": "監視設定変更" } as Record<string, string>)[action] ?? "管理変更";
const issueName = (code: string) => ({ MISSING_POOL_POLICY: "全体枠の設定が未登録", INVALID_POOL_POLICY: "全体枠の設定値が不正", POOL_OVER_LIMIT: "全体枠の上限超過",
  INVALID_REGISTRATION_STATE: "監視状態が不正", MISSING_ALLOCATION: "監視の枠割当が未確認", UNEXPECTED_ALLOCATION: "削除済み監視に枠割当が残存", ORPHANED_PERSONAL_SLOT: "監視に対応する個人枠が未確認",
  DUPLICATE_PERSONAL_SLOT: "監視の個人枠が重複", WRONG_SLOT_OWNER: "監視と個人枠の所有者が不一致", INVALID_NOTIFICATION_SETTINGS: "通知設定が不正", ORPHANED_REGISTRATION: "個人枠に対応する監視登録が未確認",
  INVALID_OWNER: "利用者の参照が不正", INVALID_PERSONAL_ALLOWANCE: "個人上限の設定値が不正", INELIGIBLE_PERSONAL_SLOT: "監視の個人枠が現在の上限対象外", PERSONAL_OVER_LIMIT: "個人の総登録上限超過",
  SUPPORTER_INELIGIBLE: "支援者優先枠の資格が未確認", SUPPORTER_OVER_LIMIT: "個人の保有支援枠を超過", SPECIAL_INELIGIBLE: "有償特殊枠の資格が未確認", SPECIAL_OVER_LIMIT: "プランの特殊枠上限を超過" } as Record<string, string>)[code] ?? "確認が必要な整合性項目";

function Diagnostics({ api, refreshVersion }: { api: XMonitorAPI; refreshVersion: number }) {
  const [summary, setSummary] = useState<Summary | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [user, setUser] = useState(""), [history, setHistory] = useState<History | null>(null), [historyUser, setHistoryUser] = useState(""), [historyError, setHistoryError] = useState("");
  const [draft, setDraft] = useState<GrantDraft>(emptyGrant), [review, setReview] = useState(false), [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const mounted = useRef(false), requests = useRef(0), historyRequest = useRef(0), lock = useRef(false);
  const currentOwner = summary?.owners.find(item => item.userId === draft.userId);
  const load = useCallback(async (afterUserId?: string, afterMonitorId?: string, afterAuditId?: string) => {
    const version = ++requests.current; setLoading(true); setError("");
    const query = new URLSearchParams({ ...(afterUserId ? { afterUserId } : {}), ...(afterMonitorId ? { afterMonitorId } : {}), ...(afterAuditId ? { afterAuditId } : {}) });
    try {
      const next = parseSummary(await api(`push-capacity/admin${query.size ? `?${query}` : ""}`));
      if (!mounted.current || requests.current !== version) return false;
      setSummary(previous => previous && (afterUserId || afterMonitorId || afterAuditId) ? { ...next,
        owners: [...new Map([...previous.owners, ...next.owners].map(item => [item.userId, item])).values()],
        invalidOwners: [...new Set([...previous.invalidOwners, ...next.invalidOwners])],
        registrations: [...new Map([...previous.registrations, ...next.registrations].map(item => [item.id, item])).values()],
        invalidRegistrations: [...new Map([...previous.invalidRegistrations, ...next.invalidRegistrations].map(item => [item.id, item])).values()],
        audits: [...new Map([...previous.audits, ...next.audits].map(item => [item.id, item])).values()],
        nextCursor: afterUserId ? next.nextCursor : previous.nextCursor, registrationNextCursor: afterMonitorId ? next.registrationNextCursor : previous.registrationNextCursor,
        auditNextCursor: afterAuditId ? next.auditNextCursor : previous.auditNextCursor } : next);
      return true;
    } catch (cause) {
      if (mounted.current && requests.current === version) {
        const status = cause && typeof cause === "object" ? (cause as { status?: number }).status : undefined;
        if (status === 401 || status === 403) { setSummary(null); setHistory(null); }
        setError(safeFailure(cause));
      }
      return false;
    } finally { if (mounted.current && requests.current === version) setLoading(false); }
  }, [api]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; requests.current++; historyRequest.current++; }; }, [load, refreshVersion]);
  async function loadHistory(id = user, cursor?: string, afterPaymentId?: string) {
    if (!/^\d{1,32}$/u.test(id)) return;
    const version = ++historyRequest.current; setHistoryError("");
    if (id !== historyUser) { setHistory(null); setHistoryUser(id); }
    try {
      const next = parseHistory(await api(`push-capacity/history?userId=${encodeURIComponent(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${afterPaymentId ? `&afterPaymentId=${encodeURIComponent(afterPaymentId)}` : ""}`));
      if (mounted.current && version === historyRequest.current && (cursor || afterPaymentId) && history && JSON.stringify(history.paymentScope) !== JSON.stringify(next.paymentScope)) { setHistory(null); setHistoryError("決済環境が変わりました。履歴を先頭から取得してください。"); return; }
      if (mounted.current && version === historyRequest.current) { setHistory(previous => (cursor || afterPaymentId) && previous ? { ...next,
        grants: [...new Map([...previous.grants, ...next.grants].map(item => [item.id, item])).values()], payments: [...new Map([...previous.payments, ...next.payments].map(item => [item.id, item])).values()],
        nextCursor: cursor ? next.nextCursor : previous.nextCursor, paymentNextCursor: afterPaymentId ? next.paymentNextCursor : previous.paymentNextCursor } : next); setHistoryUser(id); }
    } catch (cause) { if (mounted.current && version === historyRequest.current) { const error = cause && typeof cause === "object" ? cause as { status?: number; code?: string } : {}; if (error.status === 401 || error.status === 403 || error.code === "INVALID_CURSOR") setHistory(null); setHistoryError(error.code === "INVALID_CURSOR" ? "決済環境または利用者が変わっています。履歴を先頭から取得してください。" : safeFailure(cause)); } }
  }
  const purchasedAtMs = receiptTime(draft.purchasedAt);
  const validGrant = /^\d{1,32}$/u.test(draft.userId) && /^\d+$/u.test(draft.slots) && xCount(Number(draft.slots)) && Number(draft.slots) > 0
    && /^[A-Za-z0-9:_-]{1,255}$/u.test(draft.reference) && draft.reason.trim().length > 0 && draft.reason.length <= 240 && purchasedAtMs !== null;
  function edit<K extends keyof GrantDraft>(key: K, value: GrantDraft[K]) { if (!pending && !lock.current) { setDraft(previous => ({ ...previous, [key]: value })); setReview(false); setNotice(""); } }
  async function grant() {
    if (lock.current || !summary || !validGrant || !review && !pending) return;
    const body = pending ?? { userId: draft.userId, slots: Number(draft.slots), idempotencyKey: draft.reference, reason: draft.reason.trim(), alreadyIncludedInLegacy: draft.included,
      ...(purchasedAtMs === undefined ? {} : { purchasedAtMs }) };
    lock.current = true; requests.current++; setLoading(false); setBusy(true); setError(""); setNotice(""); setPending(body);
    try {
      await api("push-capacity/grants", "POST", body);
      if (!mounted.current) return;
      setPending(null); setDraft(emptyGrant); setReview(false); setNotice("支援枠の購入記録を保存しました。同じ参照IDの再送で二重付与はしません。");
      await load(); setUser(String(body.userId)); await loadHistory(String(body.userId));
    } catch (cause) {
      if (mounted.current) { const status = cause && typeof cause === "object" ? (cause as { status?: number }).status : undefined; if ([401, 403, 409, 422].includes(status ?? 0)) { setPending(null); setReview(false); } if (status === 401 || status === 403) { setSummary(null); setHistory(null); } setError(safeFailure(cause)); }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading || busy} onClick={() => void load()}>使用状況・整合性を更新</Button></div>
    {loading ? <p role="status" className="text-sm">使用状況を取得中…</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
    {summary ? <>
      <section aria-label="全体枠の使用状況" className="space-y-2"><h3 className="font-medium">全体枠の使用・空き</h3><table className="w-full text-left text-sm"><thead><tr><th>区分</th><th>上限</th><th>使用</th><th>空き</th></tr></thead><tbody>{(["free", "supporter"] as const).map(kind => <tr key={kind}><th className="py-1 font-normal">{xPoolName(kind)}</th><td>{summary.pools[kind].limit}</td><td>{summary.pools[kind].used}</td><td>{summary.pools[kind].available}</td></tr>)}</tbody></table>
        <p className="text-xs text-muted-foreground">停止・資格失効中も割当済みの全体枠と個人枠を保持します。空きが戻っても自動移動は行いません。</p></section>
      <section aria-label="利用者の保有支援枠" className="space-y-2"><h3 className="font-medium">利用者の保有支援枠（取得済み{summary.owners.length}人）</h3><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>利用者ID</th><th>保有合計</th><th>旧制度・管理者記録</th><th>新制度の支援決済</th><th>履歴</th></tr></thead><tbody>{summary.owners.map(item => <tr key={item.userId}><td className="py-2">{item.userId}</td><td>{item.totalSupporterSlots}枠</td><td>{item.legacySlots ?? "未取得"}</td><td>{item.paidSlots ?? "未取得"}</td><td><Button size="sm" variant="outline" disabled={busy} onClick={() => { setUser(item.userId); void loadHistory(item.userId); }}>この利用者の履歴</Button></td></tr>)}</tbody></table></div>
        {summary.invalidOwners.map(id => <p key={id} role="alert" className="text-sm text-destructive">利用者 {id} の保有支援枠を確認できません。保存記録の検査が必要です。0枠としては扱いません。</p>)}
        {summary.nextCursor ? <Button variant="outline" disabled={loading || busy} onClick={() => void load(summary.nextCursor!)}>利用者の続きを取得</Button> : null}</section>
      <section aria-label="監視登録の割当診断" className="space-y-2"><h3 className="font-medium">監視登録の消費種別（取得済み{summary.registrations.length}件）</h3>{summary.registrations.map(item => <article key={item.id} aria-label={`管理者のX監視 ${item.id}`} className="space-y-2 rounded border p-3 text-sm"><p>{item.ownerUserId} · {item.name} · X {item.accountId}</p><p>割当: {xPoolName(item.poolKind)} · {item.state === "suspended" ? "停止・枠保持中" : item.enabled ? "登録済み" : "停止中"} · 品質参照: {item.quality.planId}</p>
        <dl aria-label={`監視 ${item.id} の通知方法と使用枠`} className="grid gap-2 sm:grid-cols-2">
          <div><dt className="flex items-center gap-1 text-muted-foreground">{item.processing?.effectiveMode === "realtime" ? <Zap size={14} aria-hidden="true" /> : <Clock3 size={14} aria-hidden="true" />}通知方法</dt><dd>{!item.processing ? "確認待ち" : item.processing.effectiveMode === "realtime" ? "リアルタイム" : item.processing.intervalMinutes === null ? "間隔の設定待ち" : `${item.processing.intervalMinutes}分ごと`}</dd></div>
          <div><dt className="flex items-center gap-1 text-muted-foreground"><Layers3 size={14} aria-hidden="true" />使用する個人枠</dt><dd>{item.processing ? `${item.processing.slotCost}枠` : "確認待ち"}</dd></div>
        </dl>
        <XMonitorMoveEditor row={item} api={api} disabled={busy || loading} onBusy={value => { lock.current = value; setBusy(value); }} onReload={load} onSaved={async saved => { setSummary(previous => previous ? { ...previous, registrations: previous.registrations.map(row => row.id === saved.id ? { ...saved, ownerUserId: item.ownerUserId } : row) } : previous); await load(); }} /></article>)}
        {summary.invalidRegistrations.map(item => <article key={item.id} aria-label={`保存情報が不正なX監視 ${item.id}`} className="rounded border border-destructive/40 p-3 text-sm"><p>利用者 {item.ownerUserId} · 監視 {item.id}</p><p role="alert">監視の保存情報を確認できません。通知設定と保存記録の検査が必要です。未確認の情報で枠を移動しません。</p></article>)}
        {summary.registrationNextCursor ? <Button variant="outline" disabled={loading || busy} onClick={() => void load(undefined, summary.registrationNextCursor!)}>監視登録の続きを取得</Button> : summary.registrations.length >= 200 ? <p className="text-xs text-muted-foreground">監視登録は取得範囲を表示しています。全登録の確認には対象利用者の一覧も確認してください。</p> : null}</section>
      <section aria-label="枠管理の整合性" className="space-y-2"><h3 className="font-medium">整合性の確認</h3>{summary.issues.length ? <ul className="list-inside list-disc text-sm">{summary.issues.map((item, index) => <li key={index}>{issueName(item.code)}{item.ownerUserId ? ` · 利用者 ${item.ownerUserId}` : ""}{item.id ? ` · 監視 ${item.id}` : ""}{item.poolKind ? ` · ${xPoolName(item.poolKind)}` : ""}{item.used !== null && item.limit !== null ? ` · 使用${item.used}／上限${item.limit}` : ""}</li>)}</ul> : <p className="text-sm">今回の検査で整合性の問題は検出されませんでした。</p>}</section>
      <section aria-label="枠変更の監査履歴" className="space-y-2"><h3 className="font-medium">監査記録（取得済み{summary.audits.length}件）</h3><ul className="space-y-1 text-xs">{summary.audits.map(item => <li key={item.id}>{displayDate(item.at)} · {auditAction(item.action)} · 管理者/操作利用者 {item.actor} · {item.entity}</li>)}</ul>{summary.auditNextCursor ? <Button variant="outline" disabled={loading || busy} onClick={() => void load(undefined, undefined, summary.auditNextCursor!)}>監査記録の続きを取得</Button> : null}</section>
    </> : null}
    <section aria-label="支援決済・付与履歴" className="space-y-3 rounded border p-4"><h3 className="font-medium">支援・決済・付与履歴</h3><form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void loadHistory(); }}><label className="text-sm">履歴を確認する利用者ID<Input value={user} inputMode="numeric" maxLength={32} onChange={event => setUser(event.target.value)} /></label><Button disabled={!summary || busy || !/^\d{1,32}$/u.test(user)}>履歴を取得</Button></form>
      {historyError ? <p role="alert" className="text-sm text-destructive">{historyError}</p> : null}{history ? <div className="space-y-2"><p className="text-sm">利用者 {historyUser} の記録です。</p><ul className="space-y-2 text-sm">{history.grants.map(item => <li key={item.id} className="rounded border p-2">{grantKind(item.kind)} · 購入枠{item.purchasedSlots}／追加付与{item.slots}枠 · 金額{item.amountYen === null ? "未記録" : `${item.amountYen.toLocaleString("ja-JP")}円`}<br /><span className="text-xs text-muted-foreground">記録日時 {displayDate(item.at)}{item.actor ? ` · 記録した管理者 ${item.actor}` : ""}{item.financialReview ? ` · 確認済み返金${item.refunded}円、運営による確認が必要` : ""}</span>{item.reason ? <p className="text-xs">記録理由: {item.reason}</p> : null}</li>)}</ul>
        {!history.grants.length ? <p className="text-sm">個別の付与履歴は未記録です。旧制度の保有数は利用者一覧で確認できます。</p> : null}
        {history.paymentScope && <dl className="text-xs"><div><dt>決済環境</dt><dd>{history.paymentScope.environment === "production" ? "本番" : "テスト"}</dd></div><div><dt>加盟店</dt><dd className="break-all">{history.paymentScope.merchantId}</dd></div></dl>}
        <p className="text-xs text-muted-foreground">支援決済の取得記録: {history.payments.length}件</p>{history.payments.map(item => <p className="text-xs" key={item.id}>{displayDate(item.at)} · {item.verified ? "検証済み" : "検証待ち"} · {item.amountYen === null ? "金額未取得" : `${item.amountYen.toLocaleString("ja-JP")}円`} · {({ COMPLETED: "完了", FAILED: "失敗", UNKNOWN: "確認待ち" } as Record<string, string>)[item.state] ?? "状態の確認が必要"}</p>)}
        {history.nextCursor ? <Button variant="outline" disabled={busy} onClick={() => void loadHistory(historyUser, history.nextCursor!)}>付与履歴の続きを取得</Button> : null}
        {history.paymentNextCursor ? <Button variant="outline" disabled={busy} onClick={() => void loadHistory(historyUser, undefined, history.paymentNextCursor!)}>決済履歴の続きを取得</Button> : null}
      </div> : null}</section>
    <section aria-label="管理者による過去購入枠の記録" className="space-y-3 rounded border p-4"><h3 className="font-medium">確認した過去の支援購入を記録</h3><p className="text-xs text-muted-foreground">過去の購入で付与された枠数をそのまま記録します。金額を500円で割って再計算しません。既に保有数へ反映済みなら、記録だけを追加して二重付与を防ぎます。</p>
      <form className="space-y-3" noValidate onSubmit={event => { event.preventDefault(); if (!busy && summary && validGrant && !pending) { setReview(true); setError(""); } }}>
        <fieldset disabled={busy || Boolean(pending) || !summary} className="grid gap-3 sm:grid-cols-2"><label className="text-sm">付与対象の利用者ID<Input value={draft.userId} maxLength={32} inputMode="numeric" onChange={event => edit("userId", event.target.value)} /></label>
          <label className="text-sm">購入で付与された枠数<Input type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} inputMode="numeric" value={draft.slots} onChange={event => edit("slots", event.target.value)} /></label>
          <label className="text-sm">購入記録の参照ID<Input value={draft.reference} maxLength={255} onChange={event => edit("reference", event.target.value)} /><span className="text-xs text-muted-foreground">英数字・コロン・ハイフン・アンダースコア。同じ購入と再試行では同じIDを使います。</span></label>
          <label className="text-sm">購入日時（分かる場合・日本時間）<Input type="datetime-local" value={draft.purchasedAt} onChange={event => edit("purchasedAt", event.target.value)} /></label>
          <label className="text-sm">記録の根拠・理由<Input value={draft.reason} maxLength={240} onChange={event => edit("reason", event.target.value)} /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.included} onChange={event => edit("included", event.target.checked)} />既存の保有枠に反映済み（履歴だけ記録）</label>
        </fieldset>
        {pending ? <div role="status" className="space-y-2 text-sm"><p>保存結果を確定できませんでした。入力を固定し、同じ参照ID・同じ内容だけを再試行します。</p><Button type="button" disabled={busy || !summary} onClick={() => void grant()}>同じ購入記録を再試行</Button></div> : review ? <section aria-label="過去購入枠の記録確認" className="space-y-2 rounded border bg-muted/30 p-3"><p className="text-sm">利用者 {draft.userId} · 購入枠{Number(draft.slots)} · 追加付与{draft.included ? 0 : Number(draft.slots)}枠 · 参照 {draft.reference}</p><p className="text-xs">現在の取得済み保有数: {currentOwner?.totalSupporterSlots ?? "未取得"}枠。購入記録と反映済みの保有数を照合して保存してください。</p><Button type="button" disabled={busy || !summary || !validGrant} onClick={() => void grant()}>確認した購入記録を保存</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setReview(false)}>購入記録の編集に戻る</Button></section> : <Button disabled={busy || !summary || !validGrant}>購入記録の変更を確認</Button>}
      </form>
    </section>
  </div>;
}

export function PushCapacityDiagnostics({ api, refreshVersion = 0 }: { api: XMonitorAPI; refreshVersion?: number }) {
  const [opened, setOpened] = useState(false);
  return <section aria-label="自動展開の使用状況と購入記録" className="space-y-3 border-t pt-4"><h3 className="font-medium">使用状況・付与履歴・割当の診断</h3>
    {!opened ? <Button variant="outline" onClick={() => setOpened(true)}>使用状況・付与履歴を確認</Button> : <Diagnostics api={api} refreshVersion={refreshVersion} />}
  </section>;
}
