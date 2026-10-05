"use client";

import { useId, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { fieldLabels, valueLabels, predicateHeading, predicateSummary } from "./rule-labels";
import { predicateMode, comparisonMode } from "../../../src/automation/editor-model";

export type RuleNode = { id: string; type: string; config: Record<string, any>; position?: { x: number; y: number }; group?: string };
export type Rule = { schemaVersion: number; name: string; description?: string; nodes: RuleNode[]; edges: { id: string; source: string; target: string; port: string }[]; layout?: any; expiresAfterMinutes?: number };
export type Bindings = { destinations: Record<string, string>; dictionaries: Record<string, { id: string; revision: number }> };
export type AutomationApi = (path: string, method?: string, body?: any) => Promise<any>;
const inputClass = "w-full rounded border bg-background px-2 py-1.5 text-sm";
const buttonClass = "rounded border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40";

export function FlowBlock({ data, selected }: any) {
  return <div className={`min-w-44 rounded-xl border-2 bg-card p-3 shadow-sm ${selected ? "border-primary" : "border-border"}`}>
    {data.kind !== "start" && <Handle type="target" position={Position.Left} />}
    <div className="font-semibold">{data.label}</div>
    {data.groupName && <div className="text-xs text-primary">{data.groupName}</div>}
    <div className="max-w-56 line-clamp-3 whitespace-normal break-words text-sm text-muted-foreground" title={data.summary}>{data.summary}</div>
    {data.outcome && <div className="mt-1 text-xs font-medium">{valueLabels[data.outcome] || ({ scheduled: "条件に一致", excluded: "この経路では送らない", merged: "合流", expired: "期限切れ" } as any)[data.outcome] || data.outcome}</div>}
    {data.onExpand && <button type="button" className="nodrag mt-2 rounded border px-3 py-1 text-sm" onClick={event => { event.stopPropagation(); data.onExpand(); }}>開く</button>}
    <div className="mt-2 flex justify-end gap-4 text-xs">{data.ports.map((p: string, i: number) => <span key={p}>{({ yes: "一致", no: "不一致", unknown: "不明", out: "次へ" } as any)[p]}<Handle id={p} type="source" position={Position.Right} style={{ top: `${25 + i * 25}%` }} /></span>)}</div>
  </div>;
}

export function Select({ value, options, onChange, label }: { value: string; options: (string | { value: string; label: string; disabled?: boolean })[]; onChange: (value: string) => void; label: string }) {
  return <label className="block space-y-1 text-sm"><span>{label}</span><select aria-label={label} className={inputClass} value={value} onChange={e => onChange(e.target.value)}>{options.map(option => typeof option === "string" ? <option key={option} value={option}>{valueLabels[option] || option}</option> : <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></label>;
}
function NumberInput({ label, value, onChange, min = 0, max = 525600 }: any) {
  return <label className="block space-y-1 text-sm">{label}<input aria-label={label} className={inputClass} type="number" min={min} max={max} value={value ?? ""} onChange={e => onChange(Number(e.target.value))} /></label>;
}
function PredicateFields({ predicate, onChange, catalog, depth = 0 }: any) {
  const grouped = ["all", "any", "not"].includes(predicate.op);
  const comparisonOps = catalog.fields[predicate.field] === "number" ? ["eq", "ne", "gt", "gte", "lt", "lte", "in", "exists"] : catalog.fields[predicate.field] === "boolean" ? ["eq", "ne", "in", "exists"] : catalog.fields[predicate.field] === "array" ? ["contains", "notContains", "startsWith", "endsWith", "in", "exists"] : ["eq", "ne", "contains", "notContains", "startsWith", "endsWith", "in", "exists"];
  const type = catalog.fields[predicate.field];
  let canUnwrap = true;
  try { predicateMode(predicate, "compare"); } catch { canUnwrap = false; }
  const height = (p: any): number => p.conditions ? 1 + Math.max(...p.conditions.map(height)) : 0;
  const canWrap = depth + height(predicate) < 8;
  return <div className="automation-predicate-fields space-y-2" data-predicate-editor data-value-kind={type} data-comparison={predicate.op}>
    <Select label="条件の組み立て" value={grouped ? predicate.op : "compare"} options={[{ value: "compare", label: "値を比較", disabled: !canUnwrap }, { value: "all", label: "すべて満たす AND", disabled: !canWrap && !["all", "any"].includes(predicate.op) }, { value: "any", label: "どれかを満たす OR", disabled: !canWrap && !["all", "any"].includes(predicate.op) }, { value: "not", label: "否定 NOT", disabled: !canWrap && predicate.op !== "not" }]} onChange={op => onChange(predicateMode(predicate, op))} />
    {!grouped && <>
      <Select label="判定する項目" value={predicate.field} options={Object.keys(catalog.fields).map(value => ({ value, label: fieldLabels[value] || value }))} onChange={field => onChange({ field, op: "exists" })} />
      <Select label="比較方法" value={predicate.op} options={comparisonOps} onChange={op => onChange(comparisonMode(predicate, op, type))} />
      {predicate.op === "in" ? <div className="space-y-1"><p className="text-sm">いずれかの候補に一致</p>{(predicate.value || []).map((v: any, i: number) => <div className="flex gap-1" key={i}>{type === "boolean" ? <select aria-label={`候補 ${i + 1}`} className={inputClass} value={String(v)} onChange={e => onChange({ ...predicate, value: predicate.value.map((x: any, j: number) => j === i ? e.target.value === "true" : x) })}><option>true</option><option>false</option></select> : <input aria-label={`候補 ${i + 1}`} className={inputClass} type={type === "number" ? "number" : "text"} value={v} onChange={e => onChange({ ...predicate, value: predicate.value.map((x: any, j: number) => j === i ? type === "number" ? Number(e.target.value) : e.target.value : x) })} />}<button aria-label={`候補 ${i + 1} を削除`} onClick={() => onChange({ ...predicate, value: predicate.value.filter((_: any, j: number) => i !== j) })}>×</button></div>)}<button className={buttonClass} disabled={predicate.value?.length >= 100} onClick={() => onChange({ ...predicate, value: [...predicate.value || [], type === "number" ? 0 : type === "boolean" ? false : ""] })}>候補を追加</button></div> : predicate.op !== "exists" && (type === "boolean" ? <Select label="値" value={String(predicate.value)} options={["true", "false"]} onChange={v => onChange({ ...predicate, value: v === "true" })} /> : <label className="block text-sm">値<input aria-label="比較する値" className={inputClass} type={type === "number" ? "number" : "text"} value={predicate.value ?? ""} onChange={e => onChange({ ...predicate, value: type === "number" ? Number(e.target.value) : e.target.value })} /></label>)}
      {type === "string" && <label className="text-sm"><input type="checkbox" checked={!!predicate.ignoreCase} onChange={e => onChange({ ...predicate, ignoreCase: e.target.checked })} /> 大文字小文字を区別しない</label>}
    </>}
  </div>;
}

function PredicateEditor({ predicate, onChange, catalog, disabled = false }: any) {
  const [selectedPath, setSelectedPath] = useState<number[]>([]), [expanded, setExpanded] = useState<string[]>(["root"]);
  const editorId = useId();
  const key = (path: number[]) => path.length ? path.join(".") : "root";
  const address = (path: number[]) => path.length ? path.map(i => i + 1).join(".") : "全体";
  const get = (path: number[]) => path.reduce((p, i) => p?.conditions?.[i], predicate);
  const path = get(selectedPath) ? selectedPath : [], selected = get(path);
  const parent = path.length ? get(path.slice(0, -1)) : null;
  function replace(at: number[], next: any) {
    const visit = (p: any, depth: number): any => depth === at.length ? next : { ...p, conditions: p.conditions.map((child: any, i: number) => i === at[depth] ? visit(child, depth + 1) : child) };
    onChange(visit(predicate, 0));
  }
  function choose(at: number[]) {
    setSelectedPath(at);
    setExpanded(old => [...new Set([...old, ...at.map((_, i) => key(at.slice(0, i))), key(at)])]);
  }
  function row(p: any, at: number[]): React.ReactNode {
    const id = key(at), group = Array.isArray(p.conditions), open = expanded.includes(id), active = key(path) === id;
    return <li key={id}>
      <div className="automation-condition-row" data-condition-path={address(at)}>
        {group ? <button type="button" className="automation-condition-toggle" aria-label={`条件 ${address(at)} の子条件`} aria-expanded={open} aria-controls={`${editorId}-${id}`} onClick={() => setExpanded(old => open ? old.filter(v => v !== id) : [...old, id])}><span aria-hidden="true">{open ? "▾" : "▸"}</span></button> : <span className="automation-condition-leaf" aria-hidden="true">·</span>}
        <button type="button" className="automation-condition-pick" aria-label={`条件 ${address(at)} を編集`} aria-pressed={active} onClick={() => choose(at)}><span className="automation-condition-address">{address(at)}</span><span title={predicateSummary(p)}>{predicateHeading(p)}</span></button>
      </div>
      {group && open && <ul id={`${editorId}-${id}`}>{p.conditions.map((child: any, i: number) => row(child, [...at, i]))}</ul>}
    </li>;
  }
  return <section className="automation-conditions" aria-label="条件の編集">
    <details className="automation-condition-summary"><summary><span className="automation-condition-summary-text">{predicateSummary(predicate)}</span></summary><p>{predicateSummary(predicate)}</p></details>
    <p className="automation-condition-outcomes">一致 / 不一致 / 情報不足（unknown）</p>
    <ul className="automation-condition-tree" aria-label="条件の構造">{row(predicate, [])}</ul>
    <div className="automation-condition-detail" aria-label={`条件 ${address(path)} の設定`} role="group">
      <nav aria-label="条件の階層" className="automation-condition-breadcrumb">{Array.from({ length: path.length + 1 }, (_, i) => <button type="button" key={i} onClick={() => choose(path.slice(0, i))} aria-current={i === path.length ? "location" : undefined}>{address(path.slice(0, i))}</button>)}</nav>
      <fieldset disabled={disabled} className="space-y-2">
        <PredicateFields predicate={selected} onChange={(next: any) => replace(path, next)} catalog={catalog} depth={path.length} />
        {selected.op === "not" && <p className="text-xs text-muted-foreground">NOTでも情報不足は情報不足のままです。</p>}
        {selected.conditions && selected.op !== "not" && <button className={buttonClass} disabled={path.length >= 8 || selected.conditions.length >= 32} onClick={() => { const next = [...path, selected.conditions.length]; replace(path, { ...selected, conditions: [...selected.conditions, { field: "title", op: "contains", value: "" }] }); choose(next); }}>条件を追加</button>}
        {parent?.conditions.length > 1 && <button className={buttonClass} onClick={() => { const up = path.slice(0, -1); replace(up, { ...parent, conditions: parent.conditions.filter((_: any, i: number) => i !== path.at(-1)) }); choose(up); }}>条件を削除</button>}
      </fieldset>
    </div>
  </section>;
}

export function NodeSettings({ node, update, catalog, bindings, disabled = false }: any) {
  const c = node.config, set = (key: string, value: any) => update({ ...c, [key]: value });
  const textInput = (key: string, label: string) => <label className="block space-y-1 text-sm">{label}<input className={inputClass} value={c[key] || ""} onChange={e => set(key, e.target.value)} /></label>;
  if (node.type === "start") return <div className="space-y-2"><p className="text-sm text-muted-foreground">空欄の種類はすべて対象です。</p>{["youtube", "github", "twitch", "spotify", "pixiv", "booth", "amazon", "steam"].map(id => <label key={id} className="block text-sm"><input type="checkbox" checked={(c.providers || []).includes(id)} onChange={e => set("providers", e.target.checked ? [...c.providers || [], id] : c.providers.filter((p: string) => p !== id))} /> {valueLabels[id] || id}</label>)}<p className="pt-2 text-sm">イベント種別（未選択はすべて）</p>{[...new Set(["new", "price", "ReleaseEvent", "PushEvent", ...c.kinds || []])].map(kind => <label key={kind} className="block text-sm"><input type="checkbox" checked={(c.kinds || []).includes(kind)} onChange={e => set("kinds", e.target.checked ? [...c.kinds || [], kind] : c.kinds.filter((v: string) => v !== kind))} /> {valueLabels[kind] || kind}</label>)}</div>;
  if (node.type === "condition") return <PredicateEditor predicate={c.predicate} onChange={(p: any) => set("predicate", p)} catalog={catalog} disabled={disabled} />;
  if (node.type === "merge") return <><Select label="合流の条件" value={c.mode} options={[{ value: "any", label: "どれかの経路が一致" }, { value: "all", label: "すべての経路が一致" }]} onChange={v => set("mode", v)} /><Select label="表示設定が異なる場合" value={c.displayConflict} options={[{ value: "stop", label: "送らずに理由を残す" }, { value: "reset", label: "標準表示に戻す" }]} onChange={v => set("displayConflict", v)} /><p className="text-xs text-muted-foreground">同じ投稿を1件にまとめます。一致した経路の時間・件数制限はすべて守ります。別々の投稿をまとめる場合は「まとめ通知」を使います。</p></>;
  if (node.type === "dictionary") return <><Select label="辞書の差し込み名" value={c.dictionary} options={[...new Set([c.dictionary, ...Object.keys(bindings.dictionaries)])]} onChange={v => set("dictionary", v)} />{Object.entries(catalog.fields).filter(([, type]) => type === "string" || type === "array").map(([key]) => <label className="block text-sm" key={key}><input type="checkbox" checked={c.fields.includes(key)} onChange={e => set("fields", e.target.checked ? [...c.fields, key] : c.fields.filter((v: string) => v !== key))} /> {fieldLabels[key] || key}</label>)}</>;
  if (node.type === "delay") return <><Select label="よく使う遅延" value={String(c.minutes)} options={[...new Set([...catalog.delayPresets, c.minutes])].sort((a: any, b: any) => a - b).map(v => ({ value: String(v), label: `${v}分` }))} onChange={v => set("minutes", Number(v))} /><NumberInput label="遅延（分）" value={c.minutes} onChange={(v: number) => set("minutes", v)} /><Select label="時間の基準" value={c.anchor} options={[{ value: "observed", label: "検知時刻" }, { value: "published", label: "公開時刻" }]} onChange={v => set("anchor", v)} /></>;
  if (node.type === "schedule") return <>
    <Select label="タイムゾーン" value={c.zone} options={[...new Set([c.zone, "Asia/Tokyo", "UTC", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Seoul", "Australia/Sydney"])]} onChange={v => set("zone", v)} />
    <div className="flex flex-wrap gap-2">{["月", "火", "水", "木", "金", "土", "日"].map((label, i) => <label key={label}><input type="checkbox" checked={c.days.includes(i + 1)} onChange={e => set("days", e.target.checked ? [...c.days, i + 1].sort() : c.days.filter((d: number) => d !== i + 1))} />{label}</label>)}</div>
    {["windows", "quiet"].map(key => <div key={key} className="space-y-2"><p>{key === "windows" ? "通知できる時間帯" : "通知しない時間帯"}</p>{c[key].map((w: any, i: number) => <div className="flex gap-1" key={i}>{["start", "end"].map(k => <input key={k} aria-label={`${key} ${k}`} type="time" className={inputClass} value={w[k] === "24:00" ? "00:00" : w[k]} onChange={e => set(key, c[key].map((v: any, j: number) => j === i ? { ...v, [k]: e.target.value === "00:00" && k === "end" ? "24:00" : e.target.value } : v))} />)}<button title="時間帯を削除" onClick={() => set(key, c[key].filter((_: any, j: number) => j !== i))}>×</button></div>)}<button className={buttonClass} onClick={() => set(key, [...c[key], key === "quiet" ? { start: "22:00", end: "09:00" } : { start: "09:00", end: "18:00" }])}>時間帯を追加</button></div>)}
    <label className="block text-sm">除外日を追加<input className={inputClass} type="date" onChange={e => e.target.value && set("datesExcluded", [...new Set([...c.datesExcluded, e.target.value])])} /></label><div className="flex flex-wrap gap-1">{c.datesExcluded.map((d: string) => <button key={d} className={buttonClass} onClick={() => set("datesExcluded", c.datesExcluded.filter((v: string) => v !== d))}>{d} ×</button>)}</div>
    <NumberInput label="最大待機日数" min={1} max={366} value={c.maxWaitDays} onChange={(v: number) => set("maxWaitDays", v)} />
  </>;
  if (node.type === "transform") return <><Select label="表示形式" value={c.format} options={["expanded", "card", "text", "url"]} onChange={v => set("format", v)} /><label className="block text-sm">通知文<textarea className={inputClass} value={c.template} onChange={e => set("template", e.target.value)} rows={4} /></label><Select label="差し込み項目を末尾へ追加" value="" options={[{ value: "", label: "選択" }, ...Object.keys(catalog.fields)]} onChange={v => v && set("template", `${c.template}{${v}}`)} /><NumberInput label="文字数上限" min={1} max={1900} value={c.maxLength} onChange={(v: number) => set("maxLength", v)} /><Select label="メディア表示" value={c.media} options={[{ value: "inherit", label: "現在の設定" }, { value: "hide", label: "非表示" }, { value: "links", label: "リンク" }]} onChange={v => set("media", v)} />{textInput("prefix", "前に付ける文章")}{textInput("suffix", "後に付ける文章")}<p className="text-sm">文字置換</p>{(c.replacements || []).map((r: any, i: number) => <div key={i} className="flex gap-1">{["from", "to"].map(k => <input aria-label={k === "from" ? "置換前" : "置換後"} key={k} className={inputClass} value={r[k]} onChange={e => set("replacements", c.replacements.map((v: any, j: number) => i === j ? { ...v, [k]: e.target.value } : v))} />)}<button onClick={() => set("replacements", c.replacements.filter((_: any, j: number) => i !== j))}>×</button></div>)}<button className={buttonClass} onClick={() => set("replacements", [...c.replacements || [], { from: "対象語", to: "＊＊＊" }])}>置換を追加</button></>;
  if (node.type === "limit" || node.type === "aggregate") return <><NumberInput label="集計する期間（分）" min={1} max={10080} value={c.minutes} onChange={(v: number) => set("minutes", v)} /><Select label="まとめる単位" value={c.key} options={["sourceKey", "author", "providerId", "currency", "all"]} onChange={v => set("key", v)} />{node.type === "limit" ? <><NumberInput label="件数上限" min={1} max={10000} value={c.count} onChange={(v: number) => set("count", v)} /><Select label="超過した通知" value={c.overflow} options={[{ value: "defer", label: "後へ送る" }, { value: "drop", label: "送らない" }]} onChange={v => set("overflow", v)} /></> : <><NumberInput label="まとめる最大件数" min={1} max={100} value={c.maxItems} onChange={(v: number) => set("maxItems", v)} /><Select label="通知する内容" value={c.mode} options={[{ value: "all", label: "すべて" }, { value: "latest", label: "最新だけ" }]} onChange={v => set("mode", v)} /></>}</>;
  if (node.type === "send") return <Select label="送信先の差し込み名" value={c.destination} options={[...new Set(["default", c.destination, ...Object.keys(bindings.destinations)])]} onChange={v => set("destination", v)} />;
  if (node.type === "stop") return textInput("reason", "通知しない理由");
  return null;
}

export { RuleEditor } from "./rule-editor-canvas";
