"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RuleEditor, type Rule, type Bindings } from "./rule-editor";
import { MonitorManager } from "./monitor-manager";
import { DeliveryHistory } from "./delivery-history";
import { DictionaryManager } from "./dictionary-manager";
import { MarketplaceManager } from "./marketplace-manager";
import { AutomationDialog } from "./automation-dialog";
import { automationFetch } from "./automation-feedback";
import { recoveryKey, encodeRecovery, decodeRecovery } from "../../../src/automation/draft-recovery";
import { ArrowLeft, ArrowRight, Bell, Check, Clock3, FileUp, Filter, Link2, Search, StickyNote, TrendingDown, AlertTriangle, LockKeyhole } from "lucide-react";
import "./automation.css";
import "./studio-workspace.css";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
const emptyBindings: Bindings = { destinations: {}, dictionaries: {} };
const formatNames: Record<string, string> = { normal: "通常のBot展開", expanded: "通知側で直接展開", card: "カード", text: "テキスト", url: "URLのみ" };
function activationPreview(value: any) {
  if (!value || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 || typeof value.expectedTargetsToken !== "string" || !value.expectedTargetsToken
    || !Array.isArray(value.affectedTargets) || value.affectedTargets.some((row: any) => !row || !["auto", "price", "x"].includes(row.kind) || typeof row.id !== "string" || typeof row.name !== "string")) {
    throw new Error("適用先を確認できません。もう一度［通知に適用］から確認してください。");
  }
  return value;
}
const starters = [
  { goal: "all", time: "now", label: "すべての新着を届ける", icon: Bell },
  { goal: "keyword", time: "now", label: "キーワードで絞り込む", icon: Filter },
  { goal: "down", time: "now", label: "値下げだけを知らせる", icon: TrendingDown },
  { goal: "all", time: "day", label: "9〜22時に通知する", icon: Clock3 },
];
const download = (text: string, filename: string, mime = "application/json") => { const link = document.createElement("a"); const url = URL.createObjectURL(new Blob([text], { type: mime })); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); };

