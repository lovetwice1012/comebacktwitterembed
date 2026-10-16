"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, MarkerType, SelectionMode, type Connection, type NodeChange, type EdgeChange, type ReactFlowInstance } from "@xyflow/react";
import { FlowBlock, NodeSettings, Select, type Rule, type Bindings, type AutomationApi } from "./rule-editor";
import { EventSimulator } from "./event-simulator";
import * as model from "../../../src/automation/editor-model";
import { copySelection, cutSelection, pasteSelection, validateSelection, type AutomationSelection } from "../../../src/automation/editor-clipboard";
import { blockSummary, evaluationKey, valueLabels } from "./rule-labels";
import { FlaskConical, CheckCircle2, Plus, MousePointer2, Hand, MoreHorizontal, Maximize2, Copy, Scissors, ClipboardPaste, Undo2, Redo2, AlertTriangle } from "lucide-react";
import { StudioSteps } from "./studio-steps";
import { StudioBlockPicker } from "./studio-block-picker";
import { CanvasContextMenu, type CanvasMenuItem } from "./canvas-context-menu";
import { useCanvasRightPan } from "./use-canvas-right-pan";
import { StudioFlowEdge } from "./studio-flow-edge";
import { StudioRoutingProvider, StudioRoutingObserver } from "./studio-routing";
import { edgeLanes } from "../../../src/automation/editor-edge-routing";
import { AutomationDialog } from "./automation-dialog";
import { automationErrorMessage, automationRetryDelay } from "./automation-feedback";
import "./studio-editor.css";
import "./studio-direct.css";
const field = "w-full rounded border bg-background px-2 py-1.5 text-sm";
const button = "rounded border bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40";
const nodeTypes = { automation: FlowBlock };
const edgeTypes = { studio: StudioFlowEdge };
const flowDisplayOptions = { hideAttribution: true };
const emptyGroups: any[] = [];
const clone = <T,>(value: T): T => structuredClone(value);
type Snapshot = { rule: Rule; bindings: Bindings; representation?: { text: string; format: string } };
type ContextTarget = { kind: "pane" | "node" | "edge" | "selection" | "group"; nodeId?: string; edgeId?: string; groupId?: string; x: number; y: number; screen: { x: number; y: number } };
function download(text: string, filename: string) { const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); }

