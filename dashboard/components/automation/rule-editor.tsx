"use client";

import { useEffect, useId, useState } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./studio-inline.css";
import { fieldLabels, valueLabels, predicateHeading, predicateSummary } from "./rule-labels";
import { predicateMode, comparisonMode } from "../../../src/automation/editor-model";
import { Play, GitBranch, BookOpen, Merge, Clock3, CalendarClock, Gauge, Layers3, SlidersHorizontal, Bell, CircleStop, Plus, Settings2, Check, Pencil, AlertTriangle } from "lucide-react";

export type RuleNode = { id: string; type: string; config: Record<string, any>; position?: { x: number; y: number }; group?: string };
export type Rule = { schemaVersion: number; name: string; description?: string; nodes: RuleNode[]; edges: { id: string; source: string; target: string; port: string }[]; layout?: any; expiresAfterMinutes?: number };
export type Bindings = { destinations: Record<string, string>; dictionaries: Record<string, { id: string; revision: number }> };
export type AutomationApi = (path: string, method?: string, body?: any) => Promise<any>;
const inputClass = "w-full rounded border bg-background px-2 py-1.5 text-sm";
const buttonClass = "rounded border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40";
const numberInputValue = (value: string) => value === "" ? "" : Number(value);

export function FlowBlock({ id, data, selected }: any) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { if (id && typeof window.DOMMatrixReadOnly === "function") updateNodeInternals(id); }, [id, data.editing, updateNodeInternals]);
  const Icon = ({ start: Play, condition: GitBranch, dictionary: BookOpen, merge: Merge, delay: Clock3, schedule: CalendarClock, limit: Gauge, aggregate: Layers3, transform: SlidersHorizontal, send: Bell, stop: CircleStop } as any)[data.kind] || Layers3;
  const editing = !!data.editing && !!data.node;
  return <div className={`studio-flow-block ${selected ? "studio-flow-block-selected" : ""} ${editing ? "studio-flow-block-editing" : ""}`} data-kind={data.kind}>
    {data.kind !== "start" && <Handle type="target" position={Position.Left} aria-label={`${data.label}に接続`} title="このブロックへ線をつなぐ" role={data.onTarget ? "button" : undefined} tabIndex={data.onTarget && !data.locked ? 0 : -1} aria-disabled={!!data.locked} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); if (!data.locked) data.onTarget?.(); } }} onClickCapture={event => { event.stopPropagation(); if (!data.locked) data.onTarget?.(); }} />}
    <div className="studio-flow-heading"><span className="studio-flow-icon"><Icon size={18} aria-hidden="true" /></span><strong>{data.label}</strong>{data.onEdit && <button type="button" className="nodrag nopan" aria-label={`${data.label}の設定を${editing ? "閉じる" : "開く"}`} title={editing ? "編集を閉じる" : "ブロック内で編集"} onClick={event => { event.stopPropagation(); if (editing) data.onCloseEdit?.(); else data.onEdit(); }}>{editing ? <Check size={16} aria-hidden="true" /> : <Settings2 size={16} aria-hidden="true" />}</button>}</div>
    {data.groupName && <div className="studio-flow-group">{data.groupName}</div>}
    {!editing && (data.onEdit ? <button type="button" className="nodrag nopan studio-flow-summary studio-flow-summary-edit" title="内容を編集" aria-label={`${data.label}の内容を編集`} onClick={event => { event.stopPropagation(); data.onEdit(); }}><span>{data.summary}</span><Pencil size={13} aria-hidden="true" /></button> : <p className="studio-flow-summary" title={data.summary}>{data.summary}</p>)}
    {editing && <div className="studio-flow-inline nodrag nopan nowheel" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onContextMenu={event => { if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) event.stopPropagation(); }} onKeyDown={event => { if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) event.stopPropagation(); }}>
      <NodeSettings node={data.node} catalog={data.catalog} bindings={data.bindings} resources={data.resources} onBindingsChange={data.onBindingsChange} disabled={!!data.locked} update={(config: any, nextBindings?: Bindings) => { if (!data.locked) data.onConfig?.(config, nextBindings); }} />
      <button type="button" className="studio-inline-done" onClick={() => data.onCloseEdit?.()}><Check size={14} aria-hidden="true" />編集を閉じる</button>
    </div>}
    {data.detached && <p className="studio-flow-detached"><AlertTriangle size={12} aria-hidden="true" />未接続</p>}
    {data.outcome && <div className="studio-flow-outcome"><Check size={12} aria-hidden="true" />{valueLabels[data.outcome] || ({ scheduled: "通知する", excluded: "この経路では送らない", merged: "合流", expired: "期限切れ" } as any)[data.outcome] || data.outcome}</div>}
    {data.onExpand && <button type="button" className="nodrag studio-flow-expand" onClick={event => { event.stopPropagation(); data.onExpand(); }}>グループを開く</button>}
    <div className="studio-flow-ports">{data.ports.map((p: string) => <div className="studio-flow-port" key={p} data-port={p} data-linking={data.linkingPort === p || undefined}><span>{({ yes: "一致したら", no: "一致しなければ", unknown: "情報が足りなければ", out: "次へ" } as any)[p] || p}</span>{data.onAdd && <button type="button" className={`nodrag nopan studio-flow-add ${!data.connectedPorts?.includes(p) ? "studio-flow-add-next" : ""}`} disabled={data.locked} aria-label={`${data.label}の${valueLabels[p] || p}にブロックを追加`} title="次のブロックを追加" onClick={event => { event.stopPropagation(); data.onAdd(p); }}><Plus size={15} aria-hidden="true" />{!data.connectedPorts?.includes(p) && <span>追加</span>}</button>}<Handle id={p} type="source" position={Position.Right} aria-label={`${data.label}の${valueLabels[p] || p}から接続`} title="線をドラッグ、または押して接続先を選ぶ" role={data.onPort ? "button" : undefined} tabIndex={data.onPort && !data.locked ? 0 : -1} aria-pressed={data.linkingPort === p} aria-disabled={!!data.locked} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); if (!data.locked) data.onPort?.(p); } }} onClickCapture={event => { event.stopPropagation(); if (!data.locked) data.onPort?.(p); }} /></div>)}</div>
    {!data.ports.length && data.onAdd && <button type="button" disabled={data.locked} className="nodrag nopan studio-flow-before" onClick={event => { event.stopPropagation(); data.onAdd("out"); }}><Plus size={14} aria-hidden="true" />この前に追加</button>}
  </div>;
}

