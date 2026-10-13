"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { AlertTriangle, Bell, Clock3, FlaskConical } from "lucide-react";
import type { Rule, Bindings, AutomationApi } from "./rule-editor";
import { evaluationKey, fieldLabels, valueLabels } from "./rule-labels";
const field = "w-full rounded border bg-background px-2 py-1.5 text-sm";
const button = "rounded border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40";
const initial = { providerId: "youtube", kind: "new", title: "新作セールのお知らせ", url: "https://www.youtube.com/watch?v=example", discountPercent: 50 };
function sampleEvent(rule: Rule) {
  let provider = rule.nodes.find(n => n.type === "start")?.config.providers?.[0];
  const findProvider = (p: any): string | undefined => p?.field === "providerId" && p.op === "eq" ? p.value : p?.field === "providerId" && p.op === "in" ? p.value?.[0] : p?.op === "all" || p?.op === "any" ? p.conditions?.map(findProvider).find(Boolean) : undefined;
  const priceCondition = (p: any): boolean => ["priceAmount", "previousPriceAmount", "priceDelta", "discountPercent", "currency", "available"].includes(p?.field) || !!p?.conditions?.some(priceCondition);
  const wantsPrice = rule.nodes.some(n => priceCondition(n.config.predicate)) || rule.nodes.find(n => n.type === "start")?.config.kinds?.includes("price");
  provider ||= rule.nodes.map(n => findProvider(n.config.predicate)).find(Boolean) || (wantsPrice ? "amazon" : "youtube");
  const price = ["amazon", "steam"].includes(provider);
  const kind = rule.nodes.find(n => n.type === "start")?.config.kinds?.[0] || (price ? "price" : provider === "github" ? "ReleaseEvent" : "new");
  return price ? { providerId: provider, kind, title: "サンプル商品のセール", url: "https://example.com/item", priceAmount: 980, previousPriceAmount: 1500, priceDelta: -520, currency: "JPY", discountPercent: 35, available: true } : { ...initial, providerId: provider, kind };
}
export function EventSimulator({ value, bindings, catalog, api, disabled, onResult, open, onOpenChange, panelRef }: { value: Rule; bindings: Bindings; catalog: any; api: AutomationApi; disabled: boolean; onResult?: (result: any) => void; open?: boolean; onOpenChange?: (open: boolean) => void; panelRef?: Ref<HTMLDetailsElement> }) {
  const [event, setEvent] = useState<any>(() => sampleEvent(value)), [raw, setRaw] = useState(() => JSON.stringify(sampleEvent(value), null, 2)), [rawMode, setRawMode] = useState(false), [rawError, setRawError] = useState("");
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
  return <details ref={panelRef} open={open} onToggle={e => onOpenChange?.(e.currentTarget.open)} className="studio-test-panel space-y-3 rounded border p-3"><summary className="font-medium">通知をテスト</summary>
    <div className="studio-test-heading"><h2>サンプル入力</h2><p className="studio-critical-note"><FlaskConical size={14} aria-hidden="true" />Discordには送信しません</p></div>
    <p className="studio-critical-note text-xs text-muted-foreground"><AlertTriangle size={13} aria-hidden="true" />未取得の項目は「情報不足」として判定</p>
    <div className="studio-test-presets flex flex-wrap gap-2"><button className={button} aria-pressed={!rawMode} onClick={() => setRawMode(false)}>フォーム</button><button className={button} aria-pressed={rawMode} onClick={() => setRawMode(true)}>JSON入力</button><button className={button} onClick={() => update(sampleEvent(value))}>ルールのサンプル</button><button className={button} onClick={() => update({ providerId: "amazon", kind: "price", priceAmount: 980, previousPriceAmount: 1500, priceDelta: -520, currency: "JPY", discountPercent: 35, title: "サンプル商品", url: "https://www.amazon.co.jp/dp/B000000000" })}>値下げのサンプル</button><button className={button} onClick={() => update(initial)}>新着のサンプル</button></div>
    {rawError && <p role="alert" className="text-sm text-destructive">{rawError}</p>}
    {rawMode ? <textarea className={`${field} h-44 font-mono`} aria-label="テストイベントJSON" value={raw} onChange={e => { const text = e.target.value; setRaw(text); try { setEvent(parseEvent(text)); setRawError(""); } catch { setRawError("JSONの項目名・値の形式を確認してください。"); } }} /> : <div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">{Object.entries(catalog.fields).filter(([key]) => more || relevant.has(key)).map(([key, type]) => <div key={key} className="studio-test-trace rounded border p-2"><label className="text-xs"><input type="checkbox" checked={event[key] !== undefined} onChange={e => { const next = { ...event }; if (e.target.checked) next[key] = type === "number" ? 0 : type === "boolean" ? false : type === "array" ? [] : ""; else delete next[key]; update(next); }} /> {fieldLabels[key] || key} を取得済み</label>{event[key] !== undefined && (type === "boolean" ? <select aria-label={fieldLabels[key] || key} className={field} value={String(event[key])} onChange={e => update({ ...event, [key]: e.target.value === "true" })}><option value="true">はい</option><option value="false">いいえ</option></select> : <input aria-label={fieldLabels[key] || key} type={type === "number" ? "number" : "text"} className={field} value={type === "array" ? event[key].join(", ") : event[key]} placeholder={type === "array" ? "カンマで区切る" : ""} onChange={e => update({ ...event, [key]: type === "number" ? Number(e.target.value) : type === "array" ? e.target.value.split(",").map(v => v.trim()).filter(Boolean) : e.target.value })} />)}</div>)}</div>}
    {!rawMode && <button className={button} onClick={() => setMore(!more)}>{more ? "関連する項目だけ" : "すべての項目"}</button>}
    <label className="block text-sm">判定時刻（端末の時間帯）<input aria-label="判定時刻" title="空欄は現在時刻" type="datetime-local" className={field} value={time} onChange={e => setTime(e.target.value)} /></label>
    <div className="studio-test-run"><button className={`${button} automation-save-primary`} disabled={disabled || busy || !!rawError} onClick={simulate}>{busy ? "判定中…" : "判定する"}</button>{disabled && <span className="studio-critical-note"><AlertTriangle size={13} aria-hidden="true" />ルールの確認が必要です</span>}</div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <div className="studio-test-result"><p role="status" className="studio-critical-note"><FlaskConical size={16} aria-hidden="true" />{result.outputs.length ? `通知予定 ${result.outputs.length}件` : "このサンプルは通知しません"}</p><p className="studio-critical-note text-xs"><AlertTriangle size={13} aria-hidden="true" />実際の配信には宛先の権限・件数制限が適用されます</p></div>}
    {result && <div className="grid gap-3 lg:grid-cols-2"><div className="space-y-2 text-sm">{result.outputs.length ? result.outputs.map((output: any, i: number) => <div key={i} className="rounded bg-muted p-3"><div className="studio-test-output-meta"><span className="studio-critical-note"><Bell size={13} aria-hidden="true" />{valueLabels[output.destination] || output.destination}</span><span className="studio-critical-note"><Clock3 size={13} aria-hidden="true" />{new Date(output.dueAtMs).toLocaleString()}</span></div><pre className="whitespace-pre-wrap">{output.text}</pre>{(output.limits.length > 0 || output.aggregate) && <p className="studio-critical-note text-xs"><AlertTriangle size={12} aria-hidden="true" />件数制限・まとめ通知により配信内容が変わる場合があります</p>}</div>) : null}</div><ol className="max-h-72 space-y-1 overflow-auto text-xs">{result.trace.map((row: any, i: number) => <li key={i} className="studio-test-trace rounded border p-2"><strong>{catalog.nodes[value.nodes.find(n => n.id === row.nodeId)?.type || ""]?.label || row.nodeId}</strong><span>{valueLabels[row.outcome] || ({ scheduled: "条件に一致", merged: "合流", excluded: "除外", expired: "期限切れ" } as any)[row.outcome] || row.outcome}</span>{row.reason && <span>{row.reason}</span>}</li>)}</ol></div>}
  </details>;
}
