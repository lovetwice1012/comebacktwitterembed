"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Connection, type NodeChange, type EdgeChange, type ReactFlowInstance } from "@xyflow/react";
import { FlowBlock, NodeSettings, Select, type Rule, type Bindings, type AutomationApi } from "./rule-editor";
import { EventSimulator } from "./event-simulator";
import * as model from "../../../src/automation/editor-model";
import { blockSummary, evaluationKey, valueLabels } from "./rule-labels";
const field = "w-full rounded border bg-background px-2 py-1.5 text-sm";
const button = "rounded border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40";
const nodeTypes = { automation: FlowBlock };
const emptyGroups: any[] = [];
const clone = <T,>(value: T): T => structuredClone(value);
type Snapshot = { rule: Rule; representation?: { text: string; format: string } };
function download(text: string, filename: string) { const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); }

export function RuleEditor({ value, bindings, onChange, catalog, api, readOnly = false, onValidityChange, initialTextDraft, onTextDraftChange }: { value: Rule; bindings: Bindings; onChange: (rule: Rule) => void; catalog: any; api: AutomationApi; readOnly?: boolean; onValidityChange?: (valid: boolean) => void; initialTextDraft?: { text: string; format: string } | null; onTextDraftChange?: (draft: { text: string; format: string } | null) => void }) {
  const [selected, setSelected] = useState("start"), [picked, setPicked] = useState<string[]>(["start"]), [mode, setMode] = useState(initialTextDraft ? "text" : "graph"), [format, setFormat] = useState(initialTextDraft?.format || "yaml");
  const [text, setText] = useState(initialTextDraft?.text || ""), [textDirty, setTextDirty] = useState(!!initialTextDraft), [issues, setIssues] = useState<any[]>([]), [error, setError] = useState(""), [valid, setValid] = useState(false), [pending, setPending] = useState(true);
  const [groupName, setGroupName] = useState("新しいグループ"), [selectedGroup, setSelectedGroup] = useState("");
  const [connectFrom, setConnectFrom] = useState("start"), [connectTo, setConnectTo] = useState("send"), [connectPort, setConnectPort] = useState("out");
  const [simulation, setSimulation] = useState<any>(null);
  const [pickedEdges, setPickedEdges] = useState<string[]>([]);
  const [openedGroups, setOpenedGroups] = useState<string[]>([]);
  const [placement, setPlacement] = useState("insert"), [insertPort, setInsertPort] = useState("out");
  const flow = useRef<Pick<ReactFlowInstance, "fitView"> | null>(null), [focusId, setFocusId] = useState("");
  const canvas = useRef<HTMLDivElement>(null), ruleFile = useRef<HTMLInputElement>(null), fragmentFile = useRef<HTMLInputElement>(null), revealCanvas = useRef(false);
  const draggingNodes = useRef(false);
  const history = useRef<Snapshot[]>([]), future = useRef<Snapshot[]>([]), sequence = useRef(0), valueRef = useRef(value), textRef = useRef({ text, dirty: !!initialTextDraft }), accepted = useRef(""), acceptedText = useRef("");
  valueRef.current = value;
  const locked = readOnly || textDirty;
  const selectedNode = value.nodes.find(n => n.id === selected), groups = value.layout?.groups || emptyGroups;
  const currentPorts: string[] = catalog.nodes[selectedNode?.type || "start"]?.ports || [];
  const chosenInsertPort = currentPorts.includes(insertPort) ? insertPort : currentPorts[0] || "out";
  const snapshot = useCallback((): Snapshot => ({ rule: clone(valueRef.current), ...(accepted.current === `${format}:${JSON.stringify(valueRef.current)}` ? { representation: { text: acceptedText.current, format } } : {}) }), [format]);
  const update = useCallback((next: Rule) => {
    if (readOnly || next === valueRef.current) return;
    history.current = [...history.current.slice(-99), snapshot()]; future.current = []; setValid(false); onChange(next);
  }, [onChange, readOnly, snapshot]);
  const attempt = (work: () => void) => { try { work(); setError(""); } catch (err: any) { setError(err.message); } };
  useEffect(() => { onValidityChange?.(valid && !pending && !textDirty); }, [valid, pending, textDirty, onValidityChange]);
  const evaluatedDefinition = evaluationKey(value, bindings);
  useEffect(() => { setSimulation(null); }, [evaluatedDefinition]);
  useEffect(() => { onTextDraftChange?.(textDirty ? { text, format } : null); }, [textDirty, text, format, onTextDraftChange]);
  useEffect(() => {
    if (!focusId) return;
    const frame = requestAnimationFrame(() => { void flow.current?.fitView({ nodes: [{ id: focusId }], minZoom: 0.2, maxZoom: 1, padding: 0.2, duration: 0 }); if (revealCanvas.current) { canvas.current?.scrollIntoView({ block: "nearest" }); revealCanvas.current = false; } setFocusId(""); });
    return () => cancelAnimationFrame(frame);
  }, [focusId, value]);
  useEffect(() => {
    if (textDirty) return;
    let active = true; setPending(true);
    const version = ++sequence.current;
    const timer = setTimeout(() => api("validate", "POST", { definition: value, format }).then(result => {
      if (!active || version !== sequence.current || textRef.current.dirty) return;
      setIssues(result.issues || []); setValid(result.valid); setPending(false); setError("");
      // Preserve comments and user formatting after a valid text edit. A real
      // graph/header edit or format conversion regenerates the representation.
      const serialized = JSON.stringify(value);
      if (accepted.current !== `${format}:${serialized}` || !textRef.current.text) {
        setText(result.text || ""); textRef.current = { text: result.text || "", dirty: false };
        acceptedText.current = result.text || "";
      }
      accepted.current = `${format}:${serialized}`;
    }).catch(err => { if (active && version === sequence.current) { setError(err.message); setIssues(err.issues || []); setValid(false); setPending(false); } }), 350);
    return () => { active = false; clearTimeout(timer); };
  }, [value, format, textDirty, api]);
  useEffect(() => {
    if (!textDirty) return;
    let active = true; setPending(true);
    const version = ++sequence.current;
    const timer = setTimeout(() => api("validate", "POST", { text, format }).then(result => {
      if (!active || version !== sequence.current) return;
      setIssues(result.issues || []); setValid(result.valid); setPending(false); setError("");
      if (result.valid) {
        update(result.definition);
        accepted.current = `${format}:${JSON.stringify(result.definition)}`;
        acceptedText.current = text;
        textRef.current = { text, dirty: false }; setTextDirty(false);
      }
    }).catch(err => { if (active && version === sequence.current) { setError(err.message); setIssues(err.issues || []); setValid(false); setPending(false); } }), 450);
    return () => { active = false; clearTimeout(timer); };
  }, [text, format, textDirty, api, update]);
  useEffect(() => {
    if (!textDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [textDirty]);
  const editText = (next: string) => { sequence.current++; textRef.current = { text: next, dirty: true }; setText(next); setTextDirty(true); setValid(false); setPending(true); };
  const discardText = () => { if (!confirm("未反映のテキストを破棄し、最後のブロック状態へ戻しますか？")) return; sequence.current++; textRef.current = { text: "", dirty: false }; setTextDirty(false); setText(""); setError(""); accepted.current = ""; };
  const updateGroup = useCallback((id: string, patch: any) => { setOpenedGroups(old => old.filter(groupId => groupId !== id)); update({ ...value, layout: { ...value.layout, groups: groups.map((g: any) => g.id === id ? { ...g, ...patch } : g) } }); }, [value, groups, update]);
  const graph = useMemo(() => {
    const collapsed = new Map(groups.filter((g: any) => g.collapsed && !openedGroups.includes(g.id)).map((g: any) => [g.id, g]));
    const proxy = (id: string) => { const node = value.nodes.find(n => n.id === id); return node?.group && collapsed.has(node.group) ? `__group:${node.group}` : id; };
    const nodes: any[] = value.nodes.filter(n => !n.group || !collapsed.has(n.group)).map((n, i) => ({ id: n.id, type: "automation", deletable: n.type !== "start", ariaLabel: `${catalog.nodes[n.type]?.label}: ${blockSummary(n)}`, position: n.position || { x: i * 240, y: 80 }, selected: picked.includes(n.id),
      data: { kind: n.type, label: catalog.nodes[n.type]?.label || n.type, ports: catalog.nodes[n.type]?.ports || [], groupName: groups.find((g: any) => g.id === n.group)?.label, summary: blockSummary(n), outcome: simulation?.trace?.findLast((row: any) => row.nodeId === n.id)?.outcome } }));
    for (const raw of collapsed.values()) {
      const group = raw as any, members = value.nodes.filter(n => n.group === group.id);
      if (!members.length) continue;
      nodes.push({ id: `__group:${group.id}`, type: "automation", connectable: false, draggable: false, deletable: false, ariaLabel: `${group.label}、${members.length}個のブロック`, position: { x: Math.min(...members.map(n => n.position?.x || 0)), y: Math.min(...members.map(n => n.position?.y || 0)) }, data: { kind: "group", label: group.label, ports: ["out"], summary: `${members.length}個のブロック`, onExpand: () => { if (locked) setOpenedGroups(old => [...new Set([...old, group.id])]); else updateGroup(group.id, { collapsed: false }); } } });
    }
    const edges = value.edges.map(e => ({ id: e.id, selected: pickedEdges.includes(e.id), source: proxy(e.source), target: proxy(e.target), sourceHandle: proxy(e.source) === e.source ? e.port : "out", label: valueLabels[e.port] || e.port, style: simulation?.trace?.some((row: any) => row.nodeId === e.source && row.outcome === e.port) ? { stroke: "hsl(var(--primary))", strokeWidth: 3 } : undefined })).filter(e => e.source !== e.target);
    return { nodes, edges };
  }, [value, groups, catalog, picked, pickedEdges, simulation, openedGroups, locked, updateGroup]);
  function connect(connection: Connection) { if (!locked && connection.source && connection.target) attempt(() => update(model.connect(value, connection.source!, connection.target!, connection.sourceHandle || "out"))); }
  function add(type: string) { if (locked) return; attempt(() => { const next = model.insertNode(value, type, selected, chosenInsertPort, placement === "loose"), id = next.nodes.at(-1)!.id; update(next); setSelected(id); setPicked([id]); setFocusId(id); }); }
  const onNodesChange = (changes: NodeChange[]) => {
    // Selection is controlled only by changes, not by observing the derived
    // React Flow store and writing it back into its own input nodes.
    const selections = changes.filter((c): c is Extract<NodeChange, { type: "select" }> => c.type === "select");
    const focused = selections.slice().reverse().find(change => change.selected && !change.id.startsWith("__group:"));
    if (focused) setSelected(focused.id);
    if (selections.length) setPicked(old => {
      const next = new Set(old);
      for (const change of selections) if (!change.id.startsWith("__group:")) { if (change.selected) next.add(change.id); else next.delete(change.id); }
      return old.length === next.size && old.every(id => next.has(id)) ? old : [...next];
    });
    if (locked) return;
    let next = value;
    for (const change of changes) if (change.type === "position" && change.position && !change.id.startsWith("__group:")) {
      const node = next.nodes.find(n => n.id === change.id);
      if (node && (node.position?.x !== change.position.x || node.position?.y !== change.position.y)) next = { ...next, nodes: next.nodes.map(n => n.id === change.id ? { ...n, position: change.position } : n) };
    }
    if (next !== value) {
      if (!draggingNodes.current) update(next);
      else { setValid(false); onChange(next); }
    }
    if (changes.some(c => c.type === "position" && c.dragging === false)) draggingNodes.current = false;
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!changes.some(c => c.type === "select")) return;
    setPickedEdges(old => {
      const next = new Set(old);
      for (const change of changes) if (change.type === "select") { if (change.selected) next.add(change.id); else next.delete(change.id); }
      return old.length === next.size && old.every(id => next.has(id)) ? old : [...next];
    });
  };
  const deleteElements = ({ nodes, edges }: { nodes: { id: string }[]; edges: { id: string }[] }) => {
    if (locked) return;
    const next = model.removeNodes(valueRef.current, nodes.map(n => n.id));
    update({ ...next, edges: next.edges.filter(e => !edges.some(removed => removed.id === e.id)) });
  };
  function undo(redo = false) {
    if (locked) return;
    const from = redo ? future : history, to = redo ? history : future, next = from.current.pop();
    if (next) {
      to.current.push(snapshot());
      accepted.current = next.representation ? `${next.representation.format}:${JSON.stringify(next.rule)}` : "";
      if (next.representation) { setFormat(next.representation.format); setText(next.representation.text); acceptedText.current = next.representation.text; textRef.current = { text: next.representation.text, dirty: false }; }
      setValid(false); onChange(next.rule);
    }
  }
  async function exportText() {
    try { const output = textRef.current.dirty || accepted.current === `${format}:${JSON.stringify(valueRef.current)}` ? textRef.current.text : (await api("validate", "POST", { definition: valueRef.current, format })).text; download(output, `rule.${format}`); } catch (err: any) { setError(err.message); }
  }
  function focusNode(id: string) { const node = value.nodes.find(n => n.id === id); if (node?.group) setOpenedGroups(old => [...new Set([...old, node.group!])]); setSelected(id); setPicked([id]); setFocusId(id); }
  function importFragment(fragment: any) {
    const next = model.importGroup(valueRef.current, fragment), group = next.layout.groups.at(-1), members = next.nodes.filter(n => n.group === group.id);
    update(next); setSelectedGroup(group.id); setSelected(members[0].id); setPicked(members.map(n => n.id)); setFocusId(members[0].id);
  }
  const nodeName = (id: string) => { const index = value.nodes.findIndex(n => n.id === id), node = value.nodes[index]; if (!node) return "接続先なし"; const summary = blockSummary(node); return `${index + 1}. ${catalog.nodes[node.type]?.label} · ${summary.length > 64 ? summary.slice(0, 64) + "…" : summary}`; };
  const formatSelect = <label className="automation-format"><span>テキスト形式</span><select aria-label="テキスト形式" value={format} disabled={textDirty} className={field} onChange={e => { accepted.current = ""; setFormat(e.target.value); }}><option>yaml</option><option>json</option></select></label>;
  const nodeSettings = selectedNode && <NodeSettings key={selectedNode.id} node={selectedNode} catalog={catalog} bindings={bindings} disabled={locked} update={(config: any) => update({ ...value, nodes: value.nodes.map(n => n.id === selected ? { ...n, config } : n) })} />;
  return <div className="automation-rule-editor space-y-3">
    <div className="automation-editor-toolbar nokey">
      <div role="group" aria-label="編集モード" className="automation-mode-switch">
        <button type="button" className={button} aria-pressed={mode === "graph"} onClick={() => { setMode("graph"); if (selectedNode) setFocusId(selected); }}>ブロック</button>
        <button type="button" className={button} aria-pressed={mode === "text"} onClick={() => setMode("text")}>テキスト</button>
      </div>
      <div role="group" aria-label="変更の取り消し" className="automation-undo">
        <button type="button" className={button} title="元に戻す" aria-label="元に戻す" disabled={locked || !history.current.length} onClick={() => undo()}><span aria-hidden="true">↶</span><span className="automation-undo-label">元に戻す</span></button>
        <button type="button" className={button} title="やり直す" aria-label="やり直す" disabled={locked || !future.current.length} onClick={() => undo(true)}><span aria-hidden="true">↷</span><span className="automation-undo-label">やり直す</span></button>
      </div>
    </div>
    <div className="automation-editor-tools nokey">
      {mode === "graph" && <details className="automation-studio-palette automation-tool-disclosure">
        <summary>ブロックを追加</summary>
        <div className="automation-placement"><Select label="置き方" value={placement} options={[{ value: "insert", label: "選択箇所につなぐ" }, { value: "loose", label: "自由に置く" }]} onChange={setPlacement} />{placement === "insert" && currentPorts.length > 1 && <Select label="追加する経路" value={chosenInsertPort} options={currentPorts} onChange={setInsertPort} />}</div>
        <div className="automation-palette-groups">{[
          { label: "判定・分岐", types: ["condition", "dictionary", "merge", "stop"] },
          { label: "時間・件数", types: ["delay", "schedule", "limit", "aggregate"] },
          { label: "表示・通知", types: ["transform", "send"] },
          { label: "その他", types: Object.keys(catalog.nodes).filter(type => !["start", "condition", "dictionary", "merge", "stop", "delay", "schedule", "limit", "aggregate", "transform", "send"].includes(type)) },
        ].filter(group => group.types.length).map(group => <div role="group" aria-label={group.label} key={group.label}><p>{group.label}</p><div>{group.types.filter(type => catalog.nodes[type]).map(type => <button key={type} disabled={locked} className={button} onClick={() => add(type)}>{catalog.nodes[type].label}</button>)}</div></div>)}</div>
      </details>}
      <details className="automation-tool-disclosure automation-advanced">
        <summary>配置・入出力</summary>
        <div className="automation-advanced-content">
          <div role="group" aria-label="表示と配置"><p>配置</p><button className={button} disabled={locked} onClick={() => update(model.autoLayout(value))}>接続順に整列</button></div>
          <div role="group" aria-label="ファイル入出力"><p>ファイル</p>{mode !== "text" && formatSelect}<div className="flex flex-wrap gap-2"><button className={button} onClick={exportText}>エクスポート</button><button className={button} disabled={locked} onClick={() => ruleFile.current?.click()}>インポート</button></div></div>
          <label className="block text-sm">通知の有効期限（分、空欄は無期限）<input aria-label="通知の有効期限" type="number" min={1} max={525600} className={field} disabled={locked} value={value.expiresAfterMinutes || ""} onChange={e => { const { expiresAfterMinutes: _old, ...rest } = value; update(e.target.value ? { ...rest, expiresAfterMinutes: Number(e.target.value) } : rest); }} /></label>
        </div>
      </details>
    </div>
    <input ref={ruleFile} aria-label="ルールをインポート" type="file" className="hidden" accept=".json,.yaml,.yml" disabled={locked} onChange={async e => { const input = e.currentTarget, file = input.files?.[0]; if (!file) return; input.value = ""; if (file.size > 1048576) { setError("ルールは1MiBまでです。"); return; } try { const next = await file.text(); setFormat(file.name.toLowerCase().endsWith(".json") ? "json" : "yaml"); setMode("text"); editText(next); } catch { setError("ルールファイルを読み込めませんでした。"); } }} />
    {pending && <p role="status" className="text-xs text-muted-foreground">ルールを確認中…</p>}
    {textDirty && <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500 p-2 text-sm"><span>未反映のテキストを保持しています。修正するまで保存・ブロック編集はできません。</span><button className={button} onClick={() => setMode("text")}>テキストを修正</button><button className={button} onClick={discardText}>テキストを破棄して戻す</button></div>}
    {error && <p role="alert" className="rounded border border-destructive p-2 text-sm text-destructive">{error}</p>}
    {issues.length > 0 && <div role="status" className="rounded border border-amber-500 p-2 text-sm">{issues.map((issue, i) => <button key={i} className="block text-left" onClick={() => { const nodeId = issue.nodeId || value.nodes[Number(issue.path?.match(/^\$\.nodes\[(\d+)\]/)?.[1])]?.id; if (nodeId) { focusNode(nodeId); setMode("graph"); } }}>{issue.path}: {issue.message}</button>)}</div>}
    {mode === "text" ? <div className="space-y-2">{formatSelect}<textarea aria-label="ルールJSONまたはYAML" readOnly={readOnly} className={field + " min-h-[550px] font-mono"} value={text} onChange={e => editText(e.target.value)} /></div> : <>
      <div className="automation-canvas-navigation nokey">
        <Select label="編集するブロック" value={selectedNode ? selected : ""} options={[{ value: "", label: "ブロックを選択" }, ...value.nodes.map(n => ({ value: n.id, label: nodeName(n.id) }))]} onChange={focusNode} />
        <div className="automation-fit-actions"><button className={button} onClick={() => { void flow.current?.fitView({ minZoom: 0.01, maxZoom: 1, padding: 0.12, duration: 0 }); }}>全体を表示</button><button className={button} disabled={!selectedNode} onClick={() => { revealCanvas.current = true; focusNode(selected); }}>選択を表示</button></div>
      </div>
      <div className="automation-studio-grid">
        <div ref={canvas} className="automation-studio-canvas"><ReactFlow onInit={instance => { flow.current = instance; }} nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onNodeClick={(_event, node) => { if (node.id.startsWith("__group:")) { setSelectedGroup(node.id.slice(8)); return; } setSelected(node.id); }} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onDelete={deleteElements} onConnect={connect} onNodeDragStart={() => { draggingNodes.current = true; history.current = [...history.current.slice(-99), snapshot()]; future.current = []; }} multiSelectionKeyCode={["Shift", "Meta", "Control"]} nodesDraggable={!locked} nodesConnectable={!locked} deleteKeyCode={locked ? null : ["Backspace", "Delete"]} defaultViewport={value.layout?.viewport} onMoveEnd={(event, viewport) => { if (event && !locked) onChange({ ...valueRef.current, layout: { ...valueRef.current.layout, viewport } }); }} minZoom={0.01} fitView={!value.layout?.viewport} fitViewOptions={{ minZoom: 0.01, maxZoom: 1, padding: 0.12 }}><Background /><Controls showFitView={false} showInteractive={false} /><MiniMap className="automation-studio-minimap" style={{ width: 112, height: 72 }} pannable zoomable /></ReactFlow></div>
        <aside className="automation-studio-inspector nokey space-y-3" aria-label="選択ブロックの設定">
          <div className="automation-inspector-heading"><span>{selectedNode ? `${value.nodes.findIndex(n => n.id === selected) + 1}. ${catalog.nodes[selectedNode.type]?.label || selectedNode.type}` : "ブロックを選択"}</span>{selectedNode && <button type="button" className={button} onClick={() => { revealCanvas.current = true; focusNode(selected); }}>図で確認</button>}</div>
          {selectedNode && <>
            {selectedNode.type === "condition" ? nodeSettings : <fieldset disabled={locked} className="space-y-3">{nodeSettings}</fieldset>}
            <details className="automation-block-actions"><summary>ブロックの操作</summary><fieldset disabled={locked} className="space-y-2">
              <Select label="所属グループ" value={selectedNode.group || ""} options={[{ value: "", label: "なし" }, ...groups.map((g: any) => ({ value: g.id, label: g.label }))]} onChange={group => update({ ...value, nodes: value.nodes.map(n => { if (n.id !== selected) return n; const { group: _old, ...rest } = n; return group ? { ...rest, group } : rest; }) })} />
              <div className="flex flex-wrap gap-2"><button className={button} disabled={selectedNode.type === "start" || value.nodes.length >= 128} onClick={() => { const id = `n${crypto.randomUUID().replaceAll("-", "")}`; update({ ...value, nodes: [...value.nodes, { ...clone(selectedNode), id, position: { x: (selectedNode.position?.x || 0) + 30, y: (selectedNode.position?.y || 0) + 80 } }] }); setSelected(id); setPicked([id]); setFocusId(id); }}>複製</button>{selectedNode.type !== "start" && <button className={button} onClick={() => update(model.removeNodes(value, [selected]))}>ブロックを削除</button>}</div>
            </fieldset></details>
          </>}
          <details className="automation-block-actions space-y-2"><summary>グループ・再利用部品</summary><p className="text-xs text-muted-foreground">Shiftで複数選択。部品は取り込み後に接続します。</p>
            <input aria-label="新しいグループ名" className={field} value={groupName} onChange={e => setGroupName(e.target.value)} />
            <div className="flex flex-wrap gap-2"><button className={button} disabled={locked} onClick={() => attempt(() => { const next = model.addGroup(value, groupName, picked.length ? picked : selected ? [selected] : []); update(next); setSelectedGroup(next.layout.groups.at(-1).id); })}>選択ブロックをグループ化</button><button className={button} disabled={locked} onClick={() => fragmentFile.current?.click()}>部品を読み込む</button></div>
            <input ref={fragmentFile} aria-label="部品を読み込む" className="hidden" type="file" accept=".json" disabled={locked} onChange={async e => { const input = e.currentTarget, file = input.files?.[0]; input.value = ""; if (!file) return; if (file.size > 1048576) { setError("部品は1MiB以内のJSONです。"); return; } try { importFragment(JSON.parse(await file.text())); setError(""); } catch (err: any) { setError(err.message); } }} />
            {groups.map((g: any) => <div key={g.id} data-group-id={g.id} className={`flex flex-wrap items-center gap-2 rounded border p-2 ${selectedGroup === g.id ? "border-primary" : ""}`}><input aria-label={`グループ ${g.id} の名前`} className={field} disabled={locked} value={g.label} onChange={e => updateGroup(g.id, { label: e.target.value })} /><span className="text-xs">{value.nodes.filter(n => n.group === g.id).length}個</span><button className={button} disabled={locked} onClick={() => updateGroup(g.id, { collapsed: !(g.collapsed && !openedGroups.includes(g.id)) })}>{g.collapsed && !openedGroups.includes(g.id) ? "展開する" : "折りたたむ"}</button><button className={button} disabled={locked} onClick={() => attempt(() => importFragment(model.exportGroup(value, g.id)))}>部品として複製</button><button className={button} onClick={() => attempt(() => download(JSON.stringify(model.exportGroup(value, g.id), null, 2), "rule-fragment.json"))}>部品を出力</button><button className={button} disabled={locked} onClick={() => update(model.removeGroup(value, g.id))}>グループ解除</button></div>)}
          </details>
        </aside>
      </div>
    </>}
    <details className="automation-block-actions"><summary>キーボード・タッチ用の接続操作</summary><fieldset disabled={locked} className="mt-2 grid gap-2 sm:grid-cols-4"><Select label="接続元" value={connectFrom} options={value.nodes.filter(n => catalog.nodes[n.type]?.ports.length).map(n => ({ value: n.id, label: nodeName(n.id) }))} onChange={id => { setConnectFrom(id); setConnectPort(catalog.nodes[value.nodes.find(n => n.id === id)?.type || "start"].ports[0] || "out"); }} /><Select label="分岐" value={connectPort} options={catalog.nodes[value.nodes.find(n => n.id === connectFrom)?.type || "start"].ports} onChange={setConnectPort} /><Select label="接続先" value={connectTo} options={value.nodes.filter(n => n.type !== "start").map(n => ({ value: n.id, label: nodeName(n.id) }))} onChange={setConnectTo} /><button className={button} onClick={() => connect({ source: connectFrom, target: connectTo, sourceHandle: connectPort, targetHandle: null })}>接続する</button></fieldset><div>{value.edges.map(e => <div key={e.id} className="automation-connection-row"><span>{nodeName(e.source)} → {nodeName(e.target)} ({valueLabels[e.port] || e.port})</span><button disabled={locked} onClick={() => update({ ...value, edges: value.edges.filter(x => x.id !== e.id) })}>接続を削除</button></div>)}</div></details>
    <EventSimulator value={value} bindings={bindings} catalog={catalog} api={api} disabled={!valid || pending || textDirty} onResult={setSimulation} />
  </div>;
}