export function Select({ value, options, onChange, label }: { value: string; options: (string | { value: string; label: string; disabled?: boolean })[]; onChange: (value: string) => void; label: string }) {
  return <label className="studio-setting-select block space-y-1 text-sm"><span>{label}</span><select aria-label={label} className={inputClass} value={value} onChange={e => onChange(e.target.value)}>{options.map(option => typeof option === "string" ? <option key={option} value={option}>{valueLabels[option] || option}</option> : <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></label>;
}
function NumberInput({ label, value, onChange, min = 0, max = 525600 }: any) {
  return <label className="studio-setting-number block space-y-1 text-sm">{label}<input aria-label={label} className={inputClass} type="number" min={min} max={max} value={value ?? ""} onChange={e => onChange(numberInputValue(e.target.value))} /></label>;
}
function ChoiceButtons({ label, value, choices, onChange }: any) {
  return <div className="studio-inline-choices" role="group" aria-label={label}>{choices.map((choice: any) => <button key={String(choice.value)} type="button" aria-pressed={value === choice.value} onClick={() => onChange(choice.value)}>{choice.label}</button>)}</div>;
}
function PredicateFields({ predicate, onChange, onAddCondition, catalog, depth = 0 }: any) {
  const grouped = ["all", "any", "not"].includes(predicate.op);
  const comparisonOps = catalog.fields[predicate.field] === "number" ? ["eq", "ne", "gt", "gte", "lt", "lte", "in", "exists"] : catalog.fields[predicate.field] === "boolean" ? ["eq", "ne", "in", "exists"] : catalog.fields[predicate.field] === "array" ? ["contains", "notContains", "startsWith", "endsWith", "in", "exists"] : ["eq", "ne", "contains", "notContains", "startsWith", "endsWith", "in", "exists"];
  const type = catalog.fields[predicate.field];
  let canUnwrap = true;
  try { predicateMode(predicate, "compare"); } catch { canUnwrap = false; }
  const height = (p: any): number => p.conditions ? 1 + Math.max(...p.conditions.map(height)) : 0;
  const canWrap = depth + height(predicate) < 8;
  return <div className="automation-predicate-fields space-y-2" data-predicate-editor data-value-kind={type} data-comparison={predicate.op}>

    {!grouped && <>
      <div className="studio-predicate-sentence">
        <Select label="判定する項目" value={predicate.field} options={Object.keys(catalog.fields).map(value => ({ value, label: fieldLabels[value] || value }))} onChange={field => {
          const nextType = catalog.fields[field];
          const op = nextType === type ? predicate.op : nextType === "number" ? "gte" : nextType === "boolean" ? "eq" : "contains";
          onChange(comparisonMode({ ...predicate, field, op: nextType === type ? predicate.op : "" }, op, nextType));
        }} />
        <span className="studio-sentence-particle">が</span>
        {predicate.op !== "exists" && predicate.op !== "in" && (type === "boolean" ? <Select label="値" value={String(predicate.value)} options={["true", "false"]} onChange={v => onChange({ ...predicate, value: v === "true" })} /> : <input autoFocus aria-label="比較する値" className={`${inputClass} studio-predicate-value`} type={type === "number" ? "number" : "text"} value={predicate.value ?? ""} placeholder={type === "number" ? "例：30" : predicate.field === "author" ? "例：作者名" : predicate.field === "language" ? "例：ja" : "例：セール"} onChange={e => onChange({ ...predicate, value: type === "number" ? numberInputValue(e.target.value) : e.target.value })} />)}
        <Select label="比較方法" value={predicate.op} options={comparisonOps.map(value => ({ value, label: ({ eq: "と一致する", ne: "と一致しない", contains: "を含む", notContains: "を含まない" } as any)[value] || valueLabels[value] }))} onChange={op => onChange(comparisonMode(predicate, op, type))} />
      </div>
      {predicate.op === "in" && <div className="studio-predicate-candidates"><span>候補のいずれかに一致</span>{(predicate.value || []).map((v: any, i: number) => <div className="flex gap-1" key={i}>{type === "boolean" ? <select aria-label={`候補 ${i + 1}`} className={inputClass} value={String(v)} onChange={e => onChange({ ...predicate, value: predicate.value.map((x: any, j: number) => j === i ? e.target.value === "true" : x) })}><option value="true">はい</option><option value="false">いいえ</option></select> : <input aria-label={`候補 ${i + 1}`} className={inputClass} type={type === "number" ? "number" : "text"} value={v ?? ""} onChange={e => onChange({ ...predicate, value: predicate.value.map((x: any, j: number) => j === i ? type === "number" ? (e.target.value === "" ? null : numberInputValue(e.target.value)) : e.target.value : x) })} />}<button type="button" aria-label={`候補 ${i + 1} を削除`} onClick={() => onChange({ ...predicate, value: predicate.value.filter((_: any, j: number) => i !== j) })}>×</button></div>)}<button type="button" className={buttonClass} disabled={predicate.value?.length >= 100} onClick={() => onChange({ ...predicate, value: [...predicate.value || [], type === "number" ? 0 : type === "boolean" ? false : ""] })}><Plus size={14} aria-hidden="true" />候補を追加</button></div>}
      {type === "string" && <label className="studio-inline-checkbox"><input type="checkbox" checked={!!predicate.ignoreCase} onChange={e => onChange({ ...predicate, ignoreCase: e.target.checked })} /> 大文字小文字を区別しない</label>}
      <div className="studio-condition-combine"><button type="button" disabled={!canWrap} onClick={() => onAddCondition("all")}><Plus size={14} aria-hidden="true" />条件を追加（かつ）</button><button type="button" disabled={!canWrap} onClick={() => onAddCondition("any")}><Plus size={14} aria-hidden="true" />条件を追加（または）</button></div>
    </>}
    <details className="studio-inline-advanced" open={grouped || undefined}><summary>{grouped ? "条件の組み合わせ" : "反転・条件の組み合わせ"}</summary><Select label="条件の組み立て" value={grouped ? predicate.op : "compare"} options={[{ value: "compare", label: "値を比較", disabled: !canUnwrap }, { value: "all", label: "すべて満たす", disabled: !canWrap && !["all", "any"].includes(predicate.op) }, { value: "any", label: "どれかを満たす", disabled: !canWrap && !["all", "any"].includes(predicate.op) }, { value: "not", label: "条件を否定", disabled: !canWrap && predicate.op !== "not" }]} onChange={op => onChange(predicateMode(predicate, op))} /></details>
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
    {predicate.conditions && <details className="automation-condition-summary"><summary><span className="automation-condition-summary-text">{predicateSummary(predicate)}</span></summary><p>{predicateSummary(predicate)}</p></details>}
    {predicate.conditions && <ul className="automation-condition-tree" aria-label="条件の構造">{row(predicate, [])}</ul>}
    <div className="automation-condition-detail" aria-label={`条件 ${address(path)} の設定`} role="group">
      {predicate.conditions && <nav aria-label="条件の階層" className="automation-condition-breadcrumb">{Array.from({ length: path.length + 1 }, (_, i) => <button type="button" key={i} onClick={() => choose(path.slice(0, i))} aria-current={i === path.length ? "location" : undefined}>{address(path.slice(0, i))}</button>)}</nav>}
      <fieldset disabled={disabled} className="space-y-2">
        <PredicateFields key={key(path)} predicate={selected} onChange={(next: any) => replace(path, next)} onAddCondition={(op: string) => { replace(path, { op, conditions: [selected, { field: "title", op: "contains", value: "" }] }); choose([...path, 1]); }} catalog={catalog} depth={path.length} />
        {selected.op === "not" && <p className="studio-inline-note"><AlertTriangle size={12} aria-hidden="true" />情報不足の判定は反転しません</p>}
        {selected.conditions && selected.op !== "not" && <button className={buttonClass} disabled={path.length >= 8 || selected.conditions.length >= 32} onClick={() => { const next = [...path, selected.conditions.length]; replace(path, { ...selected, conditions: [...selected.conditions, { field: "title", op: "contains", value: "" }] }); choose(next); }}>条件を追加</button>}
        {parent?.conditions.length > 1 && <button className={buttonClass} onClick={() => { const up = path.slice(0, -1); replace(up, { ...parent, conditions: parent.conditions.filter((_: any, i: number) => i !== path.at(-1)) }); choose(up); }}>条件を削除</button>}
      </fieldset>
    </div>
  </section>;
}

function resourceAlias(kind: string, nodeId: string, current: string, map: Record<string, any>): string {
  const base = `${kind}_${nodeId.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 58);
  // A node-specific binding prevents changing another block that uses an imported shared alias.
  if (current === base || current.startsWith(`${base}_`) && /^\d+$/.test(current.slice(base.length + 1))) return current;
  let alias = base, suffix = 1;
  while (Object.hasOwn(map, alias)) alias = `${base}_${suffix++}`;
  return alias;
}

export function NodeSettings(props: any) {
  return <fieldset disabled={props.disabled && props.node.type !== "condition"} className="studio-node-settings"><NodeSettingsContent {...props} update={(config: any, nextBindings?: Bindings) => { if (!props.disabled) props.update(config, nextBindings); }} /></fieldset>;
}
function NodeSettingsContent({ node, update, catalog, bindings, resources, disabled = false }: any) {
  const c = node.config, set = (key: string, value: any) => update({ ...c, [key]: value });
  const textInput = (key: string, label: string) => <label className="block space-y-1 text-sm">{label}<input aria-label={label} className={inputClass} value={c[key] || ""} onChange={e => set(key, e.target.value)} /></label>;
  const chips = (key: string, values: string[], label: string) => <div className="studio-inline-chip-group" role="group" aria-label={label}><button type="button" aria-pressed={!c[key]?.length} onClick={() => set(key, [])}>すべて</button>{values.map(id => <label key={id} className="studio-inline-chip"><input aria-label={valueLabels[id] || id} type="checkbox" checked={(c[key] || []).includes(id)} onChange={e => set(key, e.target.checked ? [...c[key] || [], id] : c[key].filter((v: string) => v !== id))} /><span>{valueLabels[id] || id}</span></label>)}</div>;
  const advanced = (label: string, contents: React.ReactNode) => <details className="studio-inline-advanced"><summary>{label}</summary><div className="studio-inline-advanced-body">{contents}</div></details>;
  if (node.type === "start") return <>
    <p className="studio-inline-caption">サービス</p>
    {chips("providers", [...new Set(["youtube", "github", "twitch", "spotify", "pixiv", "booth", "amazon", "steam", ...c.providers || []])], "受け取るサービス")}
    <p className="studio-inline-caption">更新の種類</p>{chips("kinds", [...new Set(["new", "price", "ReleaseEvent", "PushEvent", ...c.kinds || []])], "受け取る更新")}
  </>;
  if (node.type === "condition") return <PredicateEditor predicate={c.predicate} onChange={(p: any) => set("predicate", p)} catalog={catalog} disabled={disabled} />;
  if (node.type === "merge") return <>
    <p className="studio-inline-caption">合流する条件</p>
    <ChoiceButtons label="合流の条件" value={c.mode} choices={[{ value: "any", label: "どれかの経路が一致" }, { value: "all", label: "すべての経路が一致" }]} onChange={(v: string) => set("mode", v)} />
    {advanced("表示が異なる場合", <Select label="表示が異なる場合" value={c.displayConflict} options={[{ value: "stop", label: "通知しない" }, { value: "reset", label: "標準表示に戻す" }]} onChange={v => set("displayConflict", v)} />)}
    <p className="studio-inline-note"><Merge size={12} aria-hidden="true" />同じ投稿の経路を合流</p>
  </>;
  if (node.type === "dictionary") {
    const ref = bindings.dictionaries[c.dictionary], dictionaries = resources?.dictionaries || [];
    const dictionaryValue = (dictionary: any) => `${dictionary.id}:${dictionary.revision}`;
    const currentDictionary = ref && dictionaries.find((d: any) => d.id === ref.id);
    const pinnedOption = ref && (!currentDictionary || currentDictionary.revision !== ref.revision)
      ? [{ value: dictionaryValue(ref), label: currentDictionary ? `${currentDictionary.name} v${ref.revision}（使用中）` : `参照できない辞書 v${ref.revision}`, disabled: !currentDictionary }]
      : [];
    return <>
      {resources ? <Select label="照合する辞書" value={ref ? dictionaryValue(ref) : ""} options={[{ value: "", label: "辞書を選ぶ" }, ...pinnedOption, ...dictionaries.map((d: any) => ({ value: dictionaryValue(d), label: `${d.name} v${d.revision}` }))]} onChange={selection => {
        const dictionary = dictionaries.find((d: any) => dictionaryValue(d) === selection); if (!dictionary) return;
        const alias = resourceAlias("dict", node.id, c.dictionary, bindings.dictionaries);
        update({ ...c, dictionary: alias }, { ...bindings, dictionaries: { ...bindings.dictionaries, [alias]: { id: dictionary.id, revision: dictionary.revision } } });
      }} /> : <Select label="辞書の差し込み名" value={c.dictionary} options={[...new Set([c.dictionary, ...Object.keys(bindings.dictionaries)])]} onChange={v => set("dictionary", v)} />}
      <p className="studio-inline-caption">照合する項目</p>
      <div className="studio-inline-chip-group">{Object.entries(catalog.fields).filter(([, type]) => type === "string" || type === "array").map(([key]) => <label className="studio-inline-chip" key={key}><input type="checkbox" checked={c.fields.includes(key)} onChange={e => set("fields", e.target.checked ? [...c.fields, key] : c.fields.filter((v: string) => v !== key))} /><span>{fieldLabels[key] || key}</span></label>)}</div>
      {resources && !dictionaries.length && <p className="studio-inline-note"><AlertTriangle size={12} aria-hidden="true" />選べる辞書がありません</p>}
    </>;
  }
  if (node.type === "delay") return <>
    <NumberInput label="待ち時間（分）" value={c.minutes} onChange={(v: number) => set("minutes", v)} />
    <ChoiceButtons label="よく使う遅延" value={c.minutes} choices={[0, 5, 15, 30, 60, 1440].map(value => ({ value, label: value === 0 ? "すぐ" : value === 1440 ? "1日" : value >= 60 ? `${value / 60}時間` : `${value}分` }))} onChange={(v: number) => set("minutes", v)} />
    {advanced("待ち時間の基準", <Select label="時間の基準" value={c.anchor} options={[{ value: "observed", label: "検知時刻" }, { value: "published", label: "公開時刻" }]} onChange={v => set("anchor", v)} />)}
  </>;
  if (node.type === "schedule") {
    const windows = (key: string) => <div className="studio-schedule-windows">{c[key].map((w: any, i: number) => <div className="studio-time-range" key={i}>{["start", "end"].map((k, j) => <span className="studio-time-end" key={k}>{j > 0 && <span>〜</span>}<input aria-label={`${key === "windows" ? "通知する" : "通知しない"}時間帯 ${i + 1} の${k === "start" ? "開始" : "終了"}`} type="time" className={inputClass} value={w[k] === "24:00" ? "00:00" : w[k]} onChange={e => set(key, c[key].map((v: any, index: number) => index === i ? { ...v, [k]: e.target.value === "00:00" && k === "end" ? "24:00" : e.target.value } : v))} /></span>)}<button type="button" aria-label={`${key === "windows" ? "通知する" : "通知しない"}時間帯 ${i + 1} を削除`} title="時間帯を削除" disabled={key === "windows" && c[key].length === 1} onClick={() => set(key, c[key].filter((_: any, j: number) => j !== i))}>×</button></div>)}<button type="button" className={buttonClass} disabled={c[key].length >= 16} onClick={() => set(key, [...c[key], key === "quiet" ? { start: "22:00", end: "09:00" } : { start: "09:00", end: "18:00" }])}><Plus size={14} aria-hidden="true" />時間帯を追加</button></div>;
    return <>
      <div className="studio-inline-chip-group studio-weekdays" role="group" aria-label="通知する曜日">{["月", "火", "水", "木", "金", "土", "日"].map((label, i) => <label className="studio-inline-chip" key={label}><input aria-label={`${label}曜日`} type="checkbox" checked={c.days.includes(i + 1)} onChange={e => set("days", e.target.checked ? [...c.days, i + 1].sort() : c.days.filter((d: number) => d !== i + 1))} /><span>{label}</span></label>)}</div>
      <p className="studio-inline-caption">通知する時間帯 <span>{c.zone}</span></p>{windows("windows")}
      {advanced("休止時間・除外日・タイムゾーン", <>
        <Select label="タイムゾーン" value={c.zone} options={[...new Set([c.zone, "Asia/Tokyo", "UTC", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Seoul", "Australia/Sydney"])]} onChange={v => set("zone", v)} />
        <p className="studio-inline-caption">通知しない時間</p>{windows("quiet")}
        <label className="block text-sm">除外日を追加<input aria-label="除外日を追加" className={inputClass} type="date" onChange={e => e.target.value && set("datesExcluded", [...new Set([...c.datesExcluded, e.target.value])])} /></label><div className="flex flex-wrap gap-1">{c.datesExcluded.map((d: string) => <button type="button" key={d} className={buttonClass} onClick={() => set("datesExcluded", c.datesExcluded.filter((v: string) => v !== d))}>{d} ×</button>)}</div>
        <NumberInput label="最大待機日数" min={1} max={366} value={c.maxWaitDays} onChange={(v: number) => set("maxWaitDays", v)} />
      </>)}
    </>;
  }
  if (node.type === "transform") return <>
    <ChoiceButtons label="表示形式" value={c.format} choices={["normal", "expanded", "card", "text", "url"].map(value => ({ value, label: valueLabels[value] }))} onChange={(v: string) => set("format", v)} />
    {c.format === "normal" && <p className="studio-inline-note">通知元URLを投稿し、通常のBot機能とサーバーの設定で展開します。DMは通知文とURLのみです。DMでメディアも送る場合は「通知側で直接展開」を選んでください。</p>}
    <label className="studio-message-editor">通知文<textarea aria-label="通知文" className={inputClass} value={c.template} onChange={e => set("template", e.target.value)} rows={4} /></label>
    <div className="studio-template-fields" role="group" aria-label="通知文に項目を追加">{["title", "url", "author", "priceAmount"].map(key => <button type="button" key={key} onClick={() => set("template", `${c.template}{${key}}`)}><Plus size={12} aria-hidden="true" />{fieldLabels[key]}</button>)}</div>
    {advanced(c.format === "normal" ? "文字数・文章の加工" : "メディア・文字数・文章の加工", <>
      <Select label="差し込み項目を追加" value="" options={[{ value: "", label: "項目を選ぶ" }, ...Object.keys(catalog.fields)]} onChange={v => v && set("template", `${c.template}{${v}}`)} />
      {c.format !== "normal" && <Select label="メディア表示" value={c.media} options={[{ value: "inherit", label: "現在の設定" }, { value: "hide", label: "非表示" }, { value: "links", label: "リンク" }]} onChange={v => set("media", v)} />}
      <NumberInput label="文字数上限" min={1} max={1900} value={c.maxLength} onChange={(v: number) => set("maxLength", v)} />
      {textInput("prefix", "前に付ける文章")}{textInput("suffix", "後に付ける文章")}
      <p className="studio-inline-caption">文字置換</p>{(c.replacements || []).map((r: any, i: number) => <div key={i} className="flex gap-1">{["from", "to"].map(k => <input aria-label={k === "from" ? "置換前" : "置換後"} key={k} className={inputClass} value={r[k]} onChange={e => set("replacements", c.replacements.map((v: any, j: number) => i === j ? { ...v, [k]: e.target.value } : v))} />)}<button type="button" aria-label={`文字置換 ${i + 1} を削除`} onClick={() => set("replacements", c.replacements.filter((_: any, j: number) => i !== j))}>×</button></div>)}<button type="button" className={buttonClass} disabled={c.replacements?.length >= 32} onClick={() => set("replacements", [...c.replacements || [], { from: "対象語", to: "＊＊＊" }])}><Plus size={14} aria-hidden="true" />置換を追加</button>
    </>)}
  </>;
  if (node.type === "limit" || node.type === "aggregate") return <>
    <div className="studio-number-sentence"><NumberInput label="期間（分）" min={1} max={10080} value={c.minutes} onChange={(v: number) => set("minutes", v)} /><span>分ごとに</span>{node.type === "limit" ? <NumberInput label="件数上限" min={1} max={10000} value={c.count} onChange={(v: number) => set("count", v)} /> : <NumberInput label="まとめる最大件数" min={1} max={100} value={c.maxItems} onChange={(v: number) => set("maxItems", v)} />}<span>{node.type === "limit" ? "件まで通知" : "件までまとめる"}</span></div>
    <Select label={node.type === "limit" ? "件数を数える単位" : "まとめる単位"} value={c.key} options={["sourceKey", "author", "providerId", "currency", "all"]} onChange={v => set("key", v)} />
    {node.type === "limit" ? <ChoiceButtons label="超過した通知" value={c.overflow} choices={[{ value: "defer", label: "超えた分は後で送る" }, { value: "drop", label: "超えた分は送らない" }]} onChange={(v: string) => set("overflow", v)} /> : <ChoiceButtons label="通知する内容" value={c.mode} choices={[{ value: "all", label: "すべての投稿" }, { value: "latest", label: "最新の投稿だけ" }]} onChange={(v: string) => set("mode", v)} />}
  </>;
  if (node.type === "send") {
    if (!resources) return <Select label="送信先の差し込み名" value={c.destination} options={[...new Set(["default", c.destination, ...Object.keys(bindings.destinations)])]} onChange={v => set("destination", v)} />;
    const destinationId = c.destination === "default" ? "default" : bindings.destinations[c.destination] || "", destinations = resources.destinations || [];
    return <><Select label="通知の宛先" value={destinationId} options={[{ value: "default", label: "この通知の宛先" }, ...(!destinationId ? [{ value: "", label: "宛先を選ぶ" }] : destinationId !== "default" && !destinations.some((d: any) => d.id === destinationId) ? [{ value: destinationId, label: "参照できない宛先" }] : []), ...destinations.map((d: any) => ({ value: d.id, label: d.name }))]} onChange={id => {
      if (id === "default") return set("destination", "default");
      if (!destinations.some((d: any) => d.id === id)) return;
      const alias = resourceAlias("dest", node.id, c.destination, bindings.destinations);
      update({ ...c, destination: alias }, { ...bindings, destinations: { ...bindings.destinations, [alias]: id } });
    }} /></>;
  }
  if (node.type === "stop") return textInput("reason", "通知しない理由");
  return null;
}

export { RuleEditor } from "./rule-editor-canvas";
