"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Info, LockKeyhole } from "lucide-react";
import { valueLabels } from "./rule-labels";
import { AutomationDialog } from "./automation-dialog";
import { MonitorRegistration } from "./monitor-registration";
import { sourceProvider, monitorState } from "../../../src/automation/monitor-input";
import { automationPlanName } from "./automation-feedback";
import { MonitorCadenceEditor } from "./monitor-cadence-editor";
import { XMonitorManager } from "./x-monitor-manager";
import { DestinationEditor } from "./destination-editor";
import { monitorBehaviorChanged, monitorWorkflowChanged, rebaseMonitorDraft } from "./monitor-edit-view";
import { MonitorDeliveryActivity } from "./monitor-delivery-activity";
import { readinessOf } from "./monitor-readiness";
import { youtubeReceiveSummary } from "./youtube-watch-options";
import { useAnonymousPageTiming } from "./anonymous-page-timing";
import type { XMonitor } from "./x-monitor-view";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
type Props = { api: (path: string, method?: string, body?: any) => Promise<any>; guildId?: string; canEdit: boolean; scope: string; destinations: any[]; rules: any[]; refresh: () => Promise<void>; refreshDestination?: (id: string) => Promise<void>; onOpenWorkflow?: (id: string) => void; externalError?: string; active?: boolean };
type DestinationOrigin = { kind: "normal"; monitor: any } | { kind: "x"; onCreated?: (id: string) => void };
type NormalKind = "auto" | "price";
type UnifiedXRow = { key: string; item: XMonitor; node: ReactNode; filterState: "active" | "attention" | "paused"; searchText: string };
const newMonitor = (kind: string) => ({ kind, name: "", providerId: kind === "auto" ? "youtube" : "amazon", source: "", locale: "ja", destinationId: "", enabled: true, mode: "change", maxPriceAmount: "", minDiscountPercent: "", workflowId: "" });
type NotificationProfile = { plan: { id: string; tier: string; name: string; priority: number; slotLimit: number; minuteLimit: number; dayLimit: number }; slots: { used: number; max: number; available: number }; usage: { entries: { targetKind: string; targetId: string; todayUsed: number; todayReserved: number; dayLimit: number; minuteLimit: number; resetAtMs: number; allowed?: boolean }[] } };
function receiveSummary(row: any) {
  if (row.kind === "auto" && row.providerId === "youtube") return youtubeReceiveSummary(row.youtubeOptions);
  if (row.kind === "auto") return "新しい投稿を通知";
  if (row.mode === "change") return "価格の変化を通知";
  return [row.maxPriceAmount != null && `価格が${row.maxPriceAmount}以下`, row.minDiscountPercent != null && `割引率が${row.minDiscountPercent}%以上`].filter(Boolean).join(" または ");
}

