"use client";

import { useEffect, useState } from "react";
import type { AutomationApi } from "./rule-editor";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
const field = "rounded border bg-background px-3 py-2 text-sm";
const states: Record<string, string> = { pending: "予約・再試行待ち", held: "旧版の未完了処理", leased: "準備中", sending: "送信中", aggregated: "まとめ通知へ集約", sent: "送信済み", unknown: "送信結果不明", partial: "一部送信済み", failed: "失敗", expired: "期限切れ", cancelled: "取り消し", excluded: "送信対象外" };
function reason(code?: string) {
  if (code === "AGGREGATE_SUPERSEDED") return "後から届いた内容に置き換え、最新の通知だけを送ります。";
  if (code === "LEGACY_REVIEW_ENDED") return "旧版の未完了処理を終了しました。内容・通知先を確認してください。送信実績のない失敗は再試行できます。";
  if (["SAFETY_VERIFIER_UNAVAILABLE", "SAFETY_CHECK_TIMEOUT", "SAFETY_CHECK_FAILED", "SAFETY_INVALID_ASSESSMENT", "SAFETY_DEPENDENCIES_UNAVAILABLE"].includes(code || "")) return "機械チェックに失敗したため送信しませんでした。時間をおいて再試行してください。";
  if (code === "SAFETY_PACKAGE_REVOKED" || code === "SAFETY_DICTIONARY_REVOKED") return "使用中の共有ルール・辞書が停止されています。使用するルール・辞書を見直してください。";
  return code?.startsWith("SAFETY_") ? "機械チェックで送信対象外になりました。内容・リンク・添付・通知先を確認して修正してください。" : code;
}
export function DeliveryHistory({ api, canEdit }: { api: AutomationApi; canEdit: boolean }) {
  const [state, setState] = useState(""), [items, setItems] = useState<any[]>([]), [cursor, setCursor] = useState<string | null>(null), [selected, setSelected] = useState<any>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [due, setDue] = useState(""), [excluded, setExcluded] = useState<any[] | null>(null);
  const load = async (after?: string) => { const result = await api(`jobs?state=${state}${after ? `&cursor=${after}` : ""}`); setItems(old => after ? [...old, ...result.items] : result.items); setCursor(result.nextCursor); };
  const task = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  useEffect(() => { let alive = true; api(`jobs?state=${state}`).then(result => { if (alive) { setItems(result.items); setCursor(result.nextCursor); } }).catch(e => alive && setError(e.message)); return () => { alive = false; }; }, [api, state]);
  async function change(action: string) {
    const result = await api(`jobs/${selected.id}`, "PATCH", { action, expectedVersion: selected.version, dueAtMs: action === "reschedule" ? new Date(due).getTime() : undefined });
    await load(); setSelected(await api(`jobs/${selected.id}`));
    setNotice(action === "reschedule" ? `通知可能時間を守り、${new Date(result.dueAtMs).toLocaleString()} に予約しました。` : "配信を更新しました。");
  }
  return <section className="space-y-4 rounded border bg-card p-4"><h2 className="font-semibold">配信予定・履歴</h2><p className="text-sm text-muted-foreground">ルールを適用した版と観測した内容を保存します。結果不明・一部送信済みの通知は自動で再送しません。</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <div className="flex flex-wrap gap-2"><select className={field} aria-label="配信状態で絞り込み" value={state} onChange={e => setState(e.target.value)}><option value="">すべて</option>{Object.entries(states).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><button className={button} disabled={busy} onClick={() => void task(() => load())}>再読み込み</button><button className={button} disabled={busy} onClick={() => void task(async () => setExcluded((await api("excluded")).items))}>フィルターで除外した通知</button></div>
    {excluded && <details open className="rounded border p-3"><summary>除外理由（最大50件）</summary>{excluded.length ? excluded.map(row => <div key={row.id} className="mt-2 border-t py-2 text-sm"><p>{row.event.title || row.event.url || row.id}</p><ul className="list-inside list-disc text-xs">{row.trace.map((trace: any, i: number) => <li key={i}>{trace.nodeId}: {trace.outcome} {trace.reason || ""}</li>)}</ul></div>) : <p className="text-sm">除外された通知はまだありません。</p>}</details>}
    <div className="grid gap-2 md:grid-cols-2">{items.map(row => <button key={row.id} className="space-y-1 rounded border p-3 text-left" onClick={() => void task(async () => { setSelected(await api(`jobs/${row.id}`)); setDue(""); })}><div className="text-xs">{states[row.state] || row.state} · {row.providerId} · {row.ruleRevision ? `ルール版 ${row.ruleRevision}` : "通常通知"}</div><p className="break-all text-sm font-medium">{row.title || row.url || row.id}</p><p className="text-xs text-muted-foreground">{new Date(row.dueAtMs).toLocaleString()} {reason(row.errorCode)}</p></button>)}</div>{!items.length && <p className="text-sm">該当する配信はまだありません。</p>}{cursor && <button className={button} disabled={busy} onClick={() => void task(() => load(cursor))}>続きを読み込む</button>}
    {selected && <div className="space-y-3 rounded border p-4"><h3 className="font-semibold">配信の詳細</h3><p className="text-sm">{states[selected.state]} / 送信確認 {selected.sentSteps}件 / {selected.aggregateItems ? selected.aggregateMode === "latest" ? `${selected.aggregateReceived || selected.aggregateItems}件から最新${selected.aggregateItems}件を通知` : `${selected.aggregateItems}件をまとめ通知` : "単独通知"}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">{selected.preview}</pre>
      {selected.errorCode && <p className="text-sm">{reason(selected.errorCode)}</p>}
      <ol className="space-y-1 text-xs">{selected.trace.map((trace: any, i: number) => <li key={i}>{trace.nodeId} → {trace.outcome}{trace.reason ? `: ${trace.reason}` : ""}{trace.dueAtMs ? ` (${new Date(trace.dueAtMs).toLocaleString()})` : ""}</li>)}</ol>
      {selected.parentJobId && <button className={button} onClick={() => void task(async () => setSelected(await api(`jobs/${selected.parentJobId}`)))}>まとめ通知の親を開く</button>}
      {!selected.parentJobId && (selected.scope !== "guild" || canEdit) && <div className="space-y-2">{["pending", "held", "leased"].includes(selected.state) && <><label className="block text-sm">配信時刻（このブラウザのタイムゾーン）<input type="datetime-local" className={field + " ml-2"} value={due} onChange={e => setDue(e.target.value)} /></label><button className={button} disabled={busy || !due} onClick={() => void task(() => change("reschedule"))}>通知可能時間内で予約し直す</button><button className={button} disabled={busy} onClick={() => { if (confirm("この配信を取り消しますか？")) void task(() => change("cancel")); }}>配信を取り消す</button></>}{selected.state === "failed" && selected.sentSteps === 0 && !selected.snapshotInvalid && <button className={button} disabled={busy} onClick={() => { if (confirm("送信実績のない失敗通知を再試行しますか？")) void task(() => change("retry")); }}>再試行する</button>}</div>}
      {["unknown", "partial"].includes(selected.state) && <p className="text-sm text-muted-foreground">Discord側で実際の通知を確認してください。重複を防ぐため、この状態から自動・手動の一括再送は行いません。</p>}
      <details><summary className="text-sm">取得時のデータ</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(selected.event, null, 2)}</pre></details>
      {selected.aggregateMode === "latest" && selected.aggregateReceived > 1 && <details><summary className="text-sm">まとめ通知の最初のイベント</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(selected.originalEvent, null, 2)}</pre></details>}
    </div>}
  </section>;
}
