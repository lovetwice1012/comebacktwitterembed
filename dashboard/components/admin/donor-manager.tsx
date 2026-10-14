"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { automationResponseError, automationRetryDelay } from "@/components/automation/automation-feedback";
import { donationMoney } from "@/components/automation/square-donation-manager";
import type { DonationHistory } from "../../../src/automation/square-donations";

export type DonorAPI = (path: string, method?: string, body?: unknown) => Promise<any>;
import type { DonorAudit, DonorDetail, DonorListItem as DonorSummary, DonorVersion as Version, DonorPage } from "../../../src/automation/donor-admin";
export type { DonorDetail } from "../../../src/automation/donor-admin";
type DonorList = DonorPage<DonorSummary> & { total: number };
type HistoryPage = DonorPage<DonationHistory>;
type ListQuery = { search: string; cursors: string[] };
const pageSize = 20;
const userIdValid = (value: string) => /^[1-9]\d{0,31}$/.test(value);
const numberValid = (value: string, maximum: number) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= maximum;
const dateLabel = (value: number | null) => value === null ? "期限なし" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(value) + " JST";
const safeError = (cause: any, fallback: string) => automationRetryDelay(cause) !== null ? cause.message : fallback;

export async function donorAPI(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/automation/${path}`, { method, cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw automationResponseError(data, response);
  return data;
}

type Draft = { isDonor: boolean; extraSlots: string; paymentCount: string; purchaseUnits: string; displayName: string; note: string; reason: string };
const draftOf = (detail: DonorDetail): Draft => ({ isDonor: detail.manual.isDonor, extraSlots: String(detail.manual.extraSlots), paymentCount: String(detail.manual.paymentCount), purchaseUnits: String(detail.manual.purchaseUnits), displayName: detail.manual.displayName, note: detail.manual.note, reason: "" });
const sameVersion = (left: Version, right: Version) => left.updatedAtMs === right.updatedAtMs && left.legacyIsDonor === right.legacyIsDonor && left.legacyExtraSlots === right.legacyExtraSlots;

function DonorChangeHistory({ userId, api, refreshKey }: { userId: string; api: DonorAPI; refreshKey: number }) {
  const [opened, setOpened] = useState(false), [data, setData] = useState<DonorPage<DonorAudit> | null>(null);
  const [cursors, setCursors] = useState([""]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), request = useRef(0), retry = useRef([""]), openedRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  async function load(nextCursors: string[]) {
    const generation = ++request.current; retry.current = nextCursors; setBusy(true); setError("");
    const params = new URLSearchParams({ pageSize: String(pageSize) }); if (nextCursors.at(-1)) params.set("cursor", nextCursors.at(-1)!);
    try {
      const next: DonorPage<DonorAudit> = await api(`donors/${encodeURIComponent(userId)}/audit?${params}`);
      if (next.items.some(item => item.userId !== userId)) throw new Error("Wrong audit owner");
      if (alive.current && generation === request.current) { setData(next); setCursors(nextCursors); }
    } catch (cause) { if (alive.current && generation === request.current) setError(safeError(cause, "変更履歴を取得できませんでした。表示中の履歴を保持しています。")); }
    finally { if (alive.current && generation === request.current) setBusy(false); }
  }
  useEffect(() => { if (openedRef.current) void load([""]); }, [refreshKey, api, userId]);
  function toggle() {
    openedRef.current = !openedRef.current; setOpened(openedRef.current);
    if (openedRef.current) void load([""]); else { request.current++; setBusy(false); }
  }
  const rows = (audit: DonorAudit) => [
    { label: "管理用表示名", before: audit.before.displayName || "未設定", after: audit.after.displayName || "未設定" },
    { label: "手動の支援者優先枠", before: audit.before.isDonor ? "有効" : "無効", after: audit.after.isDonor ? "有効" : "無効" },
    { label: "手動の追加通知枠", before: `${audit.before.extraSlots}枠`, after: `${audit.after.extraSlots}枠` },
    { label: "手動で記録した支援回数", before: `${audit.before.paymentCount}回`, after: `${audit.after.paymentCount}回` },
    { label: "手動で記録した購入口数", before: `${audit.before.purchaseUnits}口`, after: `${audit.after.purchaseUnits}口` },
    { label: "管理メモ", before: audit.before.note || "未設定", after: audit.after.note || "未設定" },
  ];
  return <section aria-label="この画面からの変更履歴" className="space-y-3 rounded-lg border p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">この画面からの変更履歴</h3><Button type="button" variant="outline" size="sm" aria-expanded={opened} onClick={toggle}>{opened ? "変更履歴を閉じる" : "変更履歴を表示"}</Button></div>
    <p className="text-xs text-muted-foreground">この管理画面で保存した変更者・変更理由・変更前後の設定を確認できます。以前のDiscord操作など、ほかの管理機能での変更は含まれません。</p>
    {opened ? <>
      {busy ? <p role="status">変更履歴を取得中…</p> : null}
      {error ? <div role="alert" className="space-y-2 text-destructive"><p>{error}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void load(retry.current)}>変更履歴を再取得</Button></div> : null}
      <div aria-busy={busy}>{data?.items.length ? <ul className="space-y-3">{data.items.map(item => <li key={item.id} className="space-y-2 rounded-lg bg-muted/30 p-3"><p className="text-xs text-muted-foreground">{dateLabel(item.createdAtMs)} · 変更者 Discord ID: <span className="break-all">{item.actorUserId}</span></p><p className="whitespace-pre-wrap break-words">変更理由: {item.reason}</p><details><summary className="cursor-pointer font-medium">変更前後の設定を確認</summary><div className="mt-2 overflow-x-auto"><table className="w-full min-w-80 text-left text-xs"><caption className="sr-only">保存時の手動設定の変更前と変更後</caption><thead><tr><th scope="col" className="py-2">項目</th><th scope="col">変更前</th><th scope="col">変更後</th></tr></thead><tbody>{rows(item).map(row => <tr key={row.label}><th scope="row" className="py-2 font-normal">{row.label}</th><td className="max-w-48 whitespace-pre-wrap break-words pr-3">{row.before}</td><td className="max-w-48 whitespace-pre-wrap break-words">{row.after}</td></tr>)}</tbody></table></div></details></li>)}</ul> : data && !busy ? <p className="text-muted-foreground">この画面からの変更履歴はありません。</p> : null}</div>
      <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={busy || cursors.length === 1} onClick={() => void load(cursors.slice(0, -1))}>変更履歴の前へ</Button><span className="text-xs">変更履歴 {cursors.length}ページ</span><Button type="button" variant="outline" size="sm" disabled={busy || !data?.nextCursor} onClick={() => void load([...cursors, data!.nextCursor!])}>変更履歴の次へ</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void load([""])}>最新の変更履歴を確認</Button></div>
    </> : null}
  </section>;
}

function DonorEditor({ detail, api, onSaved, onReload, onBusy }: { detail: DonorDetail; api: DonorAPI; onSaved: (next: DonorDetail) => void; onReload: () => Promise<void>; onBusy: (busy: boolean) => void }) {
  const [draft, setDraft] = useState(() => draftOf(detail)), [confirmation, setConfirmation] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [history, setHistory] = useState<HistoryPage>({ items: detail.square.history, nextCursor: detail.square.historyNextCursor, pageSize });
  const [historyCursors, setHistoryCursors] = useState([""]), [historyBusy, setHistoryBusy] = useState(false), [historyError, setHistoryError] = useState("");
  const [auditRefresh, setAuditRefresh] = useState(0);
  const lock = useRef(false), alive = useRef(true), historyRequest = useRef(0), historyRetry = useRef([""]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; historyRequest.current++; }; }, []);
  useEffect(() => { historyRequest.current++; setHistory({ items: detail.square.history, nextCursor: detail.square.historyNextCursor, pageSize }); setHistoryCursors([""]); historyRetry.current = [""]; setHistoryBusy(false); setHistoryError(""); }, [detail.square.history, detail.square.historyNextCursor]);
  const valid = numberValid(draft.extraSlots, 10000) && numberValid(draft.paymentCount, 1000000) && numberValid(draft.purchaseUnits, 1000000) && draft.displayName.trim().length <= 120 && draft.note.length <= 2000 && draft.reason.trim().length > 0 && draft.reason.trim().length <= 500;
  const changed = !detail.exists || draft.isDonor !== detail.manual.isDonor || Number(draft.extraSlots) !== detail.manual.extraSlots || Number(draft.paymentCount) !== detail.manual.paymentCount || Number(draft.purchaseUnits) !== detail.manual.purchaseUnits || draft.displayName.trim() !== detail.manual.displayName || draft.note.trim() !== detail.manual.note;
  const reviewed = confirmation !== null && sameVersion(confirmation, detail.version);
  const reducesCapacity = numberValid(draft.extraSlots, 10000) && Number(draft.extraSlots) < detail.manual.extraSlots || detail.manual.isDonor && !draft.isDonor;
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(previous => ({ ...previous, [key]: value })); setConfirmation(null); setMessage(""); }
  async function save() {
    if (lock.current || !valid || !reviewed || conflict || uncertain || !confirmation) return;
    lock.current = true; setBusy(true); onBusy(true); setError(""); setMessage("");
    try {
      const next: DonorDetail = await api(`donors/${encodeURIComponent(detail.userId)}`, "PATCH", { isDonor: draft.isDonor, extraSlots: Number(draft.extraSlots), paymentCount: Number(draft.paymentCount), purchaseUnits: Number(draft.purchaseUnits), displayName: draft.displayName.trim(), note: draft.note, reason: draft.reason.trim(), expectedUpdatedAtMs: confirmation.updatedAtMs, expectedLegacyIsDonor: confirmation.legacyIsDonor, expectedLegacyExtraSlots: confirmation.legacyExtraSlots });
      if (alive.current) { onSaved(next); setDraft(draftOf(next)); setConfirmation(null); setConflict(false); setUncertain(false); setAuditRefresh(previous => previous + 1); setMessage("支援者の手動設定と変更理由を保存しました。"); }
    } catch (cause: any) {
      if (alive.current) {
        const stale = cause?.status === 409 || cause?.code === "DONOR_EDIT_CONFLICT", unknown = !stale && cause?.status !== 422;
        setConflict(stale); setUncertain(unknown); setConfirmation(null);
        setError(stale ? "ほかの管理者または既存の管理機能による変更があります。最新の設定を取得し、保持した入力内容と比較してください。" : unknown ? "保存結果を確認できませんでした。入力内容を保持しています。最新の設定を再取得して確認してください。" : safeError(cause, "手動設定を保存できませんでした。入力内容を保持しています。設定を確認して再試行してください。"));
      }
    } finally { lock.current = false; if (alive.current) setBusy(false); onBusy(false); }
  }
  async function reload() {
    if (lock.current) return; lock.current = true; setBusy(true); onBusy(true); setError("");
    try { await onReload(); if (alive.current) { setConflict(false); setUncertain(false); setConfirmation(null); setAuditRefresh(previous => previous + 1); setMessage("最新の設定を取得しました。入力内容を保持しています。変更内容をもう一度確認してください。"); } }
    catch (cause) { if (alive.current) setError(safeError(cause, "最新の設定を取得できませんでした。入力内容を保持して再試行できます。")); }
    finally { lock.current = false; if (alive.current) setBusy(false); onBusy(false); }
  }
  async function loadHistory(cursors: string[]) {
    const request = ++historyRequest.current; historyRetry.current = cursors; setHistoryBusy(true); setHistoryError("");
    const query = new URLSearchParams({ pageSize: String(pageSize) }); if (cursors.at(-1)) query.set("cursor", cursors.at(-1)!);
    try { const next: HistoryPage = await api(`donors/${encodeURIComponent(detail.userId)}/history?${query}`); if (alive.current && request === historyRequest.current) { setHistory(next); setHistoryCursors(cursors); } }
    catch { if (alive.current && request === historyRequest.current) setHistoryError("Squareの支援履歴を取得できませんでした。表示中の履歴を保持しています。"); }
    finally { if (alive.current && request === historyRequest.current) setHistoryBusy(false); }
  }
  const changes = [
    { label: "管理用表示名", before: detail.manual.displayName || "未設定", after: draft.displayName.trim() || "未設定" },
    { label: "手動の支援者優先枠", before: detail.manual.isDonor ? "有効" : "無効", after: draft.isDonor ? "有効" : "無効" },
    { label: "手動の追加通知枠", before: `${detail.manual.extraSlots}枠`, after: `${Number(draft.extraSlots)}枠` },
    { label: "手動で記録した支援回数", before: `${detail.manual.paymentCount}回`, after: `${Number(draft.paymentCount)}回` },
    { label: "手動で記録した購入口数", before: `${detail.manual.purchaseUnits}口`, after: `${Number(draft.purchaseUnits)}口` },
    { label: "管理メモ", before: detail.manual.note || "未設定", after: draft.note || "未設定" },
  ];
  return <article aria-label={`${detail.userId}の支援者設定`} className="min-w-0 space-y-5 rounded-xl border bg-card p-4 sm:p-5">
    <div><h2 className="break-words text-lg font-semibold">{detail.manual.displayName || "支援者の設定"}</h2><p className="break-all text-sm text-muted-foreground">Discord ID: {detail.userId}</p>{!detail.exists ? <p role="status" className="mt-2 text-sm">未登録のユーザーです。変更内容を確認して保存すると、手動管理に登録されます。</p> : null}</div>
    <section aria-label="現在の通知枠" className="space-y-2 rounded-lg bg-muted/40 p-4 text-sm"><h3 className="font-medium">現在の通知枠 · {detail.entitlement.label}</h3><p>合計 {detail.entitlement.slotLimit}枠 · 使用中 {detail.entitlement.usedSlots}枠 · 残り {detail.entitlement.remainingSlots}枠</p>{detail.entitlement.overLimit ? <p role="alert" className="rounded-md border border-destructive/30 p-3 text-destructive">登録済みの通知が現在の通知枠を超えています。登録は保持されますが、枠を超える通知の送信・再開や複数枠を使う高速化が制限されます。利用できる枠を増やすか、使用枠を減らしてください。</p> : null}<p className="text-muted-foreground">1枠あたり1日{detail.entitlement.dayLimit}通・1分{detail.entitlement.minuteLimit}通 · 優先度 {detail.entitlement.priority}</p><p>支援回数の合計: {detail.totals.paymentCount}回（手動 {detail.manual.paymentCount}回・Square {detail.square.paymentCount}回）</p></section>
    <section aria-label="Squareによる支援" className="space-y-3 rounded-lg border p-4 text-sm"><div><h3 className="font-medium">Squareによる支援 · 確認専用</h3><p className="mt-1 text-xs text-muted-foreground">支援回数は全期間の確認済み決済のうち、返金後の支援額が残る決済を数えます。自動の支援者枠・追加枠は現在の金額・対象期間の条件で計算します。</p></div>
      {detail.square.configured ? <><p>確認済みの支援回数: {detail.square.paymentCount}回</p><p>現在の自動付与: 支援者枠 {detail.square.grant.active ? "適用中" : "対象外"} · 対象の購入口数 {detail.square.grant.purchaseUnits}口 · 追加 {detail.square.grant.extraSlots}枠</p><p className="text-xs text-muted-foreground">支援者枠の期限: {detail.square.grant.active ? dateLabel(detail.square.grant.validUntilAtMs) : "対象外"} · 追加枠の期限: {detail.square.grant.extraSlots > 0 ? dateLabel(detail.square.grant.unitsValidUntilAtMs) : "対象外"}{detail.square.environment === "sandbox" ? " · サンドボックスの記録" : ""}</p>
        {detail.square.totalsByCurrency.length ? <ul aria-label="通貨ごとのSquare支援額" className="space-y-1 text-xs text-muted-foreground">{detail.square.totalsByCurrency.map(total => <li key={total.currency}>{total.currency}: 支援 {donationMoney(total.amount, total.currency)} · 返金 {donationMoney(total.refundedAmount, total.currency)} · 累計支援額（返金差引） {donationMoney(total.netAmount, total.currency)}</li>)}</ul> : null}
        <div aria-busy={historyBusy}><h4 className="mb-2 text-sm font-medium">Square支援履歴</h4>{history.items.length ? <ul className="space-y-2">{history.items.map(item => <li key={item.attemptId} className="rounded-lg bg-muted/30 p-3"><p>{donationMoney(item.amount, item.currency)} · {item.verified ? "確認済み" : "未確認"} · {({ COMPLETE: "受付完了", COMPLETED: "受付完了", FAILED: "失敗", UNKNOWN: "結果確認中", SUBMITTING: "処理中" } as Record<string, string>)[item.state] ?? "受付状態を確認中"}</p><p className="text-xs text-muted-foreground">返金 {donationMoney(item.refundedAmount, item.currency)} · 支援額 {donationMoney(item.netAmount, item.currency)} · {dateLabel(item.completedAtMs ?? item.createdAtMs)}</p></li>)}</ul> : <p className="text-muted-foreground">Squareの支援履歴はありません。</p>}</div>
        <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={historyBusy || historyCursors.length === 1} onClick={() => void loadHistory(historyCursors.slice(0, -1))}>履歴の前へ</Button><span className="text-xs">履歴 {historyCursors.length}ページ</span><Button type="button" variant="outline" size="sm" disabled={historyBusy || !history.nextCursor} onClick={() => void loadHistory([...historyCursors, history.nextCursor!])}>履歴の次へ</Button></div>{historyBusy ? <p role="status">履歴を取得中…</p> : null}{historyError ? <div role="alert"><p>{historyError}</p><Button type="button" variant="outline" size="sm" onClick={() => void loadHistory(historyRetry.current)}>履歴を再取得</Button></div> : null}
      </> : <p className="text-muted-foreground">Square連携は未設定です。手動の支援者設定は利用できます。</p>}
    </section>
    <form noValidate className="space-y-4" onSubmit={event => { event.preventDefault(); if (!busy && valid && changed && !conflict && !uncertain) { setConfirmation({ ...detail.version }); setError(""); setMessage(""); } }}>
      <fieldset disabled={busy} className="space-y-4"><legend className="mb-2 font-medium">手動の支援者設定</legend>
        <label className="block space-y-1 text-sm"><span className="block">管理用表示名</span><Input value={draft.displayName} maxLength={120} onChange={event => update("displayName", event.target.value)} placeholder="一覧で見分けるための名前" /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={draft.isDonor} onChange={event => update("isDonor", event.target.checked)} /><span>手動の支援者優先枠を有効にする<span className="mt-1 block text-xs text-muted-foreground">期限なしの付与です。Squareの支援条件を満たすユーザーは、この設定を無効にしても自動の支援者枠が適用されます。</span></span></label>
        <label className="block space-y-1 text-sm"><span className="block">手動の追加通知枠</span><Input type="number" inputMode="numeric" min={0} max={10000} step={1} value={draft.extraSlots} onChange={event => update("extraSlots", event.target.value)} aria-invalid={!numberValid(draft.extraSlots, 10000)} /><span className="block text-xs text-muted-foreground">0〜10,000枠。支援回数・購入口数とは別に指定します。</span></label>
        <div className="grid gap-3 sm:grid-cols-2">{([['paymentCount', '手動で記録した支援回数', '回'], ['purchaseUnits', '手動で記録した購入口数', '口']] as const).map(([key, label, unit]) => <label key={key} className="block space-y-1 text-sm"><span className="block">{label}</span><Input type="number" inputMode="numeric" min={0} max={1000000} step={1} value={draft[key]} onChange={event => update(key, event.target.value)} aria-invalid={!numberValid(draft[key], 1000000)} /><span className="block text-xs text-muted-foreground">0〜1,000,000{unit}。履歴の管理用記録です。</span></label>)}</div>
        <p className="text-xs text-muted-foreground">記録した回数・口数から通知枠や支援金額を自動で計算しません。追加する枠数を上の欄で指定してください。</p>
        <label className="block space-y-1 text-sm"><span className="block">管理メモ</span><textarea className="min-h-24 w-full rounded-md border bg-card px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={draft.note} maxLength={2000} onChange={event => update("note", event.target.value)} placeholder="支援の経緯など、管理者向けの記録" /><span className="block text-xs text-muted-foreground">管理画面内のメモです。カード情報や決済の認証情報は入力しないでください。</span></label>
        <label className="block space-y-1 text-sm"><span className="block">変更理由（必須）</span><textarea className="min-h-20 w-full rounded-md border bg-card px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={draft.reason} maxLength={500} onChange={event => update("reason", event.target.value)} placeholder="付与・修正の理由" aria-invalid={Boolean(draft.reason) && !draft.reason.trim()} /></label>
      </fieldset>
      {confirmation ? <section aria-label="支援者設定の変更確認" className="space-y-3 rounded-lg border border-primary/30 bg-muted/30 p-4"><h3 className="font-medium">変更内容を確認 · {detail.userId}</h3><div className="overflow-x-auto"><table className="w-full min-w-80 text-left text-sm"><caption className="sr-only">手動設定の現在の値と保存後の値</caption><thead><tr><th scope="col" className="py-2">項目</th><th scope="col">現在</th><th scope="col">保存後</th></tr></thead><tbody>{changes.map(item => <tr key={item.label}><th scope="row" className="py-2 font-normal">{item.label}</th><td className="max-w-48 whitespace-pre-wrap break-words pr-3">{item.before}</td><td className="max-w-48 whitespace-pre-wrap break-words font-medium">{item.after}</td></tr>)}</tbody></table></div><p className="whitespace-pre-wrap break-words text-sm">変更理由: {draft.reason.trim()}</p><p className="text-xs text-muted-foreground">Squareによる自動付与や有償プランを含め、保存後の通知枠は最新の条件で計算されます。</p>{reducesCapacity ? <p role="status" className="rounded-md border border-amber-300/40 bg-amber-50/10 p-3 text-sm">手動の追加枠または支援者優先枠を減らす変更です。実際の通知枠・優先度はSquareによる自動付与や有償プランの状態にもよります。既存の通知は削除されませんが、枠が不足すると超過する通知の送信・再開や複数枠を使う高速化が制限されます。</p> : null}{!reviewed ? <p role="alert" className="text-sm text-destructive">現在の設定が更新されました。編集に戻り、最新の値ともう一度比較してください。</p> : null}<div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || !reviewed || conflict || uncertain || !valid} onClick={() => void save()}>{busy ? "保存中…" : "この支援者設定で保存"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>支援者設定の編集に戻る</Button></div></section> : <Button type="submit" disabled={busy || !valid || !changed || conflict || uncertain}>支援者設定の変更を確認</Button>}
    </form>
    {error ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p>{conflict || uncertain ? <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>最新の支援者設定を再取得</Button> : null}</div> : null}{message ? <p role="status" className="text-sm">{message}</p> : null}
    <DonorChangeHistory userId={detail.userId} api={api} refreshKey={auditRefresh} />
  </article>;
}

export function DonorManager({ api = donorAPI }: { api?: DonorAPI }) {
  const [list, setList] = useState<DonorList | null>(null), [query, setQuery] = useState<ListQuery>({ search: "", cursors: [""] }), [search, setSearch] = useState("");
  const [listBusy, setListBusy] = useState(true), [listError, setListError] = useState("");
  const [idInput, setIdInput] = useState(""), [selected, setSelected] = useState(""), [detail, setDetail] = useState<DonorDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false), [detailError, setDetailError] = useState(""), [writing, setWriting] = useState(false);
  const alive = useRef(true), listRequest = useRef(0), detailRequest = useRef(0), selectedRef = useRef(""), writeLock = useRef(false), retryList = useRef(query);
  async function loadList(next: ListQuery) {
    const request = ++listRequest.current; retryList.current = next; setListBusy(true); setListError("");
    const params = new URLSearchParams({ pageSize: String(pageSize) }); if (next.search) params.set("search", next.search); if (next.cursors.at(-1)) params.set("cursor", next.cursors.at(-1)!);
    try { const result: DonorList = await api(`donors?${params}`); if (alive.current && request === listRequest.current) { setList(result); setQuery(next); } }
    catch (cause) { if (alive.current && request === listRequest.current) setListError(safeError(cause, "支援者一覧を取得できませんでした。表示中の一覧を保持しています。")); }
    finally { if (alive.current && request === listRequest.current) setListBusy(false); }
  }
  async function loadDetail(userId: string, preserve = false) {
    if (!userIdValid(userId) || writeLock.current && !preserve) return;
    const request = ++detailRequest.current; selectedRef.current = userId; setSelected(userId); setDetailBusy(true); setDetailError("");
    try { const next: DonorDetail = await api(`donors/${encodeURIComponent(userId)}`); if (alive.current && request === detailRequest.current && selectedRef.current === userId) { if (next.userId !== userId) throw new Error("Wrong user detail"); setDetail(next); } }
    catch (cause) { if (alive.current && request === detailRequest.current && selectedRef.current === userId) { setDetailError(safeError(cause, "支援者の設定を取得できませんでした。ユーザーを再確認してください。")); if (preserve) throw cause; } }
    finally { if (alive.current && request === detailRequest.current) setDetailBusy(false); }
  }
  useEffect(() => { alive.current = true; void loadList({ search: "", cursors: [""] }); return () => { alive.current = false; listRequest.current++; detailRequest.current++; }; }, [api]);
  function saved(next: DonorDetail) { if (selectedRef.current !== next.userId) return; setDetail(next); detailRequest.current++; setDetailBusy(false); setDetailError(""); void loadList(retryList.current); }
  const current = detail?.userId === selected ? detail : null;
  return <div className="space-y-5">
    <section className="space-y-2 rounded-xl bg-muted/40 p-4 text-sm"><p>支援者優先枠と追加通知枠をユーザーごとに付与・管理します。変更理由を記録し、保存前に変更内容を確認できます。</p><p className="text-muted-foreground">手動の支援者設定は期限なしです。Squareから自動で付与される枠・確認済みの支援履歴も確認できます。</p></section>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <section aria-label="支援者一覧" className="min-w-0 space-y-4 rounded-xl border p-4">
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void loadList({ search: search.trim(), cursors: [""] }); }}><label className="block space-y-1 text-sm"><span className="block">Discord ID・管理用表示名で検索</span><Input value={search} maxLength={120} onChange={event => setSearch(event.target.value)} placeholder="ID、または登録した表示名" /></label><div className="flex flex-wrap gap-2"><Button type="submit" variant="outline">検索</Button><Button type="button" variant="ghost" onClick={() => { setSearch(""); void loadList({ search: "", cursors: [""] }); }}>検索を解除</Button></div></form>
        {list ? <p className="text-xs text-muted-foreground">{query.search ? `「${query.search}」の検索結果 · ` : ""}{list.total}人 · {query.cursors.length}ページ</p> : null}
        {listBusy ? <p role="status" className="text-sm">支援者一覧を取得中…</p> : null}
        {listError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{listError}</p><Button type="button" variant="outline" size="sm" disabled={listBusy} onClick={() => void loadList(retryList.current)}>一覧を再取得</Button></div> : null}
        <div aria-busy={listBusy}>{list?.items.length ? <ul className="space-y-2">{list.items.map(item => <li key={item.userId}><button type="button" disabled={writing} aria-current={selected === item.userId ? "true" : undefined} className={`w-full space-y-1 rounded-lg border p-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected === item.userId ? "border-primary bg-primary/5" : "hover:bg-muted"}`} onClick={() => void loadDetail(item.userId)}><span className="block break-words font-medium">{item.manual.displayName || item.userId}</span><span className="block break-all text-xs text-muted-foreground">Discord ID: {item.userId}</span><span className="block text-xs">{item.manual.isDonor ? "手動の支援者" : ""}{item.manual.isDonor && item.square.active ? " · " : ""}{item.square.active ? "Squareの支援者" : ""}{!item.manual.isDonor && !item.square.active ? "支援履歴・手動記録" : ""}</span><span className="block text-xs text-muted-foreground">支援 {item.totals.paymentCount}回（手動 {item.manual.paymentCount}・Square {item.square.paymentCount}） · 手動記録 {item.manual.purchaseUnits}口</span></button></li>)}</ul> : list ? <p className="py-3 text-sm text-muted-foreground">一致する支援者はいません。Discord IDを指定して新しく登録できます。</p> : null}</div>
        <div className="flex flex-wrap items-center justify-between gap-2"><Button type="button" variant="outline" size="sm" disabled={listBusy || query.cursors.length === 1} onClick={() => void loadList({ ...query, cursors: query.cursors.slice(0, -1) })}>前のページ</Button><Button type="button" variant="outline" size="sm" disabled={listBusy || !list?.nextCursor} onClick={() => void loadList({ ...query, cursors: [...query.cursors, list!.nextCursor!] })}>次のページ</Button></div>
        <form className="space-y-2 border-t pt-4" onSubmit={event => { event.preventDefault(); if (userIdValid(idInput.trim())) void loadDetail(idInput.trim()); }}><label className="block space-y-1 text-sm"><span className="block">Discord IDから登録・編集</span><Input value={idInput} maxLength={32} inputMode="numeric" onChange={event => setIdInput(event.target.value)} placeholder="支援者のユーザーID" aria-invalid={Boolean(idInput) && !userIdValid(idInput.trim())} /></label><Button type="submit" variant="outline" disabled={writing || !userIdValid(idInput.trim())}>このユーザーの設定を開く</Button></form>
      </section>
      <section aria-label="選択した支援者" className="min-w-0 space-y-3">
        {detailBusy ? <p role="status" className="text-sm">Discord ID {selected} の設定を取得中…</p> : null}
        {detailError ? <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 p-4 text-sm text-destructive"><p>{detailError}</p><Button type="button" variant="outline" disabled={detailBusy || writing} onClick={() => void loadDetail(selected)}>設定を再取得</Button></div> : null}
        {current ? <DonorEditor key={current.userId} detail={current} api={api} onSaved={saved} onReload={() => loadDetail(current.userId, true)} onBusy={value => { writeLock.current = value; setWriting(value); }} /> : !detailBusy && !detailError ? <p className="rounded-xl border bg-muted/20 p-5 text-sm text-muted-foreground">一覧から支援者を選ぶか、Discord IDを指定して設定を開いてください。</p> : null}
      </section>
    </div>
  </div>;
}