export function AutomationWorkspace({ viewerId, guildId, canEdit = true, presentation = "standalone" }: { viewerId: string; guildId?: string; canEdit?: boolean; presentation?: "standalone" | "embedded" }) {
  const [tab, setTab] = useState("monitors"), [catalog, setCatalog] = useState<any>(null), [items, setItems] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null), [draft, setDraft] = useState<Rule | null>(null), [bindings, setBindings] = useState<Bindings>(emptyBindings);
  const [editorValid, setEditorValid] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const [destinations, setDestinations] = useState<any[]>([]), [dictionaries, setDictionaries] = useState<any[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [working, setBusy] = useState(false);
  const [savedRead, setSavedRead] = useState<{ message: string; read: () => Promise<void> } | null>(null);
  const busy = working || !!savedRead;
  async function finishCommit(message: string, read: () => Promise<void>) {
    const saved = { message, read }; setSavedRead(saved); setNotice(message);
    try { await read(); setSavedRead(current => current === saved ? null : current); }
    catch { setError(`${message}［保存後の表示を更新］で最新の状態を確認してください。`); }
  }
  const [goal, setGoal] = useState("all"), [time, setTime] = useState("now"), [display, setDisplay] = useState("normal"), [scope, setScope] = useState("private");
  const [history, setHistory] = useState<any[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false), [historyNext, setHistoryNext] = useState<number | null>(null), [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState("");
  const historyRequest = useRef(0), historyCursors = useRef(new Set<number>());
  const historySelection = useRef(selected); historySelection.current = selected;
  const [visitedResources, setVisitedResources] = useState<string[]>(["monitors"]);
  useEffect(() => { setVisitedResources(old => old.includes(tab) ? old : [...old, tab]); }, [tab]);
  const [textDraft, setTextDraft] = useState<{ text: string; format: string } | null>(null), [recoveryReady, setRecoveryReady] = useState(false), [recoveryWarning, setRecoveryWarning] = useState("");
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false), [memoOpen, setMemoOpen] = useState(false), [memoDraft, setMemoDraft] = useState("");
  const [ruleSearch, setRuleSearch] = useState(""), [ruleState, setRuleState] = useState("all");
  const [notificationChoices, setNotificationChoices] = useState<any[]>([]), [notificationTarget, setNotificationTarget] = useState("");
  const [notificationLoading, setNotificationLoading] = useState(false), [notificationError, setNotificationError] = useState("");
  const [notificationActionError, setNotificationActionError] = useState("");
  const [applyTargets, setApplyTargets] = useState<any[] | null>(null);
  const [notificationNext, setNotificationNext] = useState<Record<string, string | null>>({ auto: null, price: null });
  const actionsMenu = useRef<HTMLDetailsElement>(null), actionsToggle = useRef<HTMLElement>(null), historyPanel = useRef<HTMLElement>(null), ruleNameInput = useRef<HTMLInputElement>(null);
  const workspaceId = useId();
  const storageKey = recoveryKey(viewerId, guildId);
  const recoveredSource = useRef<{ workflowId: string; baseRevision: number } | null>(null);
  const dirty = !!draft && (!!textDraft || !selected || JSON.stringify(draft) !== JSON.stringify(selected.draft) || JSON.stringify(bindings) !== JSON.stringify(selected.bindings));
  const api = useCallback(async (path: string, method = "GET", body?: any) => {
    const url = `/api/automation/${path}${path.includes("?") ? "&" : "?"}${guildId ? `guildId=${encodeURIComponent(guildId)}` : ""}`;
    return automationFetch(url, { method, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }, [guildId]);
  const historyContext = useRef({ api, viewerId });
  if (historyContext.current.api !== api || historyContext.current.viewerId !== viewerId) {
    historyContext.current = { api, viewerId }; historyRequest.current++;
  }
  useEffect(() => {
    historyRequest.current++; historyCursors.current.clear(); setHistory([]); setHistoryNext(null); setHistoryOpen(false); setHistoryError(""); setHistoryLoading(false);
    return () => { historyRequest.current++; };
  }, [api, viewerId, selected?.id, selected?.revision]);
  async function loadHistory(beforeRevision?: number) {
    const target = historySelection.current, context = historyContext.current;
    if (!target) return;
    const request = ++historyRequest.current;
    setHistoryOpen(true); setHistoryLoading(true); setHistoryError("");
    const current = () => request === historyRequest.current && context === historyContext.current && target.id === historySelection.current?.id && target.revision === historySelection.current?.revision;
    try {
      const result = await api(`workflows/${target.id}/history?${new URLSearchParams({ page: "1", limit: "50", beforeRevision: String(beforeRevision ?? target.revision + 1) })}`);
      if (!current()) return;
      const items = Array.isArray(result) ? result : result?.items, next = Array.isArray(result) ? null : result?.nextRevision;
      if (!Array.isArray(items)) throw new Error("Invalid history page");
      let previous = beforeRevision ?? Number.POSITIVE_INFINITY;
      for (const row of items) {
        if (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= previous || row.revision > target.revision) throw new Error("Invalid history order");
        previous = row.revision;
      }
      if (next !== null && (!Number.isSafeInteger(next) || next < 1 || !items.length || next !== items[items.length - 1].revision || beforeRevision !== undefined && historyCursors.current.has(next))) throw new Error("Invalid history cursor");
      if (beforeRevision === undefined) historyCursors.current.clear();
      if (next !== null) historyCursors.current.add(next);
      setHistory(old => beforeRevision === undefined ? items : [...old, ...items]); setHistoryNext(next);
      if (actionsMenu.current) actionsMenu.current.open = false;
    } catch { if (current()) setHistoryError("変更履歴を取得できませんでした。もう一度読み込んでください。"); }
    finally { if (current()) setHistoryLoading(false); }
  }
  const destinationLoadEpoch = useRef(0), destinationAPI = useRef(api);
  destinationAPI.current = api;
  useEffect(() => {
    let active = true;
    async function recover() {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (!raw) return;
        const record = decodeRecovery(raw, viewerId, guildId);
        // Re-authorize against the server before displaying an existing rule.
        const current = record.workflowId ? await api(`workflows/${record.workflowId}`) : null;
        if (!active) return;
        const conflict = current && Number(current.revision) !== record.baseRevision;
        // A conflict creates a separate draft. Retain the exact edition it
        // came from so another reload or copy cannot drop its trusted origin.
        if (conflict && record.workflowId) {
          const baseRevision = record.baseRevision;
          if (baseRevision === null) throw new Error("DRAFT_RECOVERY_REVISION");
          recoveredSource.current = { workflowId: record.workflowId, baseRevision };
        } else recoveredSource.current = null;
        setSelected(conflict ? null : current); setDraft(record.definition); setBindings(record.bindings);
        setTextDraft(record.textDraft); setScope(conflict ? "private" : record.scope); setTab("rules"); setStudioOpen(true); setEditorValid(false);
        setNotice(conflict ? "別の場所で更新されたため、編集を個人用の下書きに復元しました。まだ適用されていません。" : "未保存の編集を復元しました。まだ適用されていません。");
      } catch {
        if (active) { setRecoveryFailed(true); setRecoveryWarning("編集を復元できません。アクセス権を確認して再読み込みしてください。"); }
      } finally { if (active) setRecoveryReady(true); }
    }
    void recover();
    return () => { active = false; };
  }, [api, viewerId, guildId, storageKey]);
  useEffect(() => {
    if (!recoveryReady) return;
    try {
      if (!dirty) { if (!recoveryFailed) { sessionStorage.removeItem(storageKey); setRecoveryWarning(""); } return; }
      sessionStorage.setItem(storageKey, encodeRecovery({ ownerId: viewerId, guildId, workflowId: selected?.id || recoveredSource.current?.workflowId || null, baseRevision: selected?.revision || recoveredSource.current?.baseRevision || null, scope: selected?.scope || scope, definition: draft, bindings, textDraft }));
      setRecoveryWarning(""); setRecoveryFailed(false);
    } catch {
      try { sessionStorage.removeItem(storageKey); } catch { /* storage may be disabled */ }
      setRecoveryWarning("編集を復元用に保存できません。ページを閉じる前に下書きを保存してください。");
    }
  }, [recoveryReady, recoveryFailed, dirty, storageKey, viewerId, guildId, selected, scope, draft, bindings, textDraft]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const task = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (err: any) { setError(err.message); } finally { setBusy(false); } };
  const refresh = useCallback(async () => {
    const epoch = ++destinationLoadEpoch.current;
    const resourcePages = async (resource: string) => {
      const result: any[] = [], cursors = new Set<string>();
      let cursor = "";
      do {
        const page = await api(cursor ? `${resource}?afterId=${encodeURIComponent(cursor)}` : resource);
        if (!Array.isArray(page.items)) throw new Error("一覧を再読み込みしてください。");
        result.push(...page.items);
        cursor = page.nextCursor || "";
        if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("一覧を再読み込みしてください。");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return result;
    };
    const [rules, dest, dict] = await Promise.all([resourcePages("workflows"), resourcePages("destinations"), resourcePages("dictionaries")]);
    if (destinationAPI.current === api && epoch === destinationLoadEpoch.current) { setItems(rules); setDictionaries(dict); setDestinations(dest); }
  }, [api]);
  const refreshDestination = useCallback(async (id: string) => {
    const saved = await api(`destinations/${encodeURIComponent(id)}`);
    if (destinationAPI.current !== api) return;
    destinationLoadEpoch.current++;
    setDestinations(previous => [...previous.filter(row => row.id !== saved.id), saved]);
  }, [api]);
  useEffect(() => { api("catalog").then(setCatalog).catch(err => setError(err.message)); refresh().catch(err => setError(err.message)); }, [api, refresh]);
  useEffect(() => { if (new URLSearchParams(window.location.hash.slice(1)).has("automation-package")) setTab("marketplace"); }, []);
  useEffect(() => { if (history.length) { historyPanel.current?.focus(); historyPanel.current?.scrollIntoView({ block: "nearest" }); } }, [history]);
  useEffect(() => { if (tab === "rules" && studioOpen && catalog) ruleNameInput.current?.focus(); }, [tab, studioOpen, catalog]);
  function canReplaceDraft() { if (dirty && !confirm("未保存の編集を破棄してルールを切り替えますか？")) return false; setTextDraft(null); return true; }
  function openAssignedWorkflow(id: string) {
    if (!canReplaceDraft()) return;
    void task(async () => { await choose({ id }); setTab("rules"); });
  }
  async function choose(item: any) { const value = await api(`workflows/${item.id}`); recoveredSource.current = null; if (item.id !== selected?.id) setNotificationTarget(""); setSelected(value); setDraft(value.draft); setBindings(value.bindings); setTextDraft(null); setEditorVersion(previous => previous + 1); setHistory([]); setStudioOpen(true); setEditorValid(false); return value; }
  function createTemplate(templateGoal = "all", templateTime = "now", templateFormat = "normal") {
    if (!canReplaceDraft()) return;
    void task(async () => {
      const definition = await api(`template?goal=${encodeURIComponent(templateGoal)}&time=${encodeURIComponent(templateTime)}&format=${encodeURIComponent(templateFormat)}`);
      recoveredSource.current = null;
      setSelected(null); setDraft(definition); setBindings(emptyBindings); setHistory([]); setNotificationTarget(""); setStudioOpen(true); setEditorValid(false);
    });
  }
  async function save() {
    if (!draft) return;
    if (!editorValid) throw new Error("ルールの設定を確認してください。未反映のテキストがある場合は修正してください。");
    let saved;
    if (!selected) {
      const created = await api("workflows", "POST", { definition: draft, bindings, scope,
        ...(recoveredSource.current ? { sourceWorkflowId: recoveredSource.current.workflowId, expectedSourceRevision: recoveredSource.current.baseRevision } : {}) });
      recoveredSource.current = null;
      setSelected(created); setDraft(created.draft); setBindings(created.bindings);
      saved = created;
    } else {
      const result = await api(`workflows/${selected.id}`, "PATCH", { definition: draft, bindings, expectedRevision: selected.revision });
      saved = { ...selected, ...result, name: draft.name, description: draft.description, draft, bindings };
      setSelected(saved); setDraft(saved.draft); setBindings(saved.bindings); setTextDraft(null);
    }
    setNotice("下書きを保存しました。まだ通知には適用されていません。");
    try { await refresh(); } catch { setError("下書きは保存済みです。［一覧を再読み込み］で再確認してください。"); }
    return saved;
  }
  async function importPackage(file: File) {
    if (!canReplaceDraft()) return;
    if (file.size > 32 * 1024 * 1024) throw new Error("ファイルは32 MiB以下にしてください。");
    let body;
    if (file.name.endsWith(".zip")) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let raw = ""; for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
      body = { base64: btoa(raw) };
    } else body = { bundle: JSON.parse(await file.text()) };
    const preview = await api("import", "POST", { ...body, preview: true });
    if (!confirm(`${preview.workflow?.name || "辞書パック"} を${scope === "private" ? "個人用" : "サーバー共有"}の下書きとして取り込みますか？`)) return;
    const result = await api("import", "POST", { ...body, scope });
    await finishCommit("下書きに取り込みました。通知先を選んで適用してください。", async () => { await refresh(); if (result.workflow) await choose(result.workflow); });
  }
  const inStudio = tab === "rules" && studioOpen && !!draft;
  const readOnly = !!(selected?.scope === "guild" && !canEdit);
  const workflowState = (item: any) => !item.activeRevision ? "draft" : item.enabled ? "active" : "paused";
  const visibleRules = items.filter(item => (ruleState === "all" || workflowState(item) === ruleState) && `${item.name} ${item.description || ""}`.toLocaleLowerCase().includes(ruleSearch.trim().toLocaleLowerCase()));
  const currentScope = selected?.scope || scope;
  const matchingNotifications = notificationChoices.filter(row => row.scope === currentScope);
  const targetNotification = matchingNotifications.find(row => `${row.kind}:${row.id}` === notificationTarget);
  const attachedNotifications = selected ? matchingNotifications.filter(row => row.workflowId === selected.id) : [];
  const readNotificationChoices = useCallback(async () => {
    const lists = await Promise.all(["auto", "price"].map(async kind => {
      const rows: any[] = [], seen = new Set<string>(); let after: string | null = null;
      do {
        const page = await api(`monitors/${kind}${after ? `?afterId=${encodeURIComponent(after)}` : ""}`);
        rows.push(...page.items.map((row: any) => ({ ...row, kind })));
        after = page.nextCursor || null;
        if (after && seen.has(after)) throw new Error("通知一覧が更新されています。再読み込みしてください。");
        if (after) seen.add(after);
      } while (after);
      return rows;
    }));
    let xRows: any[] = [];
    if (currentScope === "private") {
      try { const page = await api("x-monitors"); if (!Array.isArray(page.items)) throw new Error("X通知一覧を再読み込みしてください。"); xRows = page.items.filter((row: any) => row.state !== "deleted").map((row: any) => ({ ...row, kind: "x", scope: "private", workflowId: row.notificationSettings?.workflowId || null, destinationId: row.notificationSettings?.destinationId || null })); }
      catch (cause: any) { if (!["X_MONITOR_UNAVAILABLE", "X_ROLLOUT_DISABLED", "X_ROLLOUT_SUPPORTERS_ONLY"].includes(cause?.code)) throw cause; }
    }
    return [...lists.flat(), ...xRows];
  }, [api, currentScope]);
  const loadNotificationChoices = useCallback(async () => {
    const rows = await readNotificationChoices(); setNotificationChoices(rows); setNotificationNext({ auto: null, price: null }); return rows;
  }, [readNotificationChoices]);
  useEffect(() => {
    if (!inStudio) return;
    let active = true; setNotificationLoading(true); setNotificationError("");
    readNotificationChoices().then(rows => { if (active) { setNotificationChoices(rows); setNotificationNext({ auto: null, price: null }); } })
      .catch(err => { if (active) setNotificationError(err.message); }).finally(() => { if (active) setNotificationLoading(false); });
    return () => { active = false; };
  }, [readNotificationChoices, inStudio]);
  async function prepareApply() {
    await loadNotificationChoices();
    const affected = selected ? activationPreview(await api(`workflows/${selected.id}/activation-preview`)).affectedTargets : [];
    if (!affected.length) { setNotificationOpen(true); return; }
    setApplyTargets(affected);
  }
  async function applyToAttached() {
    let preview = activationPreview(await api(`workflows/${selected.id}/activation-preview`));
    const affected = preview.affectedTargets;
    const signature = (rows: any[]) => JSON.stringify(rows.map(row => [row.kind, row.id, row.revision]).sort());
    if (!affected.length || signature(affected) !== signature(applyTargets || [])) {
      setApplyTargets(affected.length ? affected : null); if (!affected.length) setNotificationOpen(true);
      throw new Error("対象の通知が変わりました。適用先を確認し直してください。");
    }
    const saved = dirty || !selected ? await save() : selected; if (!saved) return;
    preview = activationPreview(await api(`workflows/${saved.id}/activation-preview`));
    if (signature(preview.affectedTargets) !== signature(affected)) { setApplyTargets(preview.affectedTargets); throw new Error("対象の通知が変わりました。適用先を確認し直してください。"); }
    const activation = await api(`workflows/${saved.id}/activate`, "POST", { expectedRevision: saved.revision, expectedTargetsToken: preview.expectedTargetsToken });
    setSelected({ ...saved, ...activation, enabled: true, activeRevision: saved.revision }); setApplyTargets(null);
    setNotice(`${affected.length}件の通知に適用しました。`);
    try { await choose(saved); await refresh(); }
    catch { setError("通知に適用済みです。画面を再読み込みしてください。"); }
  }
  useEffect(() => { if (!inStudio) { setNotificationOpen(false); setMemoOpen(false); } }, [inStudio]);
  async function notificationTask(work: () => Promise<unknown>, reading = false) {
    setBusy(true); setNotificationActionError(""); if (reading) setNotificationError(""); setError(""); setNotice("");
    try { await work(); }
    catch (err: any) { if (reading) setNotificationError(err.message); else setNotificationActionError(err.message); }
    finally { setBusy(false); }
  }
  async function useForNotification(cloneOnly = false) {
    if (!targetNotification || readOnly) return;
    const rows = await readNotificationChoices();
    const target = rows.find(row => row.kind === targetNotification.kind && row.id === targetNotification.id);
    if (!target || target.revision !== targetNotification.revision || target.workflowId !== targetNotification.workflowId) { setNotificationChoices(rows); throw new Error("選んだ通知が変更されました。最新の設定を確認して、もう一度選んでください。"); }
    const initialPreview = selected && !cloneOnly ? activationPreview(await api(`workflows/${selected.id}/activation-preview`)) : null;
    const affected = (initialPreview?.affectedTargets || []).filter((row: any) => row.kind !== target.kind || row.id !== target.id);
    if (!cloneOnly && affected.length && (dirty || !selected.enabled || selected.activeRevision !== selected.revision) && !confirm(`選んだ通知に加えて、次の${affected.length}件にも変更を適用します。\n${affected.map((row: any) => row.name).join("\n")}\n続けますか？`)) return;
    const saved = cloneOnly ? await api("workflows", "POST", { definition: { ...draft, name: `${draft?.name}（${targetNotification.name}用）`.slice(0, 120) }, bindings, scope: currentScope, sourceWorkflowId: selected?.id, expectedSourceRevision: selected?.revision }) : dirty || !selected ? await save() : selected;
    if (!saved) return;
    if (cloneOnly) { setSelected(saved); setDraft(saved.draft); setBindings(saved.bindings); }
    let applied = saved;
    if (!saved.enabled || saved.activeRevision !== saved.revision) {
      const preview = activationPreview(await api(`workflows/${saved.id}/activation-preview`));
      const signature = (entries: any[]) => JSON.stringify(entries.map(row => [row.kind, row.id, row.revision]).sort());
      if (initialPreview && signature(initialPreview.affectedTargets) !== signature(preview.affectedTargets)) { setNotificationChoices(await readNotificationChoices()); throw new Error("対象の通知が変わりました。適用先を確認し直してください。"); }
      const activation = await api(`workflows/${saved.id}/activate`, "POST", { expectedRevision: saved.revision, expectedTargetsToken: preview.expectedTargetsToken });
      applied = { ...saved, ...activation, enabled: true, activeRevision: saved.revision }; setSelected(applied);
    }
    if (target.kind === "x") await api(`x-monitors/${target.id}`, "PATCH", { expectedRevision: target.revision, notificationSettings: { ...target.notificationSettings, workflowId: applied.id } });
    else await api(`workflows/${applied.id}/attach`, "POST", { targetKind: target.kind, targetId: target.id, expectedRevision: target.revision, expectedWorkflowId: target.workflowId || null });
    try { await choose(applied); await refresh(); await loadNotificationChoices(); setNotificationError(""); setNotificationOpen(false); }
    catch { setNotificationError("通知に適用済みです。画面を再読み込みしてください。"); }
    setNotice(`「${targetNotification.name}」に適用しました。${!targetNotification.enabled ? "この通知は停止中です。" : "次の新着・価格変化から通知します。"}`);
  }
  return <div className={`automation-app space-y-3 ${inStudio ? "automation-studio" : ""}`}>
    {savedRead && <section aria-label="保存後の表示の再取得"><p role="status">{savedRead.message}</p><button className={button} disabled={working} onClick={() => void task(() => finishCommit(savedRead.message, savedRead.read))}>保存後の表示を更新</button></section>}
    {!inStudio && <>{presentation === "standalone" || guildId ? <header className="automation-header"><div><h1 className="text-xl font-semibold">自動通知</h1><div className="mt-1 flex flex-wrap gap-3"><a href="/dashboard/automation/plans" className="inline-block text-sm text-primary underline">プラン・お支払い</a><a href="/dashboard/automation/support" className="inline-block text-sm text-primary underline">支援・寄付</a>{!guildId ? <a href="/dashboard/automation/x" className="inline-block text-sm text-primary underline">自分のX通知セットアップ</a> : null}</div></div><label className="flex items-center gap-2 text-sm">作成先<select className={field} value={scope} onChange={e => setScope(e.target.value)}><option value="private">自分だけ</option>{guildId && canEdit && <option value="guild">サーバー共有</option>}</select></label></header> : null}
    <nav className="automation-navigation" aria-label="通知メニュー">{[["monitors", "通知一覧"], ["rules", "通知ルール"], ["history", "配信予定・履歴"], ["dictionaries", "辞書"], ["marketplace", "共有ルール"]].map(([id, name]) => <button key={id} disabled={!recoveryReady || busy} aria-current={tab === id ? "page" : undefined} onClick={() => { setTab(id); void task(refresh); }}>{name}</button>)}</nav></>}
    {error && !applyTargets && !notificationOpen && <div role="alert" className="space-y-2 rounded border border-destructive bg-destructive/5 p-3 text-sm text-destructive"><p>{error}</p><button type="button" className={button} disabled={busy} onClick={() => void task(async () => { const [value] = await Promise.all([api("catalog"), refresh()]); setCatalog(value); })}>一覧を再読み込み</button>{error.startsWith("ログインの有効期限") ? <a href="/api/auth/signin/discord?callbackUrl=/dashboard/automation" target="_blank" rel="noreferrer" className={button}>別のタブでログイン</a> : null}</div>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {recoveryWarning && <p role="alert" className="rounded border border-amber-500 p-3 text-sm">{recoveryWarning}</p>}
    {catalog?.deliverySafety?.available === false && !inStudio && <p role="status" className="rounded border border-amber-500 p-3 text-sm">送信・公開を利用できません。時間をおいて再試行してください。</p>}
    {dirty && !inStudio && <p role="status" className="text-xs text-muted-foreground">ルールに未保存</p>}
    {visitedResources.includes("monitors") && <div hidden={tab !== "monitors"} key={`monitors:${viewerId}:${guildId || "personal"}`}><MonitorManager active={tab === "monitors"} api={api} guildId={guildId} canEdit={canEdit} scope={scope} destinations={destinations} rules={items} refresh={refresh} refreshDestination={refreshDestination} onOpenWorkflow={openAssignedWorkflow} externalError={error} /></div>}
    {visitedResources.includes("history") && <div hidden={tab !== "history"} key={`history:${viewerId}:${guildId || "personal"}`}><DeliveryHistory api={api} canEdit={canEdit} active={tab === "history"} /></div>}
    {tab === "rules" && <>
      {studioOpen && draft ? <nav className="automation-workspace-navigation" aria-label="スタジオの移動"><button className={button + " studio-back"} disabled={busy} onClick={() => setStudioOpen(false)}><ArrowLeft size={16} aria-hidden="true" />ルール一覧へ</button><div><button className={button} disabled={busy} onClick={() => setTab("monitors")}>通知一覧</button><button className={button} disabled={busy} onClick={() => setTab("history")}>配信予定・履歴</button></div></nav> : <div className="studio-library">
        <section className="studio-start" aria-labelledby={`${workspaceId}-start`}>
          <div className="studio-section-heading"><div><h2 id={`${workspaceId}-start`}>通知ルールを作る</h2></div><span className="studio-scope">{scope === "private" ? "自分だけ" : "サーバー共有"}</span></div>
          <div className="studio-start-cards">{starters.map((starter, index) => <button key={`${starter.goal}-${starter.time}`} className="studio-start-card" aria-label={index === 0 ? "新しいルール" : `${starter.label}ルールを作成`} disabled={busy || !recoveryReady || !catalog} onClick={() => createTemplate(starter.goal, starter.time)}><starter.icon size={22} aria-hidden="true" /><span><strong>{starter.label}</strong></span><ArrowRight size={16} aria-hidden="true" /></button>)}</div>
          {catalog && <details className="studio-template-options"><summary>テンプレートを選ぶ</summary><div className="studio-template-fields"><label>通知する内容<select aria-label="目的" className={field} value={goal} onChange={e => setGoal(e.target.value)}>{catalog.goals.map((g: any) => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label><label>通知する時間<select aria-label="配信時間" className={field} value={time} onChange={e => setTime(e.target.value)}>{catalog.times.map((t: any) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label><label>表示形式<select aria-label="表示形式" className={field} value={display} onChange={e => setDisplay(e.target.value)}>{catalog.formats.map((f: string) => <option key={f} value={f}>{formatNames[f] || f}</option>)}</select></label><button className={button + " automation-save-primary"} disabled={busy || !recoveryReady} onClick={() => createTemplate(goal, time, display)}>ルールを作る</button></div></details>}
          <div className="studio-source-guide"><button className={button} disabled={busy} onClick={() => setTab("monitors")}>URLと通知先を登録<ArrowRight size={14} aria-hidden="true" /></button></div>
        </section>
        {draft && <div className="studio-resume"><div><strong>{draft.name || "名前のないルール"}</strong><span>{dirty ? "未保存" : "保存済み"}</span></div><button className={button} disabled={busy} onClick={() => setStudioOpen(true)}>編集を続ける<ArrowRight size={16} aria-hidden="true" /></button></div>}
        <section className="studio-saved-rules" aria-labelledby={`${workspaceId}-rules`}>
          <div className="studio-section-heading"><div><h2 id={`${workspaceId}-rules`}>ルール一覧 <span className="studio-count">{items.length}</span></h2></div><div className="studio-library-tools"><button className={button} disabled={busy} onClick={() => setTab("marketplace")}>共有ルールを探す</button><label className={button + " studio-import"}><FileUp size={16} aria-hidden="true" />ルールを取り込む<input className="sr-only" type="file" accept=".json,.zip" disabled={busy || !recoveryReady} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void task(() => importPackage(file)); }} /></label></div></div>
          {items.length > 0 && <div className="studio-library-filter"><label className="studio-search"><span>ルールを検索</span><div><Search size={16} aria-hidden="true" /><input aria-label="ルールを検索" className={field} value={ruleSearch} placeholder="ルール名や説明を検索" onChange={e => setRuleSearch(e.target.value)} /></div></label><label>状態<select aria-label="ルールの状態で絞り込む" className={field} value={ruleState} onChange={e => setRuleState(e.target.value)}><option value="all">すべて</option><option value="active">稼働中</option><option value="paused">停止中</option><option value="draft">未適用</option></select></label><span role="status">{visibleRules.length}件</span></div>}
          <div className="studio-rule-list">{visibleRules.map(item => <button key={item.id} className="studio-rule-card" disabled={busy || !recoveryReady} onClick={() => { if (canReplaceDraft()) void task(async () => { await choose(item); }); }}><div className="studio-rule-card-heading"><strong>{item.name}</strong><span className="studio-rule-state" data-state={workflowState(item)}>{workflowState(item) === "active" ? "稼働中" : workflowState(item) === "paused" ? "停止中" : "未適用"}</span></div>{item.description && <p>{item.description}</p>}<div className="studio-rule-card-footer"><div className="studio-rule-card-meta"><span>{item.scope === "private" ? "自分だけ" : "サーバー共有"}</span><span>下書き v{item.revision}</span>{!!item.activeRevision && <span>適用版 v{item.activeRevision}</span>}</div><ArrowRight size={16} aria-hidden="true" /></div></button>)}</div>
          {visibleRules.length === 0 && items.length > 0 && <div className="studio-library-empty"><Search size={22} aria-hidden="true" /><button className={button} onClick={() => { setRuleSearch(""); setRuleState("all"); }}>絞り込みを解除</button></div>}
        </section>
      </div>}
      {studioOpen && draft && catalog && <fieldset disabled={busy} className="automation-workbench space-y-3">
        <header className="automation-workspace-heading nokey studio-workspace-heading">
          <div className="studio-rule-identity"><label className="studio-rule-name"><span className="sr-only">ルール名</span><input ref={ruleNameInput} aria-label="ルール名" className={field + " font-semibold"} readOnly={readOnly} maxLength={120} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><button className={button + " studio-memo-toggle"} aria-label="ルールのメモ" title={draft.description || "ルールにメモを添える"} onClick={() => { setMemoDraft(draft.description || ""); setMemoOpen(true); }}><StickyNote size={15} aria-hidden="true" />メモ</button></div>
          <div role="status" aria-label="ルールの状態" className="automation-workspace-status">
            <span data-unsaved={dirty} >{dirty ? "未保存" : "保存済み"}</span>
            {selected && <span>下書き v{selected.revision}</span>}
            <span>{!selected?.activeRevision ? "未適用" : selected.enabled ? `実行版 v${selected.activeRevision}` : `停止中（適用版 v${selected.activeRevision}）`}</span>
            <span>{(selected?.scope || scope) === "private" ? "自分だけ" : "サーバー共有"}{readOnly ? "（閲覧のみ）" : ""}</span>
          </div>
          <div className="automation-workspace-actions">
            <button className={button + " automation-save-primary"} disabled={busy || !editorValid || selected?.scope === "guild" && !canEdit} title="実行版を変えずに下書きを保存" onClick={() => void task(save)}>下書きを保存</button>
            <button className={button + " automation-apply-secondary"} disabled={busy || !editorValid || readOnly} title={dirty ? "編集内容を保存して、この版を通知に使います" : "保存済みの下書きを通知に使います"} onClick={() => void task(prepareApply)}>通知に適用</button>
            <button className={button + " studio-notification-toggle"} disabled={busy} onClick={() => { setNotificationActionError(""); setNotificationOpen(true); }}><Link2 size={15} aria-hidden="true" />通知を選ぶ</button>
            {selected && <details ref={actionsMenu} className="automation-workspace-menu" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); if (actionsMenu.current) actionsMenu.current.open = false; actionsToggle.current?.focus(); } }}>
              <summary ref={actionsToggle}>その他の操作</summary>
              <div className="automation-workspace-menu-content">
                <div role="group" aria-label="実行の切り替え"><h2>実行</h2>
                  <button className={button} disabled={busy || !selected.activeRevision || selected.scope === "guild" && !canEdit} title={!selected.activeRevision ? "まず下書きを適用してください" : undefined} onClick={() => void task(async () => { const result = await api(`workflows/${selected.id}/state`, "POST", { expectedRevision: selected.revision, enabled: !selected.enabled }); const saved = { ...selected, ...result }; setSelected(saved); setItems(previous => previous.map(item => item.id === saved.id ? { ...item, ...result } : item)); setNotice(saved.enabled ? "ルールを再開しました。" : "ルールを停止しました。"); try { await refresh(); } catch { setError("ルールの変更は保存済みです。［一覧を再読み込み］で再確認してください。"); } })}>{selected.enabled ? "ルールを停止" : "ルールを再開"}</button>
                </div>
                <div role="group" aria-label="ルールの再利用"><h2>再利用</h2><div>
                  <button className={button} disabled={!editorValid || readOnly} onClick={() => void task(async () => { const copy = await api("workflows", "POST", { scope: currentScope, definition: { ...draft, name: `${draft.name} のコピー`.slice(0, 120) }, bindings, sourceWorkflowId: selected?.id, expectedSourceRevision: selected?.revision }); setSelected(copy); setDraft(copy.draft); setBindings(copy.bindings); setTextDraft(null); setEditorVersion(previous => previous + 1); setNotice("ルールを複製しました。"); try { await refresh(); } catch { setError("複製したルールは保存済みです。［一覧を再読み込み］で再確認してください。"); } })}>ルールを複製</button>
                  <button className={button} onClick={() => { if (dirty && !confirm("未保存の編集は含まれません。保存済みの下書きをエクスポートしますか？")) return; void task(async () => { const data = await api(`workflows/${selected.id}/export`); download(JSON.stringify(data, null, 2), "automation-package.json"); }); }}>共有用に書き出す</button>
                </div></div>
                <div role="group" aria-label="版の確認"><h2>版の確認</h2><button className={button} disabled={historyLoading} onClick={() => void loadHistory()}>変更履歴</button></div>
                <div role="group" aria-label="ルールの削除" className="automation-workspace-danger"><h2>削除</h2>
                  <button className={`${button} text-destructive`} disabled={selected.scope === "guild" && !canEdit} onClick={() => { if (confirm("このルールを削除し、使用中の通知を停止します。ルールの割り当ても外れます。通知を再開すると通常通知になります。削除しますか？")) void task(async () => { await api(`workflows/${selected.id}`, "DELETE", { expectedRevision: selected.revision }); setItems(previous => previous.filter(row => row.id !== selected.id)); setSelected(null); setDraft(null); setTextDraft(null); setNotice("ルールを削除しました。"); try { await refresh(); } catch { setError("ルールは削除済みです。［一覧を再読み込み］で一覧を確認してください。"); } }); }}>ルールを削除</button>
                </div>
              </div>
            </details>}
          </div>
          {(readOnly || dirty || !selected?.activeRevision || selected.revision !== selected.activeRevision) && <p className="studio-save-guidance studio-critical-note">{readOnly ? <><LockKeyhole size={13} aria-hidden="true" />共有ルールの編集にはサーバー管理権限が必要です</> : <><Check size={13} aria-hidden="true" />下書きを保存しても、適用するまで通知は変わりません</>}</p>}
        </header>
        {historyOpen && <section ref={historyPanel} tabIndex={-1} className="automation-version-history nokey" aria-label="変更履歴">
          <div className="automation-version-history-heading"><h2>変更履歴</h2><button className={button} onClick={() => { historyRequest.current++; setHistory([]); setHistoryNext(null); setHistoryOpen(false); setHistoryLoading(false); actionsToggle.current?.focus(); }}>履歴を閉じる</button></div>
          <div className="automation-version-history-list">{history.map(row => <div className="automation-version-row" data-workflow-revision={row.revision} key={row.revision}>
            <div id={`${workspaceId}-revision-${row.revision}`}><span>版 {row.revision}</span><time dateTime={new Date(row.createdAtMs).toISOString()}>{new Date(row.createdAtMs).toLocaleString()}</time>{row.revision === selected?.activeRevision && <span className="automation-version-badge">{selected.enabled ? "実行版" : "適用版"}</span>}{row.revision === selected?.revision && <span className="automation-version-badge">保存済みの下書き</span>}</div>
            <button className={button} aria-describedby={`${workspaceId}-revision-${row.revision}`} disabled={selected?.scope === "guild" && !canEdit} onClick={() => { if (dirty && !confirm("未保存の編集を置き換えて、この版を下書きに復元しますか？実行中の版は変わりません。")) return; void task(async () => { const saved = await api(`workflows/${selected.id}/restore`, "POST", { revision: row.revision, expectedRevision: selected.revision }); setSelected(null); setDraft(null); setTextDraft(null); setHistory([]); await finishCommit(Number.isSafeInteger(saved.revision) ? `版 ${saved.revision} を下書きに復元しました。` : "ルールを下書きに復元しました。", async () => { await choose({ id: selected.id }); await refresh(); }); }); }}>この版を下書きに復元</button>
          </div>)}</div>
          {historyLoading ? <p role="status">変更履歴を読み込み中…</p> : null}
          {historyError ? <p role="alert">{historyError}</p> : null}
          {historyNext !== null ? <button className={button} disabled={historyLoading} onClick={() => void loadHistory(historyNext)}>古い版を読み込む</button> : historyError ? <button className={button} disabled={historyLoading} onClick={() => void loadHistory()}>変更履歴を再取得</button> : null}
        </section>}
        <RuleEditor key={`${selected?.id || "new"}:${editorVersion}`} onValidityChange={setEditorValid} value={draft} bindings={bindings} resources={{ destinations, dictionaries }} onBindingsChange={setBindings} onChange={setDraft} catalog={catalog} api={api} readOnly={busy || selected?.scope === "guild" && !canEdit} initialTextDraft={textDraft} onTextDraftChange={setTextDraft} />
      </fieldset>}
      {inStudio && applyTargets && <AutomationDialog title="通知への適用を確認" busy={busy} error={error} onCancel={() => setApplyTargets(null)}><p>このルールを使う{applyTargets.length}件の通知を更新します。</p><ul>{applyTargets.map(row => <li key={`${row.kind}:${row.id}`}>{row.name}{!row.enabled ? "（停止中）" : ""}</li>)}</ul><button className={button} disabled={busy || !editorValid || readOnly} onClick={() => void task(applyToAttached)}>{applyTargets.length}件の通知に適用</button><button className={button} onClick={() => { setApplyTargets(null); setNotificationOpen(true); }}>1件だけ変更する通知を選ぶ</button></AutomationDialog>}
      {inStudio && draft && memoOpen && <AutomationDialog title="ルールのメモ" busy={busy} onCancel={() => setMemoOpen(false)}><label className="studio-memo-field">メモ<textarea aria-label="ルール説明" className={field} readOnly={readOnly} rows={4} maxLength={8000} value={memoDraft} placeholder="目的や覚えておきたいこと" onChange={event => setMemoDraft(event.target.value)} /></label><div className="studio-dialog-actions"><button className={button + " automation-save-primary"} disabled={busy} onClick={() => { if (!readOnly) setDraft({ ...draft, description: memoDraft }); setMemoOpen(false); }}>{readOnly ? "閉じる" : "メモを反映"}</button></div></AutomationDialog>}
      {inStudio && notificationOpen && <AutomationDialog title="ルールを使う通知" busy={busy} error={notificationError || notificationActionError} onCancel={() => setNotificationOpen(false)}><div className="studio-notification-dialog-content">
          {attachedNotifications.length > 0 && <div className="studio-attached-notifications"><Check size={16} aria-hidden="true" /><span>{attachedNotifications.map(row => row.name).join("、")}</span></div>}
          {readOnly && <p role="status" className="studio-critical-note"><LockKeyhole size={15} aria-hidden="true" />共有ルールの適用にはサーバー管理権限が必要です</p>}
          {notificationLoading ? <p role="status">通知を読み込み中…</p> : <>
            {notificationError && <button className={button} disabled={busy} onClick={() => void notificationTask(loadNotificationChoices, true)}>再読み込み</button>}
            {!notificationError && matchingNotifications.length === 0 && <p role="status">{currentScope === "guild" ? "サーバー共有" : "自分用"}で使える通知は0件です。通知一覧から同じ範囲の通知を登録してください。</p>}
            {!notificationError && matchingNotifications.length > 0 && <div className="studio-notification-assignment"><label>通知<select className={field} aria-label="ルールを使う通知" disabled={readOnly || busy} value={notificationTarget} onChange={e => setNotificationTarget(e.target.value)}><option value="">通知を選択</option>{["auto", "price", "x"].map(kind => <optgroup key={kind} label={kind === "auto" ? "新着通知" : kind === "price" ? "価格通知" : "X通知"}>{matchingNotifications.filter(row => row.kind === kind).map(row => <option key={`${kind}:${row.id}`} value={`${kind}:${row.id}`}>{row.name}{row.workflowId === selected?.id ? "（設定済み）" : ""}{!row.enabled ? "（停止中）" : ""}</option>)}</optgroup>)}</select></label><button className={button + " automation-save-primary"} disabled={!targetNotification || !editorValid || readOnly || busy} onClick={() => void notificationTask(() => useForNotification())}>保存して通知に適用</button>{selected && attachedNotifications.some(row => row.kind !== targetNotification?.kind || row.id !== targetNotification?.id) && <button className={button} disabled={!targetNotification || !editorValid || readOnly || busy} onClick={() => void notificationTask(() => useForNotification(true))}>ルールを複製して、この通知だけに適用</button>}</div>}
            {attachedNotifications.length > 0 && <details><summary>このルールを使う通知 {attachedNotifications.length}件</summary><ul>{attachedNotifications.map(row => <li key={`${row.kind}:${row.id}`}>{row.name}</li>)}</ul></details>}
            {targetNotification && <div className="studio-assignment-guidance"><p className="studio-critical-note"><Bell size={14} aria-hidden="true" />{destinations.find(d => d.id === targetNotification.destinationId)?.name || (targetNotification.destinationType === "dm" ? "自分のDM" : "登録済みチャンネル")}</p>{targetNotification.workflowId && targetNotification.workflowId !== selected?.id && <p className="studio-critical-note"><AlertTriangle size={14} aria-hidden="true" />この通知で使用中のルールを置き換えます</p>}</div>}
            {(notificationNext.auto || notificationNext.price) && <button className={button} disabled={busy} onClick={() => void notificationTask(async () => { const pages = await Promise.all(["auto", "price"].filter(kind => notificationNext[kind]).map(async kind => ({ kind, page: await api(`monitors/${kind}?afterId=${encodeURIComponent(notificationNext[kind]!)}`) }))); setNotificationChoices(old => [...old, ...pages.flatMap(({ page }) => page.items)]); setNotificationNext(old => ({ ...old, ...Object.fromEntries(pages.map(({ kind, page }) => [kind, page.nextCursor])) })); }, true)}>通知をさらに表示</button>}
          </>}
          <button className={button + " studio-notification-list-link"} disabled={busy} onClick={() => { setNotificationOpen(false); setScope(currentScope); setTab("monitors"); }}>通知一覧を開く<ArrowRight size={14} aria-hidden="true" /></button>
        </div></AutomationDialog>}
    </>}
    {visitedResources.includes("dictionaries") && <div hidden={tab !== "dictionaries"} key={`dictionaries:${viewerId}:${guildId || "personal"}`}><DictionaryManager api={api} dictionaries={dictionaries} scope={scope} canEdit={canEdit} refresh={refresh} /></div>}
    {visitedResources.includes("marketplace") && <div hidden={tab !== "marketplace"} key={`marketplace:${viewerId}:${guildId || "personal"}`}><MarketplaceManager active={tab === "marketplace"} api={api} scope={scope} canEdit={canEdit} rules={items} dictionaries={dictionaries} currentRuleId={selected?.id} refresh={refresh} openRule={async id => { if (canReplaceDraft()) { await choose({ id }); setTab("rules"); } }} /></div>}
  </div>;
}