export function MonitorManager({ api, guildId, canEdit, scope, destinations: suppliedDestinations, rules, refresh, refreshDestination, onOpenWorkflow, externalError, active = true }: Props) {
  const [deletedDestinations, setDeletedDestinations] = useState<string[]>([]);
  const destinations = suppliedDestinations.filter(row => !deletedDestinations.includes(row.id));
  const [filterKind, setFilterKind] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [destinationsOpen, setDestinationsOpen] = useState(false);
  const destinationsPanel = useRef<HTMLDetailsElement>(null);
  const [xRegistrationRequest, setXRegistrationRequest] = useState<{ id: number; accountHandle?: string; name?: string; destinationId?: string }>();
  const registrationSerial = useRef(0);
  const [kind, setKind] = useState("auto"), [items, setItems] = useState<any[]>([]), [cursors, setCursors] = useState<Record<NormalKind, string | null>>({ auto: null, price: null });
  const [catalog, setCatalog] = useState<any>(null), [monitor, setMonitor] = useState<any>(null), [dest, setDest] = useState<any>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [cadenceBusy, setCadenceBusy] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false), [destOpen, setDestOpen] = useState(false);
  const [monitorConflict, setMonitorConflict] = useState(false), [monitorEditVersion, setMonitorEditVersion] = useState(0);
  const [query, setQuery] = useState(""), [state, setState] = useState("all");
  const listContext = useRef({ api, query, state, scope });
  listContext.current = { api, query, state, scope };
  const [loadingKinds, setLoadingKinds] = useState<Record<NormalKind, boolean>>({ auto: true, price: true });
  const [loadErrors, setLoadErrors] = useState<Record<NormalKind, string>>({ auto: "", price: "" });
  const loading = loadingKinds.auto || loadingKinds.price;
  const [profile, setProfile] = useState<NotificationProfile | null>(null), [profileError, setProfileError] = useState("");
  const visible = items.map(row => readinessOf(row, rules, destinations));
  const filtered = !!query.trim() || state !== "all";
  const requestEpoch = useRef<Record<NormalKind, number>>({ auto: 0, price: 0 });
  const requestedCursors = useRef<Record<NormalKind, Set<string>>>({ auto: new Set(), price: new Set() });
  const profileEpoch = useRef(0);
  const cadenceDrafts = useRef(new Map<string, string>());
  const destinationSaving = useRef(false);
  const xReload = useRef<(() => Promise<void>) | null>(null);
  const previousExternalError = useRef(externalError);
  const monitorOriginal = useRef<any>(null), monitorSaving = useRef(false);
  const monitorDraft = useRef(monitor); monitorDraft.current = monitor;
  const destinationOrigin = useRef<DestinationOrigin | null>(null), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; destinationOrigin.current = null; }; }, []);
  const kindRef = useRef(kind); kindRef.current = kind;
  const normalActive = active;
  useAnonymousPageTiming("notifications", normalActive, loading, Boolean(error || loadErrors.auto || loadErrors.price));
  const activeRef = useRef(normalActive); activeRef.current = normalActive;
  const workspaceActiveRef = useRef(active); workspaceActiveRef.current = active;
  const editable = (row: any) => row?.scope !== "guild" || canEdit;
  const autoRegistrationAllowed = catalog?.autoRegistration?.eligible === true;
  const loadProfile = useCallback(async () => {
    if (!activeRef.current) return;
    const epoch = ++profileEpoch.current, context = listContext.current;
    try {
      const result = await context.api("entitlements");
      if (!activeRef.current || epoch !== profileEpoch.current || !sameOwnerContext(context)) return;
      setProfile(result); setProfileError("");
    } catch {
      if (activeRef.current && epoch === profileEpoch.current && sameOwnerContext(context)) setProfileError("利用枠を確認できません。［更新］で再確認してください。");
    }
  }, [api]);
  const loadProfileRef = useRef(loadProfile); loadProfileRef.current = loadProfile;
  function sameListContext(before: typeof listContext.current) {
    const current = listContext.current;
    return before.api === current.api && before.query === current.query && before.state === current.state && before.scope === current.scope;
  }
  function sameOwnerContext(before: typeof listContext.current) {
    return before.api === listContext.current.api && before.scope === listContext.current.scope;
  }
  function begin(selectedKind: string) {
    if (selectedKind === "x") { setAddOpen(false); setXRegistrationRequest({ id: ++registrationSerial.current }); return; }
    if (monitor && (monitor.kind || kind) === selectedKind) { setAddOpen(false); setKind(selectedKind); setMonitorOpen(true); return; }
    if (monitor && !confirm("保持中の通知の入力を破棄して、別の種類の通知を追加しますか？")) return;
    const destination = destinations.find(d => d.enabled && (scope !== "guild" || d.scope === "guild"));
    setAddOpen(false); setKind(selectedKind);
    setMonitor({ ...newMonitor(selectedKind), scope, destinationId: destination?.id || "" });
    monitorOriginal.current = null; setMonitorConflict(false);
    setMonitorOpen(true);
  }
  function beginDestination(onCreated?: (id: string) => void) {
    destinationOrigin.current = onCreated ? { kind: "x", onCreated } : { kind: "normal", monitor };
    setError(""); setDestOpen(true);
    if (!dest) setDest({ name: "", kind: "dm", scope: "private", guildId: guildId || "", webhookUrl: "", channelId: "", enabled: true });
  }
  function openWorkflow(id: string) { setMonitorOpen(false); onOpenWorkflow?.(id); }
  function cancelDestination() {
    // Retain the form, but detach the old requesting draft. Resuming from X
    // explicitly binds a fresh callback to that X draft.
    destinationOrigin.current = null; setDestOpen(false); setError("");
  }
  async function saveDestination() {
    if (destinationSaving.current || !dest) return;
    destinationSaving.current = true;
    const origin = destinationOrigin.current;
    try {
      await task(async () => {
        const destinationGuild = dest.kind === "dm" ? "" : dest.guildId || guildId || "";
        const path = `destinations${dest.id ? `/${dest.id}` : ""}${destinationGuild && destinationGuild !== guildId ? `?guildId=${encodeURIComponent(destinationGuild)}` : ""}`;
        const saved = await api(path, dest.id ? "PATCH" : "POST", { ...dest, expectedRevision: dest.revision });
        if (!dest.id && mounted.current && workspaceActiveRef.current && origin && destinationOrigin.current === origin) {
          if (origin.kind === "x") origin.onCreated?.(saved.id);
          else setMonitor((current: any) => current && current === origin.monitor ? { ...current, destinationId: saved.id } : current);
        }
        // Clear only after a successful write. A subsequent refresh failure
        // must not make retry create another destination or webhook.
        setDest(null); setDestOpen(false);
        destinationOrigin.current = null;
        try { if (refreshDestination) await refreshDestination(saved.id); else await refresh(); }
        catch { throw new Error("通知先は保存済みです。通知一覧を再読み込みすると、追加した通知先を選択できます。"); }
        setNotice("通知先を保存しました。X監視や通常の通知で選択できます。");
      });
    } finally { destinationSaving.current = false; }
  }
  useEffect(() => {
    if (!monitor?.source && !dest?.name && !dest?.webhookUrl) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [monitor, dest]);
  function changeSource(source: string) {
    setError("");
    const providerId = sourceProvider(source);
    if (!monitor.id && scope === "private" && providerId === "twitter") { setMonitor({ ...monitor, source, providerId }); return; }
    const nextKind = providerId ? ["amazon", "steam"].includes(providerId) ? "price" : "auto" : kind;
    if (providerId && !catalog?.[nextKind]?.some((p: any) => p.id === providerId)) { setMonitor({ ...monitor, source }); setError(`${valueLabels[providerId] || providerId}は対象外です。対応サービスのURLを入力してください。`); return; }
    if (monitor.id && nextKind !== kind) { setMonitor({ ...monitor, source }); setError("通知の種類は変更できません。別の通知を追加してください。"); return; }
    setKind(nextKind);
    setMonitor({ ...monitor, source, kind: nextKind, providerId: providerId || monitor.providerId });
  }
  const task = async (work: () => Promise<void>) => { const context = listContext.current; setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e: any) { if (sameOwnerContext(context)) { setError(e.message); if (e.code === "AUTOMATION_SLOT_LIMIT") void loadProfileRef.current(); } } finally { setBusy(false); } };
  async function load(selectedKind = kind, afterId?: string) {
    if (!activeRef.current) return;
    if (selectedKind !== "auto" && selectedKind !== "price") throw new Error("通知の種類を確認してください。");
    const target = selectedKind as NormalKind, epoch = ++requestEpoch.current[target], context = listContext.current;
    const current = () => activeRef.current && epoch === requestEpoch.current[target] && sameListContext(context);
    setLoadingKinds(previous => ({ ...previous, [target]: true }));
    setLoadErrors(previous => ({ ...previous, [target]: "" }));
    const search = new URLSearchParams({ query: context.query, state: context.state, ...(afterId ? { afterId } : {}) });
    try {
      const result = await context.api(`monitors/${selectedKind}?${search}`);
      if (!current()) return;
      if (!Array.isArray(result.items) || result.nextCursor != null && typeof result.nextCursor !== "string") throw new Error("一覧を確認できませんでした。");
      if (afterId && result.nextCursor && (result.nextCursor === afterId || requestedCursors.current[target].has(result.nextCursor))) throw new Error("一覧の続きを確認できませんでした。");
      if (afterId) requestedCursors.current[target].add(afterId); else requestedCursors.current[target].clear();
      const incoming = result.items.map((row: any) => ({ ...row, kind: target }));
      setItems(old => !current() ? old : afterId ? [...old.filter(row => row.kind !== target || !incoming.some((entry: any) => entry.id === row.id)), ...incoming] : [...old.filter(row => row.kind !== target), ...incoming]);
      setCursors(previous => current() ? { ...previous, [target]: result.nextCursor || null } : previous);
      void loadProfileRef.current();
    } catch (error) { if (current()) { setLoadErrors(previous => current() ? { ...previous, [target]: "一覧を読み込めませんでした。" } : previous); throw error; }
    } finally { if (current()) setLoadingKinds(previous => current() ? { ...previous, [target]: false } : previous); }
  }
  async function reloadAll(includeX = false) { const reads: Promise<unknown>[] = [load("auto"), load("price")]; if (includeX && xReload.current) reads.push(xReload.current()); await Promise.allSettled(reads); }
  useEffect(() => {
    const previous = previousExternalError.current, recovered = Boolean(previous) && !externalError;
    previousExternalError.current = externalError;
    if (!recovered || !active) return;
    setError(current => current === previous ? "" : current);
    let current = true;
    void api("providers").then(value => { if (current) setCatalog(value); }).catch(cause => { if (current) setError(cause.message); });
    if (scope === "private") void xReload.current?.();
    return () => { current = false; };
  }, [externalError, active, scope, api]);
  useEffect(() => { if (!normalActive) return; let alive = true; api("providers").then(providers => { if (alive) setCatalog(providers); }).catch(e => alive && setError(e.message)); return () => { alive = false; }; }, [api, normalActive, rules]);
  useEffect(() => { if (normalActive) void loadProfile(); return () => { profileEpoch.current++; }; }, [loadProfile, normalActive]);
  useEffect(() => {
    const navigate = () => { if (scope === "private" && window.location.hash === "#x-notifications") setFilterKind("x"); };
    navigate(); window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [scope]);
  useEffect(() => { if (scope !== "private") setFilterKind(current => current === "x" ? "all" : current); }, [scope]);
  useEffect(() => {
    if (!normalActive) { requestEpoch.current.auto++; requestEpoch.current.price++; return; }
    setItems([]); setCursors({ auto: null, price: null }); setLoadErrors({ auto: "", price: "" }); setLoadingKinds({ auto: true, price: true });
    requestedCursors.current.auto.clear(); requestedCursors.current.price.clear();
    const timer = setTimeout(() => { void reloadAll(); }, query ? 250 : 0);
    return () => { clearTimeout(timer); requestEpoch.current.auto++; requestEpoch.current.price++; };
  }, [api, query, state, scope, normalActive, rules]);
  async function saveMonitor(current = monitor) {
    if (monitorSaving.current) return;
    if (monitorConflict) throw new Error("最新の通知設定を取得してから、変更内容を確認してください。");
    monitorSaving.current = true;
    const mutationContext = listContext.current;
    try {
    const monitor = current;
    const selectedKind = monitor.kind || kind, original = monitorOriginal.current;
    const input = { ...monitor, name: monitor.name.trim() || monitor.source.trim().slice(0, 120), scope: monitor.scope || scope, expectedRevision: monitor.revision,
      maxPriceAmount: monitor.maxPriceAmount === "" ? null : monitor.maxPriceAmount,
      minDiscountPercent: monitor.minDiscountPercent === "" ? null : monitor.minDiscountPercent };
    const behaviorChanged = monitorBehaviorChanged(original, input, selectedKind), workflowChanged = monitorWorkflowChanged(original, monitor);
    const labelChanged = original?.name !== input.name;
    const result = !monitor.id || behaviorChanged ? await api(`monitors/${selectedKind}${monitor.id ? `/${monitor.id}` : ""}`, monitor.id ? "PATCH" : "POST", input)
      : labelChanged ? await api(`monitors/${selectedKind}/${monitor.id}`, "PATCH", { name: input.name, expectedRevision: monitor.revision }) : { id: monitor.id, revision: monitor.revision };
    // The target is persisted first. If the optional rule assignment fails, show
    // its saved ID and let the user retry the assignment, not duplicate creation.
    const saved = { ...monitor, name: input.name, id: result.id, revision: result.revision, scope: input.scope };
    if (sameOwnerContext(mutationContext)) {
      setMonitor((previous: any) => sameOwnerContext(mutationContext) ? saved : previous);
      monitorOriginal.current = { ...saved, workflowId: original?.workflowId || "" };
    }
    try {
      if (workflowChanged) {
        const guards = { expectedRevision: result.revision, expectedWorkflowId: original?.workflowId || null };
        const assignment = monitor.workflowId
          ? await api(`workflows/${monitor.workflowId}/attach`, "POST", { targetKind: selectedKind, targetId: result.id, ...guards })
          : monitor.id ? await api(`monitors/${selectedKind}/${result.id}`, "POST", { action: "detach", ...guards }) : null;
        if (assignment) {
          if (!Number.isSafeInteger(assignment.revision) || assignment.revision < result.revision || (monitor.workflowId ? assignment.attached !== true : assignment.detached !== true)) {
            throw Object.assign(new Error("Invalid assignment result"), { code: "REVISION_CONFLICT", status: 409 });
          }
          saved.revision = assignment.revision; if (sameOwnerContext(mutationContext)) setMonitor((previous: any) => sameOwnerContext(mutationContext) ? { ...saved } : previous);
        }
      }
    } catch (cause: any) {
      if (cause?.code === "REVISION_CONFLICT" || cause?.status === 409) throw Object.assign(new Error("通知または詳細ルールが別の操作で変更されました。最新の設定を取得して、保持した入力を確認してください。"), { code: typeof cause?.code === "string" ? cause.code : "REVISION_CONFLICT", status: 409 });
      throw new Error("通知は保存済みです。詳細ルールを割り当てるには、もう一度保存してください。");
    }
    if (!sameOwnerContext(mutationContext)) return;
    monitorOriginal.current = { ...saved };
    setItems(previous => sameOwnerContext(mutationContext) && (previous.some(row => row.kind === selectedKind && row.id === saved.id) || sameListContext(mutationContext))
      ? [...previous.filter(row => row.kind !== selectedKind || row.id !== saved.id), { ...saved, kind: selectedKind }] : previous);
    setMonitor((previous: any) => sameOwnerContext(mutationContext) ? null : previous); setMonitorOpen(previous => sameOwnerContext(mutationContext) ? false : previous); monitorOriginal.current = null;
    setNotice(previous => sameOwnerContext(mutationContext) ? selectedKind === "auto" ? "新着通知を保存しました。" : "価格通知を保存しました。" : previous);
    try { await load(selectedKind); } catch { setError("通知は保存済みです。［更新］で一覧を再確認してください。"); }
    } catch (cause: any) {
      if (sameOwnerContext(mutationContext) && (current?.id || monitorOriginal.current?.id) && (cause?.code === "REVISION_CONFLICT" || cause?.status === 409)) setMonitorConflict(true);
      throw cause;
    } finally { monitorSaving.current = false; }
  }
  async function reloadMonitorDraft() {
    const draft = monitorDraft.current, before = monitorOriginal.current;
    if (!draft?.id || !before) return;
    const selectedKind = draft.kind || kind, seen = new Set<string>(); let after = "";
    do {
      const response = await api(`monitors/${selectedKind}?${new URLSearchParams({ state: "all", ...(after ? { afterId: after } : {}) })}`);
      if (!mounted.current || !workspaceActiveRef.current || monitorDraft.current !== draft) return;
      const latest = response.items.find((row: any) => String(row.id) === String(draft.id));
      if (latest) {
        monitorOriginal.current = { ...latest, kind: selectedKind };
        setMonitor(rebaseMonitorDraft(before, draft, latest, selectedKind)); setMonitorConflict(false); setMonitorEditVersion(value => value + 1);
        setNotice("最新の通知設定を取得しました。変更した入力を引き継いでいます。内容を確認して保存してください。"); return;
      }
      after = response.nextCursor || "";
      if (after && seen.has(after)) throw new Error("最新の通知を取得できませんでした。入力を保持しています。もう一度お試しください。");
      if (after) seen.add(after);
    } while (after);
    throw new Error("この通知が見つかりません。入力を保持しています。削除や権限の変更をご確認ください。");
  }
  async function removeMonitor(row: any) {
    const selectedKind = row.kind || kind, mutationContext = listContext.current;
    await api(`monitors/${selectedKind}/${row.id}`, "DELETE", { expectedRevision: row.revision });
    if (!sameOwnerContext(mutationContext)) return;
    setItems(previous => sameOwnerContext(mutationContext) ? previous.filter(item => item.kind !== selectedKind || item.id !== row.id) : previous);
    if (String(monitor?.id) === String(row.id) && (monitor.kind || kind) === selectedKind) { setMonitor(null); setMonitorOpen(false); monitorOriginal.current = null; }
    setNotice("通知を削除しました。");
    try { await load(selectedKind); } catch { setError("通知は削除済みです。［一覧を再読み込み］で一覧を確認してください。"); }
  }
  async function removeDestination(row: any) {
    await api(`destinations/${row.id}`, "DELETE", { expectedRevision: row.revision });
    setDeletedDestinations(previous => [...previous, row.id]);
    if (dest?.id === row.id) { setDest(null); setDestOpen(false); destinationOrigin.current = null; }
    setNotice("通知先を削除しました。");
    try { await refresh(); } catch { setError("通知先は削除済みです。［一覧を再読み込み］で一覧を確認してください。"); }
  }
  async function reloadCadence(id: string) {
    if (!activeRef.current || kindRef.current !== "auto") return null;
    const epoch = ++requestEpoch.current.auto, context = listContext.current;
    setLoadingKinds(previous => ({ ...previous, auto: false }));
    const seen = new Set<string>(); let after = "";
    do {
      const result = await context.api(`monitors/auto?${new URLSearchParams({ state: "all", ...(after ? { afterId: after } : {}) })}`);
      if (!activeRef.current || epoch !== requestEpoch.current.auto || kindRef.current !== "auto" || !sameListContext(context)) return null;
      const latest = result.items.find((row: any) => String(row.id) === String(id));
      if (latest) {
        // A targeted re-read must retain the already loaded pages and filters.
        setItems(previous => sameListContext(context) && epoch === requestEpoch.current.auto ? previous.map(row => row.kind === "auto" && String(row.id) === String(id) ? { ...latest, kind: "auto" } : row) : previous);
        await loadProfileRef.current(); return latest;
      }
      after = result.nextCursor || "";
      if (after && (typeof after !== "string" || seen.has(after))) throw new Error("通知を再取得できませんでした。");
      if (after) seen.add(after);
    } while (after);
    return null;
  }
  async function reloadEditedCadence(id: string) {
    const draft = monitorDraft.current, before = monitorOriginal.current;
    const latest = await reloadCadence(id);
    if (latest && draft?.id === id && before && monitorDraft.current === draft) {
      monitorOriginal.current = { ...latest, kind: "auto" };
      setMonitor(rebaseMonitorDraft(before, draft, latest, "auto"));
    }
    return latest;
  }
  function openDestinations() {
    const panel = destinationsPanel.current;
    if (!panel) return;
    panel.open = true;
    panel.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    panel.scrollIntoView?.({ block: "start" });
  }
  function renderUnifiedList(xRows: UnifiedXRow[], xStatus: { loading: boolean; failed: boolean; reload: () => Promise<void> }) {
    xReload.current = scope === "private" ? xStatus.reload : null;
    const normalRows = visible.filter(row => filterKind === "all" || filterKind === row.kind);
    const normalizedQuery = query.trim().normalize("NFC").toLocaleLowerCase().normalize("NFC");
    const filteredX = xRows.filter(row => (filterKind === "all" || filterKind === "x")
      && (!normalizedQuery || row.searchText.normalize("NFC").toLocaleLowerCase().normalize("NFC").includes(normalizedQuery))
      && (state === "all" || row.filterState === state));
    const entries = [
      ...normalRows.map(row => ({ key: `${row.kind}:${row.id}`, name: String(row.name || row.source || ""), row, x: null as UnifiedXRow | null })),
      ...filteredX.map(x => ({ key: x.key, name: x.item.name || x.item.accountHandle || x.item.accountId || "", row: null, x })),
    ].sort((a, b) => a.name.localeCompare(b.name, "ja") || a.key.localeCompare(b.key));
    const includes = (target: string) => filterKind === "all" || filterKind === target;
    const normalError = Boolean(includes("auto") && loadErrors.auto || includes("price") && loadErrors.price);
    const xFailed = includes("x") && xStatus.failed;
    const stillLoading = Boolean(includes("auto") && loadingKinds.auto || includes("price") && loadingKinds.price || includes("x") && xStatus.loading);
    return <>
      {scope === "private" && (guildId || xRows.length > 0 || filterKind === "x") ? <a href="/dashboard/automation/x" className="nx-text-link">Xの接続を確認</a> : null}
      {stillLoading && <p role="status">通知を読み込んでいます…</p>}
      {externalError && (normalError || xFailed) ? <p role="status">{[includes("auto") && loadErrors.auto && "新着通知", includes("price") && loadErrors.price && "価格通知", xFailed && "X通知"].filter(Boolean).join("・")}を確認できませんでした。</p> : null}
      {!externalError && (["auto", "price"] as NormalKind[]).map(target => includes(target) && loadErrors[target] ? <p key={target} role="alert">{target === "auto" ? "新着通知" : "価格通知"}の{loadErrors[target]} <button className={button} disabled={busy} onClick={() => void task(() => load(target))}>再読み込み</button></p> : null)}
      {!externalError && xFailed && scope === "private" ? <button className={button} disabled={busy || xStatus.loading} onClick={() => void xStatus.reload()}>X通知を再読み込み</button> : null}
      {entries.length > 0 && <p role="status" className="text-xs text-muted-foreground">表示中 {entries.length}件</p>}
      <div className="monitor-list" aria-label="登録した通知">{entries.map(entry => {
        if (entry.x) return <Fragment key={entry.key}>{entry.x.node}</Fragment>;
        const row = entry.row, rowKind = row.kind as NormalKind;
        return <article key={entry.key} className="monitor-card space-y-3"><div className="monitor-card-heading"><h3 className="font-medium break-all">{row.name}</h3><span className="monitor-state" data-state={monitorState(row).id}>{monitorState(row).label}</span></div>
          <p className="text-sm">{receiveSummary(row)}</p><div className="monitor-source"><div><span>{valueLabels[row.providerId] || row.providerId}</span><span>{row.scope === "guild" ? "サーバー共有" : "自分用"}</span></div><a href={row.source} target="_blank" rel="noreferrer">{row.source}</a></div>
          {!profileError && profile?.usage?.entries?.filter(item => item.targetKind === rowKind && item.targetId === row.id).map(item => <div key={`${item.targetKind}:${item.targetId}`}><details className="text-xs text-muted-foreground"><summary>今日の送信 {item.todayUsed}通</summary><p>1日{item.dayLimit}通・1分{item.minuteLimit}通まで{item.todayReserved > 0 ? `。予約・確認待ち ${item.todayReserved}通` : ""}</p></details>{item.allowed === false && <p className="automation-critical-note text-xs">現在の登録上限を超えています。利用状況とプランを確認してください。</p>}</div>)}
          <dl className="monitor-facts"><div><dt>通知先</dt><dd>{destinations.find(d => d.id === row.destinationId)?.name || (row.destinationType === "dm" ? "本人のDM" : "登録済みチャンネル")}</dd></div><div><dt>次回確認</dt><dd>{!row.enabled ? "停止中" : row.nextCheckAtMs ? new Date(row.nextCheckAtMs).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "調整中"}</dd></div></dl>
          <MonitorDeliveryActivity api={api} kind={rowKind} targetId={String(row.id)} active={normalActive} />
          {["workflow", "destination"].includes(monitorState(row).action ?? "") && <div className="automation-critical-note text-sm"><Info size={16} aria-hidden="true" /><span>{monitorState(row).description}</span>{monitorState(row).action === "workflow" && onOpenWorkflow ? <button className={button} disabled={busy} onClick={() => openWorkflow(row.workflowId)}>割り当てたルールを開く</button> : monitorState(row).action === "destination" ? <a href="#notification-destinations" onClick={openDestinations}>通知先を確認</a> : null}</div>}
          <details className="text-xs text-muted-foreground"><summary>確認履歴・詳細ルール</summary><dl className="monitor-facts mt-2"><div><dt>前回確認</dt><dd>{row.lastCheckedAtMs ? new Date(row.lastCheckedAtMs).toLocaleString() : "未確認"}</dd></div>{row.intervalMinutes != null && <div><dt>確認間隔</dt><dd>{row.intervalMinutes}分</dd></div>}<div><dt>詳細ルール</dt><dd>{rules.find(r => r.id === row.workflowId)?.name || (row.workflowId ? "割り当てあり" : "通常の通知")}</dd></div></dl></details>
          {monitorState(row).id === "error" && <p className="automation-critical-note"><Info size={16} aria-hidden="true" />{/INVALID_CURSOR/.test(row.errorCode) ? "監視履歴の復旧が必要です。" : /NOT_FOUND/.test(row.errorCode) ? "URLと公開状態を確認してください。" : "取得に失敗しました。次回の確認で再試行します。"}</p>}
          <div className="monitor-card-actions"><button className={button} disabled={busy || !editable(row)} onClick={() => { if (monitor && !confirm("保持中の通知の入力を破棄して、別の通知を編集しますか？")) return; setKind(rowKind); monitorOriginal.current = { ...row, kind: rowKind }; setMonitorConflict(false); setMonitorOpen(true); setMonitor({ ...row, kind: rowKind, maxPriceAmount: row.maxPriceAmount ?? "", minDiscountPercent: row.minDiscountPercent ?? "", destinationId: row.destinationId || "", workflowId: row.workflowId || "" }); }}>設定を変更</button>
            <details className="monitor-action-menu"><summary>その他の操作</summary><div><button className={button} disabled={busy || !editable(row) || rowKind === "auto" && !row.enabled && !autoRegistrationAllowed} onClick={() => void task(async () => { const mutationContext = listContext.current; const result = await api(`monitors/${rowKind}/${row.id}`, "PATCH", { expectedRevision: row.revision, enabled: !row.enabled }); if (!sameOwnerContext(mutationContext)) return; setItems(previous => sameOwnerContext(mutationContext) ? previous.map(item => item.kind === rowKind && item.id === row.id ? { ...item, enabled: !row.enabled, revision: result.revision } : item) : previous); setNotice(row.enabled ? "通知を停止しました。" : "通知を再開しました。"); try { await load(rowKind); } catch { setError("通知の変更は保存済みです。［更新］で一覧を再確認してください。"); } })}>{row.enabled ? "停止" : "再開"}</button>
            <button className={`${button} text-destructive`} disabled={busy || !editable(row)} onClick={() => { if (confirm(`「${row.name}」を削除しますか？未送信の通知も取り消します。`)) void task(() => removeMonitor(row)); }}>削除</button></div></details></div>
        </article>;
      })}</div>
      {!stillLoading && !normalError && !xFailed && entries.length === 0 && <div className="monitor-empty"><p role="status">{filtered || filterKind !== "all" ? "検索結果は0件です" : "登録した通知は0件です"}</p>{(filtered || filterKind !== "all") && <button className={button} onClick={() => { setQuery(""); setState("all"); setFilterKind("all"); }}>検索条件をクリア</button>}</div>}
      {(["auto", "price"] as NormalKind[]).map(target => cursors[target] && (filterKind === "all" || filterKind === target) ? <button key={target} className={button} disabled={busy || loadingKinds[target]} onClick={() => void task(() => load(target, cursors[target] || undefined))}>{target === "auto" ? "新着通知をさらに表示" : "価格通知をさらに表示"}</button> : null)}
    </>;
  }
  return <div className="monitor-workspace notification-center">
    {error && error !== externalError && !monitorOpen && !destOpen && <div role="alert" className="space-y-2 rounded border border-destructive p-3 text-sm text-destructive"><p>{error}</p><button className={button} disabled={busy} onClick={() => void task(async () => { await reloadAll(true); await refresh(); })}>一覧を再読み込み</button></div>}{notice && !monitorOpen && !destOpen && <p role="status" className="rounded border p-3 text-sm">{notice}</p>}
    <div className="notification-center-toolbar"><div className="notification-add-controls"><button className="rounded border bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40" disabled={busy || monitorOpen || destOpen || addOpen || !active || scope === "guild" && !canEdit} onClick={() => setAddOpen(true)}>通知を追加</button><button type="button" className={`${button} notification-destination-shortcut`} disabled={!active || busy || monitorOpen || destOpen || addOpen} aria-controls="notification-destinations" aria-expanded={destinationsOpen} onClick={openDestinations}>通知先を見る</button></div></div>
    {addOpen && <AutomationDialog title="通知の種類を選択" open={active} onCancel={() => setAddOpen(false)} busy={busy}><div className="notification-add-options"><button type="button" className={button} onClick={() => begin("auto")}><strong>新着通知</strong><span>YouTube、配信、投稿など</span></button><button type="button" className={button} onClick={() => begin("price")}><strong>価格通知</strong><span>商品の値下げや価格の変化</span></button>{scope === "private" ? <button type="button" className={button} onClick={() => begin("x")}><strong>X通知</strong><span>Xアカウントの新しい投稿</span></button> : null}</div></AutomationDialog>}
    <section className="space-y-4" aria-label="通知一覧">
      {monitor && !monitorOpen && <div role="status" className="automation-draft-banner"><span>通知の入力を保持しています</span><button className={button} onClick={() => { setKind(monitor.kind || kind); setFilterKind(monitor.kind || kind); setMonitorOpen(true); }}>通知の入力を再開</button><button className={button} onClick={() => { if (confirm("通知の入力を破棄しますか？")) setMonitor(null); }}>通知の入力を破棄</button></div>}
      <div className="monitor-overview"><h2>登録した通知</h2><button className={button} disabled={busy} onClick={() => void task(() => reloadAll(true))}>更新</button></div>
      {profileError ? <p role="status" className="text-xs text-muted-foreground">{profileError}</p> : profile?.plan && profile.slots && <div className="notification-capacity-summary"><span>{automationPlanName(profile.plan.name) || "現在のプラン"}</span><strong>使用枠 {profile.slots.used} / {profile.slots.max}</strong><span>空き {profile.slots.available}枠</span><a href="/dashboard/automation/plans">利用状況とプランを確認</a><details className="w-full text-xs text-muted-foreground"><summary>通常通知の送信上限と枠の数え方</summary><p className="mt-2 leading-relaxed">1枠あたり1日{profile.plan.dayLimit}通・1分{profile.plan.minuteLimit}通まで{profile.plan.priority > 0 ? "。優先処理を適用します" : ""}。新着・価格・X通知の共通枠で、確認間隔に配分した追加枠と停止中の登録も含みます。実際に送信したメッセージ1件＝1通。日ごとの上限は日本時間の0時にリセットします。</p></details></div>}
      {scope === "guild" && !canEdit && <p className="automation-critical-note"><LockKeyhole size={16} aria-hidden="true" />通知の変更にはサーバーの編集権限が必要です。</p>}
      {kind === "auto" && catalog && !autoRegistrationAllowed && <p role="status" className="automation-critical-note"><LockKeyhole size={16} aria-hidden="true" />現在は新着通知を追加・再開できません。利用枠と通知の状態を確認してください。</p>}
      <div className="monitor-toolbar"><label className="monitor-search">通知を検索<input type="search" className={field} placeholder="名前・サービス・URLで検索" value={query} onChange={e => setQuery(e.target.value)} /></label><label>種類<select aria-label="通知の種類" className={field} value={filterKind} onChange={e => setFilterKind(e.target.value)}><option value="all">すべて</option><option value="auto">新着通知</option><option value="price">価格通知</option>{scope === "private" ? <option value="x">X通知</option> : null}</select></label><label>状態<select className={field} value={state} onChange={e => setState(e.target.value)}><option value="all">すべて</option><option value="active">監視中</option><option value="attention">確認・待機が必要</option><option value="paused">停止中</option></select></label></div>
      <XMonitorManager api={api} active={active && scope === "private"} allowSetup={!guildId} initiallyOpen setupPlacement="compact" hideAddAction unified listFilter={filterKind === "x" ? "x" : filterKind === "all" ? "all" : "other"} suppressReadErrors={Boolean(externalError) || filterKind !== "all" && filterKind !== "x"} renderUnifiedList={(rows, status) => scope === "private" ? renderUnifiedList(rows, status) : renderUnifiedList([], { loading: false, failed: false, reload: status.reload })} registrationRequest={xRegistrationRequest} destinations={destinations} rules={rules} onAddDestination={beginDestination} onOpenWorkflow={onOpenWorkflow} />
      {monitor && <AutomationDialog title={monitor.id ? "通知設定" : "通知を追加"} busy={busy || cadenceBusy} error={error} errorAction={<button type="button" className={button} disabled={busy || cadenceBusy} onClick={() => void task(async () => { await reloadAll(true); await refresh(); })}>一覧を再読み込み</button>} open={monitorOpen} onCancel={() => { setMonitorOpen(false); setError(""); }}>
        {notice && <p role="status" className="rounded border p-3 text-sm">{notice}</p>}
        <MonitorRegistration key={`${monitor.id ? `saved-${monitor.kind || kind}-${monitor.id}` : "new-monitor"}-${monitorEditVersion}`} api={api} monitor={monitor} original={monitorOriginal.current} saveBlocked={monitorConflict} kind={monitor.kind || kind} scope={scope} guildId={guildId} destinations={destinations} rules={rules} catalog={catalog} busy={busy || cadenceBusy} onChange={setMonitor} onSourceChange={changeSource} onSave={saveMonitor} run={task} refresh={refresh} onAddDestination={beginDestination} onOpenWorkflow={onOpenWorkflow ? openWorkflow : undefined}
          timingEditor={monitor.id && (monitor.kind || kind) === "auto" && monitorOriginal.current?.canAllocateCadence === true ? <section className="space-y-2" aria-label="通知タイミングの設定"><h3 className="text-sm font-medium">通知タイミング</h3><MonitorCadenceEditor row={monitorOriginal.current} pool={profileError ? null : profile?.slots ?? null} api={api} disabled={busy || !active || monitorConflict || !editable(monitor)} draftValue={cadenceDrafts.current.get(monitor.id)} onDraft={value => cadenceDrafts.current.set(monitor.id, value)} onReload={() => reloadEditedCadence(monitor.id)} onBusyChange={setCadenceBusy} /></section> : monitor.id ? <p className="text-sm text-muted-foreground">通知タイミング {monitor.intervalMinutes ? `約${monitor.intervalMinutes}分ごとに確認` : "現在のサービス設定を使用"}</p> : null}
          onXRegistration={scope === "private" ? accountHandle => {
            setXRegistrationRequest({ id: ++registrationSerial.current, accountHandle, name: monitor.name, destinationId: monitor.destinationId });
            setMonitorOpen(false); setError("");
          } : undefined} />
        {monitorConflict && <section className="rounded border p-3 text-sm" aria-label="通知設定の再確認"><p>別の操作で設定が変更されました。変更した入力を保持して、最新の設定と確認できます。</p><button type="button" className={button} disabled={busy} onClick={() => void task(reloadMonitorDraft)}>最新設定を取得して入力を引き継ぐ</button></section>}
      </AutomationDialog>}
    </section>
    <details ref={destinationsPanel} id="notification-destinations" className="notification-destinations" onToggle={event => setDestinationsOpen(event.currentTarget.open)}><summary className="font-semibold">通知先を管理</summary>
      {dest && !destOpen && <div role="status" className="automation-draft-banner"><span>通知先の入力を保持しています</span><button className={button} onClick={() => setDestOpen(true)}>通知先の入力を再開</button><button className={button} onClick={() => { if (confirm("通知先の入力を破棄しますか？")) setDest(null); }}>通知先の入力を破棄</button></div>}
      <button className={button} disabled={busy} onClick={() => beginDestination()}>通知先を追加</button>
      <div className="grid gap-2 md:grid-cols-2">{destinations.map(d => <div key={d.id} className="rounded border p-3"><h3 className="text-sm font-medium">{d.name}</h3><div className="automation-meta"><span>{d.kind === "dm" ? "DM" : d.createdByBot ? "チャンネル" : "Webhook"}</span><span>{d.enabled ? "有効" : "停止中"}</span></div><div className="mt-2 flex gap-2"><button className={button} disabled={busy || !editable(d)} onClick={() => { if (dest && !confirm("保持中の通知先の入力を破棄しますか？")) return; setDestOpen(true); setDest({ ...d, webhookUrl: "" }); }}>名前・状態を編集</button><button className={button} disabled={busy || !editable(d)} onClick={() => { if (confirm("この通知先を削除しますか？割り当て済みの通知は送信できなくなります。")) void task(() => removeDestination(d)); }}>削除</button></div></div>)}</div>
    </details>
      {dest && <AutomationDialog title={dest.id ? "通知先を編集" : "通知先を追加"} busy={busy} error={error} open={destOpen} onCancel={cancelDestination}><DestinationEditor api={api} draft={dest} onChange={setDest} guildId={guildId} scope={scope} canEdit={canEdit} busy={busy} open={destOpen} onSave={() => void saveDestination()} /></AutomationDialog>}
  </div>;
}
