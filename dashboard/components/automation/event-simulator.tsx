"use client";

import { useEffect, useRef, useState } from "react";
import type { Rule, Bindings, AutomationApi } from "./rule-editor";
import { evaluationKey, fieldLabels, valueLabels } from "./rule-labels";
const field = "w-full rounded border bg-background px-2 py-1.5 text-sm";
const button = "rounded border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40";
const initial = { providerId: "youtube", kind: "new", title: "新作セールのお知らせ", url: "https://www.youtube.com/watch?v=example", discountPercent: 50 };
export function EventSimulator({ value, bindings, catalog, api, disabled, onResult }: { value: Rule; bindings: Bindings; catalog: any; api: AutomationApi; disabled: boolean; onResult?: (result: any) => void }) {
  const [event, setEvent] = useState<any>(initial), [raw, setRaw] = useState(JSON.stringify(initial, null, 2)), [rawMode, setRawMode] = useState(false), [rawError, setRawError] = useState("");
  const [result, setResult] = useState<any>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [time, setTime] = useState("");
  const [more, setMore] = useState(false);
  const runVersion = useRef(0), definitionKey = evaluationKey(value, bindings);
  useEffect(() => { runVersion.current++; setResult(null); setError(""); onResult?.(null); setBusy(false); }, [definitionKey, event, time, rawError, onResult, disabled]);
  const relevant = new Set(["providerId", "kind", "title", "body", "url", ...Object.keys(event)]);
  const collect = (p: any) => { if (p?.field) relevant.add(p.field); for (const child of p?.conditions || []) collect(child); };
  for (const node of value.nodes) { collect(node.config.predicate); for (const name of node.config.fields || []) relevant.add(name); }
  function parseEvent(text: string) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    for (const [key, value] of Object.entries(parsed)) {
      const type = catalog.fields[key];
      if (!type || (value !== null && (type === "array" ? !Array.isArray(value) || value.some(v => typeof v !== "string") : typeof value !== type || type === "number" && !Number.isFinite(value)))) throw new Error();
    }
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== null));
  }
  const update = (next: any) => { setEvent(next); setRaw(JSON.stringify(next, null, 2)); setRawError(""); };
  async function simulate() { const generation = ++runVersion.current; setBusy(true); setError(""); try { const next = await api("simulate", "POST", { definition: value, bindings, event, ...(time ? { now: new Date(time).getTime() } : {}) }); if (generation === runVersion.current) { setResult(next); onResult?.(next); } } catch (e: any) { if (generation === runVersion.current) setError(e.message); } finally { if (generation === runVersion.current) setBusy(false); } }
  return <details className="space-y-3 rounded border p-3"><summary className="font-medium">動きをテスト（実送信なし）</summary>
    <p className="text-xs text-muted-foreground">「取得済み」を外した項目は不明として判定します。実際の監視で取得できる項目はプロバイダーによって異なります。</p>
    <div className="flex flex-wrap gap-2"><button className={button} onClick={() => setRawMode(false)}>入力フォーム</button><button className={button} onClick={() => setRawMode(true)}>JSON入力</button><button className={button} onClick={() => update({ providerId: "amazon", kind: "price", priceAmount: 980, previousPriceAmount: 1500, priceDelta: -520, currency: "JPY", discountPercent: 35, title: "サンプル商品", url: "https://www.amazon.co.jp/dp/B000000000" })}>値下げの例</button><button className={button} onClick={() => update(initial)}>新着の例</button></div>
    {rawError && <p role="alert" className="text-sm text-destructive">{rawError}</p>}
    {rawMode ? <textarea className={`${field} h-44 font-mono`} aria-label="テストイベントJSON" value={raw} onChange={e => { const text = e.target.value; setRaw(text); try { setEvent(parseEvent(text)); setRawError(""); } catch { setRawError("JSONの項目・型を修正してください。最後に有効だったフォームの値は保持しています。"); } }} /> : <div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">{Object.entries(catalog.fields).filter(([key]) => more || relevant.has(key)).map(([key, type]) => <div key={key} className="rounded border p-2"><label className="text-xs"><input type="checkbox" checked={event[key] !== undefined} onChange={e => { const next = { ...event }; if (e.target.checked) next[key] = type === "number" ? 0 : type === "boolean" ? false : type === "array" ? [] : ""; else delete next[key]; update(next); }} /> {fieldLabels[key] || key} を取得済み</label>{event[key] !== undefined && (type === "boolean" ? <select aria-label={fieldLabels[key] || key} className={field} value={String(event[key])} onChange={e => update({ ...event, [key]: e.target.value === "true" })}><option value="true">はい</option><option value="false">いいえ</option></select> : <input aria-label={fieldLabels[key] || key} type={type === "number" ? "number" : "text"} className={field} value={type === "array" ? event[key].join(", ") : event[key]} placeholder={type === "array" ? "カンマで区切る" : ""} onChange={e => update({ ...event, [key]: type === "number" ? Number(e.target.value) : type === "array" ? e.target.value.split(",").map(v => v.trim()).filter(Boolean) : e.target.value })} />)}</div>)}</div>}
    {!rawMode && <button className={button} onClick={() => setMore(!more)}>{more ? "関連する項目だけ" : "すべての項目"}</button>}
    <label className="block text-sm">判定時刻（空欄は現在、入力時はブラウザのタイムゾーン）<input type="datetime-local" className={field} value={time} onChange={e => setTime(e.target.value)} /></label>
    <button className={button} disabled={disabled || busy || !!rawError} onClick={simulate}>判定する</button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <p role="status" className="text-sm">ルールの判定結果です。実配信では機械チェック・宛先権限・件数枠を確認します。内容・権利・通知先の最終判断は利用者が行ってください。</p>}
    {result && <div className="grid gap-3 lg:grid-cols-2"><div className="space-y-2 text-sm">{result.outputs.length ? result.outputs.map((output: any, i: number) => <div key={i} className="rounded bg-muted p-3"><p>{valueLabels[output.destination] || output.destination} / {new Date(output.dueAtMs).toLocaleString()}</p><pre className="whitespace-pre-wrap">{output.text}</pre>{(output.limits.length > 0 || output.aggregate) && <p className="text-xs">実配信では件数枠・集約の状態によってさらに調整されます。</p>}</div>) : <p>このイベントは通知されません。</p>}</div><ol className="max-h-72 space-y-1 overflow-auto text-xs">{result.trace.map((row: any, i: number) => <li key={i} className="rounded border p-2">{catalog.nodes[value.nodes.find(n => n.id === row.nodeId)?.type || ""]?.label || row.nodeId}: {valueLabels[row.outcome] || ({ scheduled: "条件に一致", merged: "合流", excluded: "除外", expired: "期限切れ" } as any)[row.outcome] || row.outcome} {row.reason}{row.detail && <pre className="whitespace-pre-wrap">{JSON.stringify(row.detail)}</pre>}</li>)}</ol></div>}
  </details>;
}