export function RuleEditor({ value, bindings, onChange, catalog, api, readOnly = false, onValidityChange, initialTextDraft, onTextDraftChange, resources, onBindingsChange }: { value: Rule; bindings: Bindings; onChange: (rule: Rule) => void; catalog: any; api: AutomationApi; readOnly?: boolean; onValidityChange?: (valid: boolean) => void; initialTextDraft?: { text: string; format: string } | null; onTextDraftChange?: (draft: { text: string; format: string } | null) => void; resources?: { destinations: any[]; dictionaries: any[] }; onBindingsChange?: (bindings: Bindings) => void }) {
  const firstNode = value.nodes.find(n => n.type === "start")?.id || value.nodes[0]?.id || "";
  const [selected, setSelected] = useState(firstNode), [picked, setPicked] = useState<string[]>([firstNode]), [mode, setMode] = useState(initialTextDraft ? "text" : "graph"), [format, setFormat] = useState(initialTextDraft?.format || "yaml");
  const [text, setText] = useState(initialTextDraft?.text || ""), [textDirty, setTextDirty] = useState(!!initialTextDraft), [issues, setIssues] = useState<any[]>([]), [error, setError] = useState(""), [valid, setValid] = useState(false), [pending, setPending] = useState(true);
  const [validationWait, setValidationWait] = useState<number | null>(null);
  const validationRetryAt = useRef(0);
  const [paletteOpen, setPaletteOpen] = useState(false), [testOpen, setTestOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [pickerDragging, setPickerDragging] = useState(false);
  const [compact, setCompact] = useState(false);
  const [tool, setTool] = useState("select"), [context, setContext] = useState<ContextTarget | null>(null), [fileOpen, setFileOpen] = useState(false);
  const [linking, setLinking] = useState<{ source: string; port: string } | null>(null), [canvasNotice, setCanvasNotice] = useState("");
  const [clipboardReady, setClipboardReady] = useState(false);
  const viewportCompact = useRef(false);
  const [simulation, setSimulation] = useState<any>(null);
  const [pickedEdges, setPickedEdges] = useState<string[]>([]);
  const [measurements, setMeasurements] = useState<Map<string, { width: number; height: number }>>(() => new Map());
  const [openedGroups, setOpenedGroups] = useState<string[]>([]);
  const [placement, setPlacement] = useState("insert"), [insertPort, setInsertPort] = useState("out");
  const flow = useRef<Pick<ReactFlowInstance, "fitView" | "screenToFlowPosition" | "getViewport" | "setViewport"> | null>(null), [focusId, setFocusId] = useState("");
  const canvas = useRef<HTMLDivElement>(null), ruleFile = useRef<HTMLInputElement>(null), fragmentFile = useRef<HTMLInputElement>(null), revealCanvas = useRef(false);
  const draggingNodes = useRef(false);
  const testPanel = useRef<HTMLDetailsElement>(null), editorElement = useRef<HTMLDivElement>(null);
  const alive = useRef(true), mutationLocked = useRef(false);
  const fileSequence = useRef(0);
  const clipboard = useRef<AutomationSelection | null>(null), pasteCount = useRef(0), bindingsRef = useRef(bindings), clipboardSequence = useRef(0);
  const paletteAt = useRef<{ x: number; y: number } | null>(null), paletteEdge = useRef<string | null>(null), linkStart = useRef<{ source: string; port: string; x: number; y: number } | null>(null);
  const history = useRef<Snapshot[]>([]), future = useRef<Snapshot[]>([]), sequence = useRef(0), valueRef = useRef(value), textRef = useRef({ text, dirty: !!initialTextDraft }), accepted = useRef(""), acceptedText = useRef("");
  valueRef.current = value; bindingsRef.current = bindings;
  const locked = readOnly || textDirty; mutationLocked.current = locked;
  useEffect(() => { alive.current = true; return () => { alive.current = false; clipboardSequence.current++; fileSequence.current++; clipboard.current = null; }; }, []);
  const savedViewport = value.layout?.viewport;
  const savedViewportUsable = savedViewport && Number.isFinite(savedViewport.x) && Number.isFinite(savedViewport.y) && savedViewport.zoom >= 0.01 && savedViewport.zoom <= 2;
  const selectedNode = value.nodes.find(n => n.id === selected), groups = value.layout?.groups || emptyGroups;
  useEffect(() => {
    const ids = new Set([...value.nodes.map(node => node.id), ...groups.map((group: any) => `__group:${group.id}`)]);
    setMeasurements(previous => {
      if ([...previous.keys()].every(id => ids.has(id))) return previous;
      return new Map([...previous].filter(([id]) => ids.has(id)));
    });
  }, [value.nodes, groups]);
  const currentPorts: string[] = catalog.nodes[selectedNode?.type || "start"]?.ports || [];
  const chosenInsertPort = currentPorts.includes(insertPort) ? insertPort : currentPorts[0] || "out";
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 700px)");
    if (!media) return;
    const change = () => setCompact(media.matches);
    change(); media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (viewportCompact.current === compact) return;
    viewportCompact.current = compact; setTool(compact ? "pan" : "select");
    if (mode === "graph" && selected) setFocusId(selected);
  }, [compact, mode, selected]);
  useEffect(() => {
    if (!compact || mode !== "graph" || !paletteOpen) return;
    const previous = document.activeElement as HTMLElement, overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [compact, mode, paletteOpen]);
  useEffect(() => {
    if (!value.nodes.some(n => n.id === selected)) { setSelected(firstNode); setPicked(firstNode ? [firstNode] : []); }
  }, [value.nodes, selected, firstNode]);
  const snapshot = useCallback((): Snapshot => ({ rule: clone(valueRef.current), bindings: clone(bindingsRef.current), ...(accepted.current === `${format}:${JSON.stringify(valueRef.current)}` ? { representation: { text: acceptedText.current, format } } : {}) }), [format]);
  const update = useCallback((next: Rule, nextBindings?: Bindings) => {
    if (readOnly || next === valueRef.current && !nextBindings) return;
    history.current = [...history.current.slice(-99), snapshot()]; future.current = []; valueRef.current = next; setValid(false); onChange(next);
    if (nextBindings) bindingsRef.current = nextBindings;
    if (nextBindings) onBindingsChange?.(nextBindings);
  }, [onChange, onBindingsChange, readOnly, snapshot]);
  const attempt = (work: () => void) => { try { work(); setError(""); } catch (err: any) { setError(err.message); } };
  useEffect(() => { onValidityChange?.(valid && !pending && !textDirty); }, [valid, pending, textDirty, onValidityChange]);
  const evaluatedDefinition = evaluationKey(value, bindings);
  useEffect(() => { setSimulation(null); }, [evaluatedDefinition]);
  useEffect(() => { onTextDraftChange?.(textDirty ? { text, format } : null); }, [textDirty, text, format, onTextDraftChange]);
  useEffect(() => {
    if (!focusId) return;
    const following = value.edges.filter(e => e.source === focusId).map(e => e.target);
    const context = inspectorOpen || compact ? [focusId] : [...new Set([focusId, ...(following.length ? following : value.edges.filter(e => e.target === focusId).map(e => e.source))])];
    // Opening the inspector changes the canvas width. Wait for its resize
    // observer before fitting, so the chosen blocks stay inside the canvas.
    const frames: number[] = []; let active = true;
    frames.push(requestAnimationFrame(() => { frames.push(requestAnimationFrame(() => { void (async () => { await flow.current?.fitView({ nodes: context.map(id => ({ id })), minZoom: 0.85, maxZoom: 1.05, padding: 0.16, duration: 0 }); if (!active) return; if (revealCanvas.current || compact) { canvas.current?.scrollIntoView({ block: compact ? "start" : "nearest" }); revealCanvas.current = false; } setFocusId(""); })(); })); }));
    return () => { active = false; frames.forEach(cancelAnimationFrame); };
  }, [focusId, value, inspectorOpen, compact]);
  useEffect(() => {
    if (textDirty) return;
    let active = true; setPending(true); setValid(false);
    const version = ++sequence.current;
    let timer: ReturnType<typeof setTimeout>;
    const run = () => {
      if (!active || version !== sequence.current) return;
      setValidationWait(null); setError("");
      void api("validate", "POST", { definition: value, format }).then(result => {
      if (!active || version !== sequence.current || textRef.current.dirty) return;
      validationRetryAt.current = 0;
      setIssues(result.issues || []); setValid(result.valid); setPending(false); setError("");
      // Preserve comments and user formatting after a valid text edit. A real
      // graph/header edit or format conversion regenerates the representation.
      const serialized = JSON.stringify(value);
      if (accepted.current !== `${format}:${serialized}` || !textRef.current.text) {
        setText(result.text || ""); textRef.current = { text: result.text || "", dirty: false };
        acceptedText.current = result.text || "";
      }
      accepted.current = `${format}:${serialized}`;
      }).catch(err => {
        if (!active || version !== sequence.current) return;
        const delay = automationRetryDelay(err);
        setError(automationErrorMessage(err)); setIssues(err.issues || []); setValid(false); setPending(delay !== null);
        if (delay !== null) {
          validationRetryAt.current = Date.now() + delay; setValidationWait(Math.ceil(delay / 1000));
          timer = setTimeout(run, delay);
        }
      });
    };
    const wait = Math.max(0, validationRetryAt.current - Date.now());
    setValidationWait(wait ? Math.ceil(wait / 1000) : null);
    timer = setTimeout(run, Math.max(350, wait));
    return () => { active = false; clearTimeout(timer); };
  }, [value, format, textDirty, api]);
  useEffect(() => {
    if (!textDirty) return;
    let active = true; setPending(true); setValid(false);
    const version = ++sequence.current;
    let timer: ReturnType<typeof setTimeout>;
    const run = () => {
      if (!active || version !== sequence.current) return;
      setValidationWait(null); setError("");
      void api("validate", "POST", { text, format }).then(result => {
      if (!active || version !== sequence.current) return;
      validationRetryAt.current = 0;
      setIssues(result.issues || []); setValid(result.valid); setPending(false); setError("");
      if (result.valid && !readOnly) {
        update(result.definition);
        accepted.current = `${format}:${JSON.stringify(result.definition)}`;
        acceptedText.current = text;
        textRef.current = { text, dirty: false }; setTextDirty(false);
      }
      }).catch(err => {
        if (!active || version !== sequence.current) return;
        const delay = automationRetryDelay(err);
        setError(automationErrorMessage(err)); setIssues(err.issues || []); setValid(false); setPending(delay !== null);
        if (delay !== null) {
          validationRetryAt.current = Date.now() + delay; setValidationWait(Math.ceil(delay / 1000));
          timer = setTimeout(run, delay);
        }
      });
    };
    const wait = Math.max(0, validationRetryAt.current - Date.now());
    setValidationWait(wait ? Math.ceil(wait / 1000) : null);
    timer = setTimeout(run, Math.max(450, wait));
    return () => { active = false; clearTimeout(timer); };
  }, [text, format, textDirty, api, update, readOnly]);
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
    const nodes: any[] = value.nodes.filter(n => !n.group || !collapsed.has(n.group)).map((n, i) => ({ id: n.id, type: "automation", measured: measurements.get(n.id), deletable: n.type !== "start", ariaLabel: `${catalog.nodes[n.type]?.label} ${blockSummary(n)}`, position: { x: (n.position?.x ?? i * 240) * 1.45, y: (n.position?.y ?? 80) * 1.7 }, selected: picked.includes(n.id), zIndex: inspectorOpen && selected === n.id ? 100 : 0,
      data: { kind: n.type, label: catalog.nodes[n.type]?.label || n.type, ports: catalog.nodes[n.type]?.ports || [], groupName: groups.find((g: any) => g.id === n.group)?.label, summary: resourceSummary(n), node: n, catalog, bindings, resources, editing: inspectorOpen && selected === n.id, connectedPorts: value.edges.filter(e => e.source === n.id).map(e => e.port), linkingPort: linking?.source === n.id ? linking.port : undefined, onCloseEdit: () => setInspectorOpen(false), onConfig: (config: any, nextBindings?: Bindings) => configureNode(n.id, config, nextBindings), onPort: (port: string) => setLinking({ source: n.id, port }), onTarget: () => connectTarget(n.id), locked, detached: n.type !== "start" && !value.edges.some(e => e.target === n.id), onEdit: () => { setSelected(n.id); setPicked([n.id]); setInspectorOpen(true); setFocusId(n.id); }, onAdd: (port: string) => { openPalette(port, n.id); }, outcome: simulation?.trace?.findLast((row: any) => row.nodeId === n.id)?.outcome } }));
    for (const raw of collapsed.values()) {
      const group = raw as any, members = value.nodes.filter(n => n.group === group.id);
      if (!members.length) continue;
      nodes.push({ id: `__group:${group.id}`, type: "automation", measured: measurements.get(`__group:${group.id}`), selected: members.some(n => picked.includes(n.id)), connectable: false, draggable: false, deletable: false, ariaLabel: `${group.label}、${members.length}個のブロック`, position: { x: Math.min(...members.map(n => n.position?.x || 0)) * 1.45, y: Math.min(...members.map(n => n.position?.y || 0)) * 1.7 }, data: { kind: "group", label: group.label, ports: ["out"], summary: `${members.length}個のブロック`, onExpand: () => { if (locked) setOpenedGroups(old => [...new Set([...old, group.id])]); else updateGroup(group.id, { collapsed: false }); } } });
    }
    const focusConnections = pickedEdges.length > 0 || inspectorOpen || picked.length > 1 || picked.length === 1 && picked[0] !== firstNode;
    const edges = value.edges.map(e => {
      const active = !!simulation?.trace?.some((row: any) => row.nodeId === e.source && row.outcome === e.port);
      const color = active || e.port === "yes" ? "hsl(var(--studio-accent))" : e.port === "unknown" ? "#b7791f" : "hsl(var(--muted-foreground))";
      const focused = focusConnections && (pickedEdges.length ? pickedEdges.includes(e.id) : picked.includes(e.source) || picked.includes(e.target));
      return { id: e.id, type: "studio", markerEnd: { type: MarkerType.ArrowClosed, color }, selected: pickedEdges.includes(e.id), source: proxy(e.source), target: proxy(e.target), sourceHandle: proxy(e.source) === e.source ? e.port : "out", label: valueLabels[e.port] || e.port, labelStyle: { fill: color }, labelBgStyle: { fill: "hsl(var(--card))" }, style: { stroke: color }, zIndex: focused || active ? 1 : 0, data: { port: e.port, active, focused, dimmed: focusConnections && !focused } };
    }).filter(e => e.source !== e.target);
    const lanes = edgeLanes(edges);
    return { nodes, edges: edges.map(edge => ({ ...edge, data: { ...edge.data, lanes: lanes.get(edge.id) } })) };
  }, [value, groups, catalog, bindings, resources, picked, pickedEdges, simulation, openedGroups, locked, updateGroup, inspectorOpen, selected, linking, firstNode, measurements]);
  function connect(connection: Connection) { if (!locked && connection.source && connection.target) attempt(() => { update(model.connect(valueRef.current, connection.source!, connection.target!, connection.sourceHandle || "out")); setLinking(null); }); }
  function add(type: string) {
    if (locked) return;
    attempt(() => {
      const current = valueRef.current, edge = current.edges.find(e => e.id === paletteEdge.current);
      const omitted = edge ? current.edges.filter(e => e.id !== edge.id && e.source === edge.source && e.port === edge.port) : [];
      const input = omitted.length ? { ...current, edges: current.edges.filter(e => !omitted.includes(e)) } : current;
      const inserted = model.insertNode(input, type, edge?.source || selected, edge?.port || chosenInsertPort, placement === "loose");
      const node = inserted.nodes.at(-1)!, anchor = paletteAt.current && storedPoint(paletteAt.current.x, paletteAt.current.y);
      const original = current.nodes.find(n => n.id === selected), index = current.nodes.findIndex(n => n.id === selected);
      let position = anchor || { x: (original?.position?.x ?? Math.max(0, index) * 240) + (currentPorts.length ? 260 : -260), y: original?.position?.y ?? 80 };
      if (!anchor) while (current.nodes.some((n, i) => Math.abs((n.position?.x ?? i * 240) - position.x) < 210 && Math.abs((n.position?.y ?? 80) - position.y) < 150)) position = { ...position, y: position.y + 170 };
      const next = { ...inserted, edges: [...inserted.edges, ...omitted], nodes: inserted.nodes.map(n => n.id === node.id ? { ...n, position } : current.nodes.find(old => old.id === n.id) || n) };
      update(next); setSelected(node.id); setPicked([node.id]); setPickedEdges([]); setInspectorOpen(true); setFocusId(node.id); setPaletteOpen(false); setPickerDragging(false); setLinking(null);
    });
  }
  function openPalette(port = chosenInsertPort, id = selected, position?: { x: number; y: number }, edgeId?: string) {
    setSelected(id); setPicked(id ? [id] : []); setInsertPort(port); setPlacement(id ? "insert" : "loose"); setPaletteOpen(true); setInspectorOpen(false); setContext(null);
    paletteAt.current = position || null; paletteEdge.current = edgeId || null;
    if (compact) requestAnimationFrame(() => canvas.current?.scrollIntoView({ block: "center" }));
  }
  function dropBlock(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault(); setPickerDragging(false);
    const type = event.dataTransfer.getData("application/cbte-automation-block");
    placeBlock(type, event.clientX, event.clientY);
  }
  function placeBlock(type: string, x: number, y: number) {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
    if (locked || !catalog.nodes[type] || type === "start" || !flow.current) return;
    const point = flow.current.screenToFlowPosition({ x, y });
    attempt(() => { const next = model.insertNode(valueRef.current, type, selected, "out", true), id = next.nodes.at(-1)!.id; update({ ...next, nodes: next.nodes.map(n => n.id === id ? { ...n, position: { x: point.x / 1.45, y: point.y / 1.7 } } : n) }); setSelected(id); setPicked([id]); setInspectorOpen(true); setFocusId(id); setPaletteOpen(false); setError(""); });
  }
  const onNodesChange = (changes: NodeChange[]) => {
    const dimensions = changes.filter((change): change is Extract<NodeChange, { type: "dimensions" }> => change.type === "dimensions" && !!change.dimensions && Number.isFinite(change.dimensions.width) && change.dimensions.width > 0 && Number.isFinite(change.dimensions.height) && change.dimensions.height > 0);
    if (dimensions.length) setMeasurements(previous => {
      let next = previous;
      for (const change of dimensions) {
        const size = change.dimensions!, current = next.get(change.id);
        if (current?.width === size.width && current?.height === size.height) continue;
        if (next === previous) next = new Map(previous);
        next.set(change.id, { width: size.width, height: size.height });
      }
      return next;
    });
    // Selection is controlled only by changes, not by observing the derived
    // React Flow store and writing it back into its own input nodes.
    const selections = changes.filter((c): c is Extract<NodeChange, { type: "select" }> => c.type === "select");
    const focused = selections.slice().reverse().find(change => change.selected && !change.id.startsWith("__group:"));
    if (focused) setSelected(focused.id);
    if (selections.length) setPicked(old => {
      const next = new Set(old);
      for (const change of selections) {
        const ids = change.id.startsWith("__group:") ? value.nodes.filter(n => n.group === change.id.slice(8)).map(n => n.id) : [change.id];
        for (const id of ids) { if (change.selected) next.add(id); else next.delete(id); }
      }
      return old.length === next.size && old.every(id => next.has(id)) ? old : [...next];
    });
    if (locked) return;
    let next = valueRef.current;
    for (const change of changes) if (change.type === "position" && change.position && !change.id.startsWith("__group:")) {
      const node = next.nodes.find(n => n.id === change.id);
      const position = { x: change.position.x / 1.45, y: change.position.y / 1.7 };
      if (node && (node.position?.x !== position.x || node.position?.y !== position.y)) next = { ...next, nodes: next.nodes.map(n => n.id === change.id ? { ...n, position } : n) };
    }
    if (next !== valueRef.current) {
      if (!draggingNodes.current) update(next);
      else { valueRef.current = next; setValid(false); onChange(next); }
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
      setValid(false); onChange(next.rule); onBindingsChange?.(next.bindings); setInspectorOpen(false); setContext(null);
    }
  }
  async function exportText() {
    try { const output = textRef.current.dirty || accepted.current === `${format}:${JSON.stringify(valueRef.current)}` ? textRef.current.text : (await api("validate", "POST", { definition: valueRef.current, format })).text; download(output, `rule.${format}`); } catch (err: any) { setError(err.message); }
  }
  function focusNode(id: string) { const node = value.nodes.find(n => n.id === id); if (node?.group) setOpenedGroups(old => [...new Set([...old, node.group!])]); setSelected(id); setPicked([id]); setInspectorOpen(true); setFocusId(id); }
  function importFragment(fragment: any) {
    const next = model.importGroup(valueRef.current, fragment), group = next.layout.groups.at(-1), members = next.nodes.filter(n => n.group === group.id);
    update(next); setSelected(members[0].id); setPicked(members.map(n => n.id)); setFocusId(members[0].id);
  }
  function resourceSummary(node: Rule["nodes"][number]) {
    if (node.type === "send") { const id = bindings.destinations[node.config.destination]; return node.config.destination === "default" ? "この通知の宛先へ届ける" : resources?.destinations.find(item => item.id === id)?.name || "通知先を選ぶ"; }
    if (node.type === "dictionary" && resources) return `${node.config.fields.map((f: string) => valueLabels[f] || f).join("・")}を「${resources.dictionaries.find(item => item.id === bindings.dictionaries[node.config.dictionary]?.id)?.name || "辞書を選択"}」で確認`;
    return blockSummary(node);
  }
  function configureNode(id: string, config: any, nextBindings?: Bindings) {
    if (locked) return;
    const node = valueRef.current.nodes.find(item => item.id === id), field = node?.type === "dictionary" ? "dictionary" : node?.type === "send" ? "destination" : null;
    if (field && nextBindings && config[field] !== "default") {
      const category = field === "dictionary" ? "dictionaries" : "destinations", alias = config[field];
      const shared = valueRef.current.nodes.some(other => other.id !== id && other.type === node?.type && other.config[field] === alias);
      const before = bindingsRef.current[category][alias], after = nextBindings[category][alias];
      if (shared && JSON.stringify(before) !== JSON.stringify(after)) {
        const base = `${field === "dictionary" ? "dict" : "dest"}_${id}`.slice(0, 52), used = new Set([...Object.keys(nextBindings[category]), ...valueRef.current.nodes.filter(other => other.type === node?.type).map(other => other.config[field])]);
        let name = `${base}_copy`, index = 2; while (used.has(name)) name = `${base}_copy${index++}`;
        const refs: Record<string, any> = { ...nextBindings[category], [name]: after };
        if (before === undefined) delete refs[alias]; else refs[alias] = before;
        nextBindings = { ...nextBindings, [category]: refs }; config = { ...config, [field]: name };
      }
    }
    const nodes = valueRef.current.nodes.map(node => node.id === id ? { ...node, config } : node);
    if (field === "destination" && node?.config.destination !== config.destination && node?.config.destination !== "default"
      && !nodes.some(other => other.type === "send" && other.config.destination === node?.config.destination)) {
      const current = nextBindings || bindingsRef.current, destinations = { ...current.destinations };
      delete destinations[node!.config.destination]; nextBindings = { ...current, destinations };
    }
    update({ ...valueRef.current, nodes }, nextBindings);
  }
  function storedPoint(x: number, y: number) {
    const point = flow.current?.screenToFlowPosition({ x, y });
    return point ? { x: point.x / 1.45, y: point.y / 1.7 } : undefined;
  }
  function connectTarget(id: string) {
    if (!linking || locked) return;
    connect({ source: linking.source, sourceHandle: linking.port, target: id, targetHandle: null });
  }
  function focusCanvas() { requestAnimationFrame(() => { if (alive.current) editorElement.current?.focus({ preventScroll: true }); }); }
  function selectAll() { setPicked(valueRef.current.nodes.map(n => n.id)); setPickedEdges(valueRef.current.edges.map(e => e.id)); setInspectorOpen(false); setCanvasNotice(`${valueRef.current.nodes.length}個のブロックを選択`); focusCanvas(); }
  function rememberCopy(ids = picked) {
    const data = copySelection(valueRef.current, ids, bindingsRef.current);
    clipboard.current = data; pasteCount.current = 0; setClipboardReady(true); return data;
  }
  async function copyPicked(cut = false) {
    try {
      const data = rememberCopy();
      if (cut && !locked) { update(cutSelection(valueRef.current, picked)); setPicked([]); setPickedEdges([]); setInspectorOpen(false); focusCanvas(); }
      setCanvasNotice(`${data.nodes.length}個のブロックを${cut ? "カット" : "コピー"}しました`);
      await navigator.clipboard?.writeText(JSON.stringify(data));
    } catch (err: any) { if (!clipboard.current) setError(err.message || "コピーできませんでした。"); }
  }
  function pastePayload(payload: unknown, at?: { x: number; y: number }) {
    if (locked) return;
    attempt(() => {
      const data = validateSelection(payload), count = ++pasteCount.current;
      const bounds = canvas.current?.getBoundingClientRect(), anchor = at ? storedPoint(at.x, at.y) : bounds ? storedPoint(bounds.x + bounds.width / 2 - 110, bounds.y + bounds.height / 2 - 60) : undefined;
      const position = anchor && { x: anchor.x + (at ? 0 : (count - 1) * 28), y: anchor.y + (at ? 0 : (count - 1) * 28) };
      const result = pasteSelection(valueRef.current, data, position, bindingsRef.current);
      update(result.rule, result.bindings); setPicked(result.nodeIds); setPickedEdges(result.edgeIds); setSelected(result.nodeIds[0]); setInspectorOpen(false); setPaletteOpen(false);
      setOpenedGroups(old => [...new Set([...old, ...result.rule.nodes.filter(n => result.nodeIds.includes(n.id) && n.group).map(n => n.group!)])]);
      setCanvasNotice(`${result.nodeIds.length}個のブロックを貼り付けました`);
      focusCanvas();
    });
  }
  async function pasteClipboard(at?: { x: number; y: number }) {
    if (locked) return;
    const generation = ++clipboardSequence.current;
    let data: unknown = clipboard.current;
    let raw: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (navigator.clipboard?.readText) raw = await Promise.race([navigator.clipboard.readText(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 200); })]);
    }
    catch { /* The editor's copy remains usable when browser clipboard access is unavailable. */ }
    finally { if (timer) clearTimeout(timer); }
    if (generation !== clipboardSequence.current || !alive.current || mutationLocked.current || textRef.current.dirty) return;
    if (raw !== undefined) {
      try { data = JSON.parse(raw); }
      catch { setError("このキャンバスには、コピーしたブロックのみ貼り付けできます。"); return; }
    }
    if (!data) { setCanvasNotice("貼り付けるブロックをコピーしてください"); return; }
    pastePayload(data, at);
  }
  function duplicatePicked() {
    if (locked) return;
    attempt(() => { const data = copySelection(valueRef.current, picked, bindingsRef.current), x = Math.min(...data.nodes.map(n => n.position?.x || 0)), y = Math.min(...data.nodes.map(n => n.position?.y || 0)); const result = pasteSelection(valueRef.current, data, { x: x + 48, y: y + 48 }, bindingsRef.current); update(result.rule, result.bindings); setPicked(result.nodeIds); setPickedEdges(result.edgeIds); setSelected(result.nodeIds[0]); setInspectorOpen(false); });
  }
  function removePicked() {
    if (locked) return;
    const current = valueRef.current, next = cutSelection(current, picked);
    update({ ...next, edges: next.edges.filter(e => !pickedEdges.includes(e.id)) }); setPicked([]); setPickedEdges([]); setInspectorOpen(false); setLinking(null); focusCanvas();
  }
  const closeContext = useCallback(() => setContext(null), []);
  function openContext(event: { preventDefault: () => void; clientX: number; clientY: number }, kind: ContextTarget["kind"], nodeId?: string, edgeId?: string) {
    event.preventDefault();
    const bounds = canvas.current?.getBoundingClientRect(); if (!bounds) return;
    let groupId: string | undefined;
    if (nodeId?.startsWith("__group:")) { groupId = nodeId.slice(8); const ids = valueRef.current.nodes.filter(n => n.group === groupId).map(n => n.id); if (!ids.every(id => picked.includes(id))) setPicked(ids); kind = "group"; }
    else if (nodeId) { if (!picked.includes(nodeId)) setPicked([nodeId]); setSelected(nodeId); setPickedEdges([]); }
    if (edgeId) { setPickedEdges([edgeId]); setPicked([]); }
    setContext({ kind, nodeId, edgeId, groupId, x: event.clientX - bounds.left, y: event.clientY - bounds.top, screen: { x: event.clientX, y: event.clientY } });
  }
  function editableTarget(target: EventTarget | null) { return target instanceof Element && !!target.closest("input,textarea,select,[contenteditable='true']"); }
  function persistViewport(event: MouseEvent | TouchEvent | null, viewport: { x: number; y: number; zoom: number }) {
    if (event && !mutationLocked.current) onChange({ ...valueRef.current, layout: { ...valueRef.current.layout, viewport: { ...viewport, x: viewport.x / 1.45, y: viewport.y / 1.7 } } });
  }
  const rightPan = useCanvasRightPan({
    enabled: mode === "graph",
    getFlow: () => flow.current,
    onStart: closeContext,
    onEnd: persistViewport,
    onClick: (event, target) => {
      const nodeId = target.closest(".react-flow__node")?.getAttribute("data-id");
      const edgeId = target.closest(".react-flow__edge")?.getAttribute("data-id");
      openContext(event, nodeId ? "node" : edgeId ? "edge" : target.closest(".react-flow__nodesselection") ? "selection" : "pane", nodeId || undefined, edgeId || undefined);
    },
  });
  function handleClipboard(event: React.ClipboardEvent<HTMLDivElement>, kind: "copy" | "cut" | "paste") {
    if (editableTarget(event.target) || mode !== "graph" || testOpen) return;
    if (kind !== "copy" && locked || textDirty) return;
    event.preventDefault();
    attempt(() => {
      if (kind === "paste") { clipboardSequence.current++; const raw = event.clipboardData.getData("application/x-cbte-automation-selection") || event.clipboardData.getData("text/plain"); if (raw) { let payload; try { payload = JSON.parse(raw); } catch { throw new Error("このキャンバスには、コピーしたブロックのみ貼り付けできます。"); } pastePayload(payload); } else setCanvasNotice("ブロックがコピーされていません。先にブロックをコピーしてください。"); return; }
      const data = rememberCopy(); event.clipboardData.setData("application/x-cbte-automation-selection", JSON.stringify(data)); event.clipboardData.setData("text/plain", JSON.stringify(data));
      if (kind === "cut") { update(cutSelection(valueRef.current, picked)); setPicked([]); setPickedEdges([]); setInspectorOpen(false); focusCanvas(); }
      setCanvasNotice(`${data.nodes.length}個のブロックを${kind === "cut" ? "カット" : "コピー"}しました`);
    });
  }
  function handleKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (editableTarget(event.target) || mode !== "graph" || testOpen) return;
    const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (event.key === "Escape") { setContext(null); setLinking(null); setPaletteOpen(false); setPickerDragging(false); setInspectorOpen(false); return; }
    if (command && key === "a") { event.preventDefault(); selectAll(); }
    else if (command && key === "z") { event.preventDefault(); undo(event.shiftKey); }
    else if (command && key === "y") { event.preventDefault(); undo(true); }
    else if (command && key === "d") { event.preventDefault(); duplicatePicked(); }
    else if (["Delete", "Backspace"].includes(event.key) && !locked) { event.preventDefault(); event.stopPropagation(); removePicked(); }
    else if (event.shiftKey && event.key === "F10") { event.preventDefault(); const bounds = canvas.current?.getBoundingClientRect(); if (bounds) openContext({ preventDefault() {}, clientX: bounds.x + 120, clientY: bounds.y + 80 }, picked.length ? "selection" : "pane"); }
  }
  const removable = picked.some(id => value.nodes.find(n => n.id === id)?.type !== "start"), menuItems: CanvasMenuItem[] = [];
  if (context) {
    if (context.kind === "edge") {
      const edge = value.edges.find(e => e.id === context.edgeId);
      if (edge) menuItems.push({ label: "接続の途中に追加", disabled: locked, run: () => openPalette(edge.port, edge.source, context.screen, edge.id) }, { label: "接続を削除", danger: true, disabled: locked, run: () => { update({ ...value, edges: value.edges.filter(e => e.id !== edge.id) }); setPickedEdges([]); } });
    } else {
      if (context.kind === "node" && context.nodeId) menuItems.push({ label: "ブロックを編集", run: () => focusNode(context.nodeId!) });
      menuItems.push({ label: "ここにブロックを追加", disabled: locked, run: () => openPalette("out", "", context.screen) }, { label: "貼り付け", shortcut: "Ctrl+V", disabled: locked || !clipboardReady && !navigator.clipboard?.readText, run: () => { void pasteClipboard(context.screen); } });
      if (picked.length) menuItems.push({ label: "コピー", shortcut: "Ctrl+C", disabled: !removable || textDirty, divider: true, run: () => { void copyPicked(); } }, { label: "カット", shortcut: "Ctrl+X", disabled: locked || !removable, run: () => { void copyPicked(true); } }, { label: "複製", shortcut: "Ctrl+D", disabled: locked || !removable, run: duplicatePicked }, { label: "選択を削除", shortcut: "Delete", danger: true, disabled: locked || !removable, run: removePicked });
      if (picked.filter(id => value.nodes.find(n => n.id === id)?.type !== "start").length >= 2) menuItems.push({ label: "選択をグループ化", disabled: locked, divider: true, run: () => attempt(() => { const ids = picked.filter(id => value.nodes.find(n => n.id === id)?.type !== "start"), next = model.addGroup(value, `グループ ${groups.length + 1}`, ids); update(next);  }) });
      const groupId = context.groupId || value.nodes.find(n => n.id === context.nodeId)?.group;
      if (groupId) menuItems.push({ label: groups.find((g: any) => g.id === groupId)?.collapsed && !openedGroups.includes(groupId) ? "グループを展開" : "グループを折りたたむ", disabled: locked, run: () => updateGroup(groupId, { collapsed: !(groups.find((g: any) => g.id === groupId)?.collapsed && !openedGroups.includes(groupId)) }) }, { label: "グループを解除", disabled: locked, run: () => update(model.removeGroup(value, groupId)) }, { label: "グループ名を変更", disabled: locked, run: () => { const label = prompt("グループ名", groups.find((g: any) => g.id === groupId)?.label || ""); if (label?.trim()) updateGroup(groupId, { label: label.trim().slice(0, 120) }); } }, { label: "グループを書き出す", run: () => attempt(() => download(JSON.stringify(model.exportGroup(value, groupId), null, 2), "rule-fragment.json")) });
      menuItems.push({ label: "すべて選択", shortcut: "Ctrl+A", divider: true, run: selectAll }, { label: "接続順に整列", disabled: locked, run: () => update(model.autoLayout(value)) }, { label: "全体を表示", run: () => { void flow.current?.fitView({ padding: 0.12, minZoom: 0.01, maxZoom: 0.95 }); } });
    }
  }
  const nodeName = (id: string) => { const node = value.nodes.find(n => n.id === id); return node ? `${catalog.nodes[node.type]?.label} ${resourceSummary(node)}` : "接続先なし"; };
  const formatSelect = <label className="automation-format"><span>テキスト形式</span><select aria-label="テキスト形式" value={format} disabled={textDirty} className={field} onChange={e => { accepted.current = ""; setFormat(e.target.value); }}><option>yaml</option><option>json</option></select></label>;
  const nodeSettings = selectedNode && <NodeSettings key={selectedNode.id} node={selectedNode} catalog={catalog} bindings={bindings} resources={resources} disabled={locked} update={(config: any, nextBindings?: Bindings) => configureNode(selectedNode.id, config, nextBindings)} />;
  return <div ref={editorElement} tabIndex={0} className={`automation-rule-editor studio-editor studio-direct studio-mode-${mode}`} onKeyDown={handleKey} onCopy={e => handleClipboard(e, "copy")} onCut={e => handleClipboard(e, "cut")} onPaste={e => handleClipboard(e, "paste")}>
    <div className="studio-direct-toolbar nokey">
      <div role="group" aria-label="編集モード" className="automation-mode-switch">
        <button type="button" className={button} aria-pressed={mode === "graph" && !testOpen} onClick={() => { setMode("graph"); setTestOpen(false); }}>ブロック</button>
        <button type="button" className={button} aria-pressed={mode === "steps" && !testOpen} onClick={() => { setMode("steps"); setTestOpen(false); }}>手順</button>
        <button type="button" className={button} aria-pressed={mode === "text" && !testOpen} onClick={() => { setMode("text"); setTestOpen(false); }}>テキスト</button>
      </div>
      <div className="studio-direct-status" role="status" data-valid={valid && !pending && !textDirty}><CheckCircle2 size={14} aria-hidden="true" />{pending ? validationWait !== null ? `約${validationWait}秒後に自動で再確認` : "確認中…" : textDirty ? "テキストの修正が必要" : valid ? "保存できます" : "設定の確認が必要"}</div>
      <div className="studio-direct-actions">
        <button type="button" className={`${button} studio-test-trigger`} aria-pressed={testOpen} onClick={() => { setTestOpen(!testOpen); setPaletteOpen(false); setContext(null); }}><FlaskConical size={16} aria-hidden="true" />テスト</button>
        <button type="button" className={button} aria-label="元に戻す" title="元に戻す（Ctrl+Z）" disabled={locked || !history.current.length} onClick={() => undo()}><Undo2 size={16} aria-hidden="true" /></button>
        <button type="button" className={button} aria-label="やり直す" title="やり直す（Ctrl+Shift+Z）" disabled={locked || !future.current.length} onClick={() => undo(true)}><Redo2 size={16} aria-hidden="true" /></button>
        <button type="button" className={button} aria-label="ファイル・有効期限" title="ファイル・有効期限" onClick={() => setFileOpen(true)}><MoreHorizontal size={17} aria-hidden="true" /></button>
      </div>
    </div>
    <input ref={ruleFile} aria-label="ルールをインポート" type="file" className="hidden" accept=".json,.yaml,.yml" disabled={locked} onChange={async e => { const input = e.currentTarget, file = input.files?.[0]; if (!file) return; input.value = ""; if (file.size > 1048576) { setError("ルールファイルは1 MiB以下にしてください。"); return; } const request = ++fileSequence.current, before = valueRef.current; const current = () => alive.current && request === fileSequence.current && !mutationLocked.current && valueRef.current === before; try { const next = await file.text(); if (!current()) return; setFormat(file.name.toLowerCase().endsWith(".json") ? "json" : "yaml"); setMode("text"); setTestOpen(false); setFileOpen(false); editText(next); } catch { if (current()) setError("ルールファイルを読み込めませんでした。"); } }} />
    <input ref={fragmentFile} aria-label="部品を読み込む" type="file" className="hidden" accept=".json" disabled={locked} onChange={async e => { const input = e.currentTarget, file = input.files?.[0]; input.value = ""; if (!file) return; if (file.size > 1048576) { setError("部品ファイルは1 MiB以下のJSONにしてください。"); return; } const request = ++fileSequence.current, before = valueRef.current; const current = () => alive.current && request === fileSequence.current && !mutationLocked.current && valueRef.current === before; try { const text = await file.text(); if (!current()) return; importFragment(JSON.parse(text)); setFileOpen(false); setMode("graph"); setError(""); } catch { if (current()) setError("部品の形式を確認してください。"); } }} />
    {textDirty && <div className="studio-source-recovery"><span className="studio-critical-note"><AlertTriangle size={14} aria-hidden="true" />テキストを修正するまで、ブロックの編集・保存はできません</span><button className={button} onClick={() => { setMode("text"); setTestOpen(false); }}>テキストを修正</button><button className={button} onClick={discardText}>テキストの編集を破棄</button></div>}
    {issues.length > 0 && <div role="status" className="studio-rule-issues">{issues.map((issue, i) => <button type="button" key={i} onClick={() => { const nodeId = issue.nodeId || value.nodes[Number(issue.path?.match(/^\$\.nodes\[(\d+)\]/)?.[1])]?.id; if (nodeId) { focusNode(nodeId); setMode("graph"); setTestOpen(false); } }}>{issue.message}</button>)}</div>}
    {error && mode !== "graph" && <p role="alert" className="studio-source-recovery">{error}</p>}
    <EventSimulator value={value} bindings={bindings} catalog={catalog} api={api} disabled={!valid || pending || textDirty} onResult={setSimulation} open={testOpen} onOpenChange={setTestOpen} panelRef={testPanel} />
    <div hidden={testOpen}>
      {mode === "text" ? <div className="studio-text-editor">{formatSelect}<textarea aria-label="ルールJSONまたはYAML" readOnly={readOnly} className={field + " min-h-[550px] font-mono"} value={text} onChange={e => editText(e.target.value)} /></div> : mode === "steps" ? <div className="automation-studio-grid studio-steps-grid"><StudioSteps value={value} catalog={catalog} selected={selected} simulation={simulation} onSelect={focusNode} /><aside className="studio-detail space-y-3" aria-label="選択ブロックの設定"><h2>{selectedNode && catalog.nodes[selectedNode.type]?.label}</h2>{nodeSettings}<button type="button" className={button} onClick={() => { setMode("graph"); setFocusId(selected); }}>ブロックで編集</button></aside></div> : <>
        <div className="studio-a11y-jump sr-only focus-within:not-sr-only"><Select label="編集するブロック" value={selectedNode ? selected : ""} options={[{ value: "", label: "ブロックを選択" }, ...value.nodes.map(n => ({ value: n.id, label: nodeName(n.id) }))]} onChange={focusNode} /></div>
        <div ref={canvas} className="automation-studio-canvas studio-canvas-surface" data-right-panning={rightPan.panning || undefined} onMouseDownCapture={rightPan.onMouseDownCapture} onContextMenuCapture={rightPan.onContextMenuCapture} onDragOver={event => { if (!locked) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={dropBlock}>
          <div className="studio-canvas-dock nodrag nopan nokey" aria-label="キャンバスの道具">
            <button type="button" aria-label="ブロックを追加" title="ブロックを追加" disabled={locked} onClick={() => openPalette("out", "")}><Plus size={19} aria-hidden="true" /></button>
            <span className="studio-dock-divider" />
            <button type="button" aria-label="範囲選択" title="範囲選択（左ドラッグ）" aria-pressed={tool === "select"} onClick={() => setTool("select")}><MousePointer2 size={17} aria-hidden="true" /></button>
            <button type="button" aria-label="キャンバスを移動" title="移動（右ドラッグ・Spaceキー）" aria-pressed={tool === "pan"} onClick={() => setTool("pan")}><Hand size={17} aria-hidden="true" /></button>
            <button type="button" aria-label="全体を表示" title="全体を表示" onClick={() => { void flow.current?.fitView({ minZoom: 0.01, maxZoom: 0.95, padding: 0.12 }); }}><Maximize2 size={16} aria-hidden="true" /></button>
          </div>
          {picked.length > 1 && <div className="studio-selection-bar nodrag nopan nokey" role="group" aria-label="選択ブロックの操作"><span>{picked.length}個を選択</span><button type="button" aria-label="選択をコピー" title="コピー（Ctrl+C）" disabled={!removable || textDirty} onClick={() => { void copyPicked(); }}><Copy size={16} aria-hidden="true" /></button><button type="button" aria-label="選択をカット" title="カット（Ctrl+X）" disabled={locked || !removable} onClick={() => { void copyPicked(true); }}><Scissors size={16} aria-hidden="true" /></button><button type="button" aria-label="貼り付け" title="貼り付け（Ctrl+V）" disabled={locked || !clipboardReady && !navigator.clipboard?.readText} onClick={() => { void pasteClipboard(); }}><ClipboardPaste size={16} aria-hidden="true" /></button></div>}
          {paletteOpen && <section className={`studio-canvas-library nokey ${pickerDragging ? "studio-picker-dragging" : ""}`} aria-label="追加するブロックを選ぶ" role={compact ? "dialog" : undefined} aria-modal={compact ? true : undefined} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setPaletteOpen(false); setPickerDragging(false); } }}><header><button type="button" aria-label="ブロック一覧を閉じる" onClick={() => { setPaletteOpen(false); setPickerDragging(false); }}>×</button></header><StudioBlockPicker catalog={catalog} disabled={locked} unavailableTypes={Object.keys(catalog.nodes).filter(type => placement !== "loose" && !catalog.nodes[type].ports.length && (!currentPorts.length || value.edges.some(e => e.source === selected && e.port === chosenInsertPort)))} contextText={placement === "loose" ? "" : selectedNode ? currentPorts.length ? `「${catalog.nodes[selectedNode.type]?.label}」 ${valueLabels[chosenInsertPort] || chosenInsertPort}` : `「${catalog.nodes[selectedNode.type]?.label}」の前に追加` : ""} onPick={add} onPlace={placeBlock} onDragStart={() => setPickerDragging(true)} onDragEnd={() => setPickerDragging(false)} /></section>}
          {(error || canvasNotice || linking) && <div className={`studio-canvas-message ${error ? "studio-canvas-message-error" : ""}`} role={error ? "alert" : "status"}>{error || (linking ? `「${catalog.nodes[value.nodes.find(n => n.id === linking.source)?.type || ""]?.label}」の「${valueLabels[linking.port]}」から、つなぐブロックをクリック` : canvasNotice)}<button type="button" aria-label="操作メッセージを閉じる" onClick={() => { setError(""); setCanvasNotice(""); setLinking(null); }}>×</button></div>}
          <StudioRoutingProvider><ReactFlow proOptions={flowDisplayOptions} onInit={instance => { flow.current = instance; if (!savedViewportUsable && graph.nodes.length > 4) requestAnimationFrame(() => { void instance.fitView({ nodes: graph.nodes.slice(0, 3), minZoom: 0.7, maxZoom: 0.95, padding: 0.15 }); }); }} nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodeClick={(event, node) => { if (node.id.startsWith("__group:")) { return; } if (linking && linking.source !== node.id && !locked) { connectTarget(node.id); return; } setSelected(node.id); if (!event.shiftKey && !event.ctrlKey && !event.metaKey) { setPicked([node.id]); setPickedEdges([]); if (selected !== node.id) setInspectorOpen(false); } }}
            onNodeDoubleClick={(_event, node) => { if (!node.id.startsWith("__group:")) focusNode(node.id); }}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onDelete={deleteElements} onConnect={connect}
            connectOnClick={false}
            onConnectStart={(event, params) => { if (locked || params.handleType !== "source" || !params.nodeId) { linkStart.current = null; return; } const point = "touches" in event ? event.touches[0] : event; linkStart.current = { source: params.nodeId, port: params.handleId || "out", x: point.clientX, y: point.clientY }; setLinking({ source: params.nodeId, port: params.handleId || "out" }); }}
            onConnectEnd={(event, state) => { const start = linkStart.current; linkStart.current = null; if (!start || locked) return; if (state.isValid) { setLinking(null); return; } const point = "changedTouches" in event ? event.changedTouches[0] : event; if (Math.hypot(point.clientX - start.x, point.clientY - start.y) <= 12) return; if (state.toNode) { connect({ source: start.source, sourceHandle: start.port, target: state.toNode.id, targetHandle: state.toHandle?.id || null }); return; } if (Math.hypot(point.clientX - start.x, point.clientY - start.y) > 12) { openPalette(start.port, start.source, { x: point.clientX, y: point.clientY }); setLinking(null); } }}
            onReconnect={(edge, connection) => { if (locked) return; attempt(() => { const current = valueRef.current; if (current.edges.some(e => e.id !== edge.id && e.source === connection.source && e.target === connection.target && e.port === (connection.sourceHandle || "out"))) throw new Error("この接続はすでにあります。"); const next = model.connect({ ...current, edges: current.edges.filter(e => e.id !== edge.id) }, connection.source, connection.target, connection.sourceHandle || "out", edge.id); update(next); }); }}
            isValidConnection={connection => { if (locked || !connection.source || !connection.target) return false; try { model.connect(valueRef.current, connection.source, connection.target, connection.sourceHandle || "out"); return true; } catch { return false; } }}
            onNodeContextMenu={(event, node) => openContext(event, "node", node.id)} onEdgeContextMenu={(event, edge) => openContext(event, "edge", undefined, edge.id)} onPaneContextMenu={event => openContext(event, "pane")} onSelectionContextMenu={event => openContext(event, "selection")}
            onPaneClick={() => { setContext(null); setInspectorOpen(false); setLinking(null); }} onSelectionStart={() => { setInspectorOpen(false); setContext(null); }}
            onNodeDragStart={() => { if (!locked) { draggingNodes.current = true; history.current = [...history.current.slice(-99), snapshot()]; future.current = []; } }}
            multiSelectionKeyCode={["Shift", "Meta", "Control"]} selectionOnDrag={tool === "select"} selectionKeyCode={tool === "select" ? null : "Shift"} selectionMode={SelectionMode.Partial} panOnDrag={tool === "pan" ? [0, 1] : [1]} panActivationKeyCode="Space" nodesDraggable={!locked} nodesConnectable={!locked} edgesReconnectable={!locked} deleteKeyCode={null}
            defaultViewport={savedViewportUsable ? { ...value.layout.viewport, x: value.layout.viewport.x * 1.45, y: value.layout.viewport.y * 1.7 } : undefined} onMoveEnd={persistViewport} minZoom={0.01} fitView={!savedViewportUsable} fitViewOptions={{ minZoom: 0.7, maxZoom: 0.95, padding: 0.12 }}>
            <StudioRoutingObserver /><Background /><Controls showFitView={false} showInteractive={false} /><MiniMap className="automation-studio-minimap" style={{ width: 112, height: 72 }} pannable zoomable />
          </ReactFlow></StudioRoutingProvider>
          {context && <CanvasContextMenu x={context.x} y={context.y} width={canvas.current?.clientWidth || 500} height={Math.max(120, Math.min(canvas.current?.clientHeight || 500, window.innerHeight - Math.max(0, canvas.current?.getBoundingClientRect().top || 0)))} items={menuItems} onClose={closeContext} />}
        </div>
      </>}
    </div>
    {fileOpen && <AutomationDialog title="ファイル・有効期限" onCancel={() => setFileOpen(false)}>
      {formatSelect}<div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={exportText}>ルールを書き出す</button><button type="button" className={button} disabled={locked} onClick={() => ruleFile.current?.click()}>ルールを読み込む</button><button type="button" className={button} disabled={locked} onClick={() => fragmentFile.current?.click()}>部品を読み込む</button></div>
      <label className="block text-sm">通知の有効期限（分）<input aria-label="通知の有効期限" title="空欄は無期限" placeholder="無期限" type="number" min={1} max={525600} className={field} disabled={locked} value={value.expiresAfterMinutes || ""} onChange={e => { const { expiresAfterMinutes: _old, ...rest } = value; update(e.target.value ? { ...rest, expiresAfterMinutes: Number(e.target.value) } : rest); }} /></label>
      <button type="button" className={button} disabled={locked} onClick={() => { update(model.autoLayout(value)); setFileOpen(false); }}>接続順に整列</button>
    </AutomationDialog>}
  </div>;
}
