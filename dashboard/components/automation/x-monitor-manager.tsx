"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { parseXMonitor, parseXQuota, xFeedback, xInterval, xObject, xPoolName, xReason, type XMonitor, type XMonitorAPI, type XMonitorQuota, type XProcessingMode } from "./x-monitor-view";
import { XMonitorMoveEditor } from "./x-monitor-move-editor";
import { XNotificationSetup } from "./x-notification-setup";
import { XProcessingSettings } from "./x-processing-settings";
import { xTimingLabel, xRealtimeBenefit } from "./x-monitor-timing-editor";
import { AutomationDialog } from "./automation-dialog";
import { MonitorDeliveryActivity } from "./monitor-delivery-activity";
import { readinessOf, workflowStatus, workflowStatusLabel } from "./monitor-readiness";
import { monitorState } from "../../../src/automation/monitor-input";
import { parseXSetupStatus, xReceiverLabel, type XSetupStatus, type XSetupSubscription } from "./x-setup-view";
import { ArrowRight, Clock3, Radio, ShieldCheck, Users, Zap } from "lucide-react";
import { useAnonymousPageTiming } from "./anonymous-page-timing";
import "./notification-x.css";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
type Choice = { id: string; name: string; enabled?: boolean; scope?: string };
type Draft = { accountHandle: string; name: string; enabled: boolean; destinationId: string; workflowId: string; subscriptionId: string; processingMode: XProcessingMode; processingTouched: boolean; poolPreference: "auto" | "supporter"; browserAcknowledgedHandle: string | null };
const draftOf = (item?: XMonitor): Draft => ({ accountHandle: item?.accountHandle ?? "", name: item?.name ?? "", enabled: item?.enabled ?? true,
  destinationId: item?.notificationSettings.destinationId ?? "", workflowId: item?.notificationSettings.workflowId ?? "", subscriptionId: item?.notificationSettings.subscriptionId ?? "", processingMode: item?.processing?.requestedMode ?? "batch", processingTouched: false, poolPreference: "auto", browserAcknowledgedHandle: null });
// Refreshing receiver/plan information must not advance the edit's CAS token.
// Only an explicit rebase (or this editor's successful pool move) adopts a new
// snapshot, preserving fields the user changed and taking other fields fresh.
function rebaseDraft(before: XMonitor, draft: Draft, latest: XMonitor): Draft {
  const original = draftOf(before), merged = draftOf(latest);
  for (const key of ["accountHandle", "name", "enabled", "destinationId", "workflowId", "subscriptionId"] as const) {
    if (draft[key] !== original[key]) Object.assign(merged, { [key]: draft[key] });
  }
  if (draft.processingTouched) { merged.processingMode = draft.processingMode; merged.processingTouched = true; }
  merged.poolPreference = draft.poolPreference;
  return merged;
}

type AddDestination = (onCreated: (id: string) => void) => void;
type RegistrationRequest = { id: number; accountHandle?: string; name?: string; destinationId?: string; workflowId?: string };
export type XUnifiedRow = { key: string; item: XMonitor; node: ReactNode; filterState: "active" | "attention" | "paused"; searchText: string };
type UnifiedListRenderer = (rows: XUnifiedRow[], status: { loading: boolean; failed: boolean; reload: () => Promise<void> }) => ReactNode;
function XMonitorEditor({ api, setupApi, active, allowSetup, subscriptionsVersion, destinations, rules, onAddDestination, onOpenWorkflow, compact, registrationRequest, hideAddAction, unified, renderUnifiedList, suppressReadErrors, listFilter }: { api: XMonitorAPI; setupApi: XMonitorAPI; active: boolean; allowSetup: boolean; subscriptionsVersion: number; destinations: Choice[]; rules: Choice[]; onAddDestination?: AddDestination; onOpenWorkflow?: (id: string) => void; compact: boolean; registrationRequest?: RegistrationRequest; hideAddAction: boolean; unified: boolean; renderUnifiedList?: UnifiedListRenderer; suppressReadErrors: boolean; listFilter: "all" | "x" | "other" }) {
  const [items, setItems] = useState<XMonitor[]>([]), [quota, setQuota] = useState<XMonitorQuota | null>(null);
  const [setup, setSetup] = useState<XSetupStatus | null>(null), [setupError, setSetupError] = useState("");
  const [rejectedSubscriptionId, setRejectedSubscriptionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [readError, setReadError] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null), [editingId, setEditingId] = useState<string | null>(null), [review, setReview] = useState<number | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  const [editingBaseline, setEditingBaseline] = useState<XMonitor | null>(null), [revisionConflict, setRevisionConflict] = useState(false), [rebasedReview, setRebasedReview] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false), [setupOpen, setSetupOpen] = useState(false);
  const [registrationStep, setRegistrationStep] = useState<"connection" | "account" | "delivery">("connection");
  const registrationHeading = useRef<HTMLHeadingElement>(null);
  const [setupBusy, setSetupBusy] = useState(false), setupDirty = useRef(false), setupBusyRef = useRef(false);
  const onSetupDirtyChange = useCallback((value: boolean) => { setupDirty.current = value; }, []);
  const onSetupBusyChange = useCallback((value: boolean) => { setupBusyRef.current = value; setSetupBusy(value); }, []);
  const closeSetup = () => {
    if (setupBusyRef.current) return false;
    if (setupDirty.current && !confirm("選択したファイルと同意を取り消します。続けますか？")) return false;
    setupDirty.current = false; setSetupOpen(false); return true;
  };
  const [profileCopyMessage, setProfileCopyMessage] = useState("");
  const [reviewedRule, setReviewedRule] = useState<any>(null);
  const mounted = useRef(false), activeRef = useRef(active), epoch = useRef(0), action = useRef(false);
  const manualReload = useRef<{ context: object; version: number; promise: Promise<void> } | null>(null);
  const inFlightLoads = useRef(new Map<Promise<boolean | undefined>, object>());
  // Receiver refreshes invalidate reads, while a write belongs to its API and
  // active editor context. A background read cannot cancel a committed write.
  const mutationEpoch = useRef(0), context = useRef({ api, setupApi, active, allowSetup });
  if (context.current.api !== api || context.current.setupApi !== setupApi || context.current.active !== active || context.current.allowSetup !== allowSetup) {
    context.current = { api, setupApi, active, allowSetup }; mutationEpoch.current++; epoch.current++;
  }
  const renderContext = context.current;
  const draftRef = useRef(draft); draftRef.current = draft;
  const consumedRequest = useRef(0), draftForm = useRef<HTMLFormElement>(null), draftFocusPending = useRef(false);
  const receiverSelect = useRef<HTMLSelectElement>(null), prepareConnection = useRef<HTMLButtonElement>(null), privateSetupLink = useRef<HTMLAnchorElement>(null), accountInput = useRef<HTMLInputElement>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const chosenSubscriptions = useRef(new Map<string, XSetupSubscription>()), consumedConnection = useRef(false);
  const connectionLookup = useRef<{ target: string; seen: Set<string> }>({ target: "", seen: new Set() });
  const [connectionLookupError, setConnectionLookupError] = useState(""), [connectionLookupLoading, setConnectionLookupLoading] = useState(false);
  const reviewProcessingCost = useRef<number | null>(null), [processingQuoteStale, setProcessingQuoteStale] = useState(false);
  activeRef.current = active;
  useAnonymousPageTiming("x_monitors", active, loading, Boolean(readError || setupError));
  const liveCurrent = items.find(item => item.id === editingId);
  const current = editingBaseline?.id === editingId ? editingBaseline : undefined;
  const guidedRegistration = unified && !current;
  const editConflict = revisionConflict || Boolean(current && liveCurrent && current.revision !== liveCurrent.revision);
  const rolloutPermits = !allowSetup || Boolean(setup?.rollout.eligible && setup.rollout.mode !== "disabled");
  const canRegister = Boolean(rolloutPermits && quota?.featureEnabled && quota.personal.available > 0 && quota.x.available > 0
    && !["X_MONITOR_UNAVAILABLE", "X_MONITOR_PERSONAL_LIMIT", "X_MONITOR_POOL_FULL", "X_ROLLOUT_DISABLED", "X_ROLLOUT_SUPPORTERS_ONLY"].includes(quota.x.reasonCode ?? ""));
  const registrationProblem = loading ? "利用資格と利用枠を確認中です。"
    : !rolloutPermits && !setup ? "利用資格を確認できません。画面を更新してからお試しください。"
      : !rolloutPermits ? setup?.rollout.reasonCode ? xReason(setup.rollout.reasonCode)
        : setup?.rollout.mode === "disabled" ? xReason("X_ROLLOUT_DISABLED")
          : setup?.rollout.mode === "supporters" ? xReason("X_ROLLOUT_SUPPORTERS_ONLY") : "利用資格を確認できません。画面を更新してからお試しください。"
        : !quota ? "利用枠を確認できません。画面を更新してからお試しください。"
        : quota.x.reasonCode && ["X_MONITOR_UNAVAILABLE", "X_MONITOR_PERSONAL_LIMIT", "X_MONITOR_POOL_FULL", "X_ROLLOUT_DISABLED", "X_ROLLOUT_SUPPORTERS_ONLY"].includes(quota.x.reasonCode) ? xReason(quota.x.reasonCode)
          : !quota.featureEnabled ? xReason("X_MONITOR_UNAVAILABLE")
            : quota.personal.available <= 0 ? xReason("X_MONITOR_PERSONAL_LIMIT")
              : quota.x.available <= 0 ? xReason("X_MONITOR_POOL_FULL") : "";
  const canResume = (item: XMonitor) => Boolean(rolloutPermits && quota?.featureEnabled && quota.personal.used <= quota.personal.totalLimit
    && (item.poolKind !== null || quota.pools.free.available > 0 || quota.x.specialLimit > quota.x.specialUsed
      || quota.personal.supporterExtraSlots > 0 && quota.pools.supporter.available > 0) && !["X_MONITOR_UNAVAILABLE", "X_ROLLOUT_DISABLED", "X_ROLLOUT_SUPPORTERS_ONLY"].includes(quota.x.reasonCode ?? ""));
  const performLoad = useCallback(async () => {
    if (!activeRef.current || !mounted.current) return;
    const version = ++epoch.current; setLoading(true); setReadError("");
    // The list includes the quota in the same response. In the unified view,
    // avoid a second reconciliation unless that response is unavailable or
    // cannot provide a valid quota. The standalone view retains its contract.
    const results = await Promise.allSettled([unified ? Promise.resolve(null) : api("x-monitor-quota"), api("x-monitors"), allowSetup ? setupApi("x-setup") : Promise.resolve(null)]);
    if (!mounted.current || !activeRef.current || version !== epoch.current) return;
    let nextQuota: XMonitorQuota | null = null, listLoaded = false;
    try { if (results[0].status === "fulfilled") nextQuota = parseXQuota(results[0].value); } catch { /* Use a valid owner-scoped list quota if available. */ }
    try {
      if (results[1].status !== "fulfilled") throw new Error("Unavailable X list");
      const list = xObject(results[1].value);
      if (!Array.isArray(list.items)) throw new Error("Invalid X list");
      setItems(list.items.map(parseXMonitor));
      listLoaded = true;
      if (nextQuota === null && list.quota) {
        try { nextQuota = parseXQuota(list.quota); } catch { /* Try the independent quota response when needed. */ }
      }
    } catch { setReadError("X監視の一覧をもう一度読み込んでください。入力内容はそのまま残っています。"); }
    if (unified && nextQuota === null) {
      try {
        const fallback = await api("x-monitor-quota");
        if (!mounted.current || !activeRef.current || version !== epoch.current) return;
        nextQuota = parseXQuota(fallback);
      } catch { /* Retain the list error or show the quota error below. */ }
      if (!mounted.current || !activeRef.current || version !== epoch.current) return;
    }
    if (allowSetup) {
      try {
        if (results[2].status !== "fulfilled") throw new Error("Unavailable setup metadata");
        const metadata = parseXSetupStatus(results[2].value);
        setSetup({ ...metadata, subscriptions: [...metadata.subscriptions, ...[...chosenSubscriptions.current.values()].filter(item => !metadata.subscriptions.some(row => row.id === item.id))] });
        setRejectedSubscriptionId(previous => previous && metadata.subscriptions.some(item => item.id === previous && item.receiverState !== "requires_reenrollment") ? null : previous);
        setSetupError("");
      }
      catch { setSetup(null); setSetupError("受信情報の候補をもう一度読み込んでください。「X一覧・利用枠を更新」から再試行できます。"); }
    } else { setSetup(null); setSetupError(""); }
    setQuota(nextQuota); if (listLoaded || nextQuota?.registrationProcessing) setProcessingQuoteStale(false);
    if (nextQuota === null) setReadError(previous => previous || "現在のプランと利用枠を読み直してください。取得済みの監視は停止・削除できます。追加・再開は、利用枠を確認してから行えます。");
    setLoading(false);
    return listLoaded;
  }, [api, setupApi, allowSetup, unified]);
  const load = useCallback(() => {
    const pending = performLoad();
    inFlightLoads.current.set(pending, context.current);
    void pending.then(() => inFlightLoads.current.delete(pending), () => inFlightLoads.current.delete(pending));
    return pending;
  }, [performLoad]);
  const reload = useCallback((): Promise<void> => {
    if (!mounted.current || !activeRef.current || action.current) return Promise.resolve();
    const requestedContext = context.current, requestedVersion = mutationEpoch.current;
    if (manualReload.current?.context === requestedContext && manualReload.current.version === requestedVersion) return manualReload.current.promise;
    const pending = (async () => {
      while (true) {
        const currentLoads = [...inFlightLoads.current].filter(([, loadContext]) => loadContext === requestedContext).map(([loadPromise]) => loadPromise);
        if (!currentLoads.length) break;
        await Promise.allSettled(currentLoads);
        if (!mounted.current || !activeRef.current || action.current || context.current !== requestedContext || mutationEpoch.current !== requestedVersion) return;
      }
      if (!mounted.current || !activeRef.current || action.current || context.current !== requestedContext || mutationEpoch.current !== requestedVersion) return;
      await load();
    })();
    const request = { context: requestedContext, version: requestedVersion, promise: pending };
    manualReload.current = request;
    return pending.finally(() => { if (manualReload.current === request) manualReload.current = null; });
  }, [load]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; mutationEpoch.current++; }; }, []);
  useEffect(() => { if (active) void load(); return () => { epoch.current++; }; }, [load, active, subscriptionsVersion]);
  useEffect(() => {
    if (!active || loading || !setup || draft || draftRef.current || consumedConnection.current) { setConnectionLookupLoading(false); return; }
    const selectedId = new URLSearchParams(window.location.search).get("xSubscriptionId");
    if (!selectedId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(selectedId)) { setConnectionLookupLoading(false); return; }
    if (connectionLookup.current.target !== selectedId) { connectionLookup.current = { target: selectedId, seen: new Set() }; setConnectionLookupError(""); }
    if (setup.subscriptions.some(item => item.id === selectedId)) {
      const existing = items.find(item => item.notificationSettings.subscriptionId === selectedId && item.state !== "deleted");
      consumedConnection.current = true; setConnectionLookupLoading(false); setConnectionLookupError(""); setRegistrationStep("connection"); setEditingId(existing?.id ?? null); setEditingBaseline(existing ?? null); setRevisionConflict(false); setRebasedReview(false); setDraft({ ...draftOf(existing), subscriptionId: selectedId }); setEditorOpen(true); draftFocusPending.current = true; return;
    }
    if (connectionLookupError) return;
    const cursor = setup.nextCursor;
    if (!cursor) { setConnectionLookupLoading(false); setConnectionLookupError("選んだ接続を確認できませんでした。接続一覧を更新してください。"); return; }
    if (connectionLookup.current.seen.has(cursor)) { setConnectionLookupLoading(false); setConnectionLookupError("接続一覧を読み込めませんでした。もう一度更新してください。"); return; }
    let cancelled = false; const requestedContext = context.current, requestedEpoch = epoch.current, requestedRegistration = consumedRequest.current;
    setConnectionLookupLoading(true);
    void (async () => {
      try {
        const next = parseXSetupStatus(await setupApi(`x-setup?afterId=${encodeURIComponent(cursor)}`));
        if (cancelled || !mounted.current || !activeRef.current || context.current !== requestedContext || epoch.current !== requestedEpoch || consumedRequest.current !== requestedRegistration || draftRef.current) return;
        if (next.nextCursor && (next.nextCursor === cursor || connectionLookup.current.seen.has(next.nextCursor))) throw new Error("Invalid receiver cursor");
        connectionLookup.current.seen.add(cursor);
        setSetup(previous => previous && previous.nextCursor === cursor ? { ...next, subscriptions: [...previous.subscriptions, ...next.subscriptions.filter(row => !previous.subscriptions.some(item => item.id === row.id))] } : previous);
      } catch {
        if (!cancelled && mounted.current && activeRef.current && context.current === requestedContext && epoch.current === requestedEpoch && consumedRequest.current === requestedRegistration && !draftRef.current)
          setConnectionLookupError("接続一覧を読み込めませんでした。もう一度更新してください。");
      } finally { if (!cancelled && mounted.current) setConnectionLookupLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [active, loading, setup, items, draft, setupApi, connectionLookupError, registrationRequest]);
  useEffect(() => {
    if (!active || !registrationRequest || !Number.isSafeInteger(registrationRequest.id) || registrationRequest.id <= consumedRequest.current) return;
    consumedRequest.current = registrationRequest.id;
    draftFocusPending.current = true; setFocusRevision(value => value + 1); setEditorOpen(true);
    const previous = draftRef.current;
    const incoming = { ...draftOf(), accountHandle: registrationRequest.accountHandle?.replace(/^@/u, "") ?? "", name: registrationRequest.name ?? "", destinationId: registrationRequest.destinationId ?? "", workflowId: registrationRequest.workflowId ?? "" };
    if (previous) {
      const hasIncomingTarget = Boolean(registrationRequest.accountHandle);
      const differs = hasIncomingTarget && (["accountHandle", "name", "destinationId", "workflowId"] as const).some(key => previous[key] !== incoming[key]);
      if (!differs) return;
      if (!confirm("編集中のX通知の入力を破棄して、新しい入力に切り替えますか？")) {
        setNotice("編集中のX通知を表示しています。新しい入力は引き継がれていません。"); return;
      }
    }
    setRegistrationStep("connection"); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); setReview(null);
    setNotice(""); setDraft(incoming);
  }, [active, registrationRequest]);
  useEffect(() => {
    if (!active && editorOpen && draftRef.current) draftFocusPending.current = true;
  }, [active, editorOpen]);
  useEffect(() => {
    if (!active || !editorOpen || setupOpen || !draft || loading || !draftFocusPending.current) return;
    const target = guidedRegistration && registrationStep !== "connection" ? registrationHeading.current : current ? accountInput.current
      : !allowSetup ? privateSetupLink.current
        : setup?.subscriptions.length && receiverSelect.current && !receiverSelect.current.disabled ? receiverSelect.current : prepareConnection.current;
    const focus = target ?? accountInput.current;
    if (!focus) return;
    draftFocusPending.current = false; focus.focus({ preventScroll: true }); const dialog = draftForm.current?.closest("dialog"); if (dialog) dialog.scrollTop = 0;
  }, [active, draft, loading, setup, editorOpen, setupOpen, allowSetup, current, focusRevision, guidedRegistration, registrationStep]);
  function goToRegistrationStep(step: "connection" | "account" | "delivery") {
    setReview(null); setRegistrationStep(step);
    requestAnimationFrame(() => { registrationHeading.current?.focus({ preventScroll: true }); registrationHeading.current?.scrollIntoView?.({ block: "start" }); });
  }
  useEffect(() => {
    if (!guidedRegistration || !active || !editorOpen || review === null) return;
    const frame = requestAnimationFrame(() => { registrationHeading.current?.focus({ preventScroll: true }); registrationHeading.current?.scrollIntoView?.({ block: "start" }); });
    return () => cancelAnimationFrame(frame);
  }, [guidedRegistration, active, editorOpen, review]);
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { if (!action.current) { if (key === "subscriptionId" && value !== draftRef.current?.subscriptionId) setRejectedSubscriptionId(null); setDraft(previous => previous ? { ...previous, [key]: value, ...((key === "accountHandle" && value !== previous.accountHandle || key === "subscriptionId" && value !== previous.subscriptionId) ? { browserAcknowledgedHandle: null } : {}) } : previous); if (key === "accountHandle") setProfileCopyMessage(""); setReview(null); setNotice(""); } }
  async function mutate(work: () => Promise<void>) {
    if (action.current || !activeRef.current) return;
    action.current = true; const version = ++mutationEpoch.current; epoch.current++; setLoading(false); setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (cause) { if (mounted.current && activeRef.current && version === mutationEpoch.current) { if (cause && typeof cause === "object" && "code" in cause && cause.code === "X_MONITOR_RECEIVER_REENROLL_REQUIRED") setRejectedSubscriptionId(draftRef.current?.subscriptionId || null); setReview(null); setError(xFeedback(cause)); } }
    finally { action.current = false; if (mounted.current) setBusy(false); }
  }
  const selectedReceiver = setup?.subscriptions.find(item => item.id === draft?.subscriptionId);
  const receiverNeedsReenrollment = selectedReceiver?.receiverState === "requires_reenrollment" || Boolean(draft?.subscriptionId && rejectedSubscriptionId === draft.subscriptionId);
  const validSubscription = !draft?.subscriptionId || draft.subscriptionId === current?.notificationSettings.subscriptionId
    || Boolean(setup?.available && selectedReceiver && !receiverNeedsReenrollment);
  const selectedBrowser = selectedReceiver?.browserKind;
  const requiresHandle = !current || current.accountId === null;
  const validHandle = Boolean(draft && /^[A-Za-z0-9_]{1,15}$/u.test(draft.accountHandle) && !["i", "intent"].includes(draft.accountHandle.toLowerCase()));
  const valid = Boolean(draft && validSubscription && (validHandle || !requiresHandle && !draft.accountHandle) && draft.name.length <= 120 && (!current || draft.name.trim().length > 0)
    && (current || draft.browserAcknowledgedHandle === draft.accountHandle));
  const resumes = Boolean(current && draft?.enabled && !current.enabled);
  const supporterQuote = current ? (liveCurrent ?? current).supporterRealtimeProcessing : quota?.supporterRealtimeRegistration;
  // Keep an explicitly selected pool when capacity or eligibility changes. A
  // refresh must never silently replace the one-slot choice with five slots.
  const supporterOffer = Boolean(supporterQuote?.eligible && supporterQuote.available && supporterQuote.canEnableRealtime && supporterQuote.realtimeSlotCost === 1);
  const registrationQuote = draft?.poolPreference === "supporter" ? supporterQuote : (liveCurrent ?? current)?.processing ?? (draft?.processingMode === "batch" && supporterOffer ? supporterQuote : quota?.registrationProcessing);
  const selectedSupporterAvailable = draft?.poolPreference !== "supporter" || Boolean(supporterQuote?.eligible && supporterQuote.available);
  const realtimeQuoteReady = Boolean(registrationQuote && selectedSupporterAvailable);
  function chooseTiming(mode: XProcessingMode) {
    if (action.current) return;
    setDraft(previous => previous ? { ...previous, processingMode: mode, processingTouched: true, poolPreference: !current && mode === "realtime" && supporterOffer ? "supporter" : "auto" } : previous);
    setReview(null); setNotice("");
  }
  const newRealtime = Boolean(draft?.processingMode === "realtime" && (!current || draft.processingTouched));
  const realtimePriceConfirmed = !newRealtime || Boolean(realtimeQuoteReady && registrationQuote && reviewProcessingCost.current === registrationQuote.realtimeSlotCost);
  const timingChanged = Boolean(current && draft?.processingTouched);
  const deliveryChanged = Boolean(current && draft && (draft.accountHandle !== (current.accountHandle ?? "") || draft.destinationId !== (current.notificationSettings.destinationId ?? "") || draft.workflowId !== (current.notificationSettings.workflowId ?? "") || draft.subscriptionId !== (current.notificationSettings.subscriptionId ?? "") || draft.enabled !== current.enabled || timingChanged));
  const needsConfirmation = rebasedReview || !current || deliveryChanged || Boolean(draft?.poolPreference === "supporter" && current.poolKind !== "supporter");
  const canReview = valid && !busy && !loading && active && !editConflict && (!newRealtime || Boolean(registrationQuote?.canEnableRealtime && selectedSupporterAvailable && !processingQuoteStale)) && (!timingChanged || Boolean(registrationQuote && !processingQuoteStale)) && (editingId ? Boolean(current) && (!resumes || Boolean(current && canResume(current))) : canRegister);
  async function reloadDraft() {
    const before = current, requested = draft;
    if (!before || !requested) return;
    await mutate(async () => {
      const version = mutationEpoch.current, response = xObject(await api("x-monitors"));
      if (!Array.isArray(response.items)) throw new Error("Invalid X list");
      const latestItems = response.items.map(parseXMonitor), latest = latestItems.find(item => item.id === before.id && item.state !== "deleted");
      if (!mounted.current || !activeRef.current || version !== mutationEpoch.current || draftRef.current !== requested) return;
      if (!latest) throw { code: "NOT_FOUND", status: 404 };
      epoch.current++; setLoading(false);
      setItems(latestItems); setEditingBaseline(latest); setDraft(rebaseDraft(before, requested, latest));
      setRevisionConflict(false); setRebasedReview(true); setProcessingQuoteStale(false); setReview(null);
      setNotice("最新の通知設定を取得しました。変更した入力を引き継いでいます。内容を確認して保存してください。");
    });
  }
  async function save(confirmedRevision = review) {
    const confirmedCost = !newRealtime || Boolean(realtimeQuoteReady && registrationQuote && reviewProcessingCost.current === registrationQuote.realtimeSlotCost);
    if (!draft || !canReview || confirmedRevision === null || confirmedRevision !== (current?.revision ?? 0) || !confirmedCost) return;
    const settings = { ...(draft.destinationId ? { destinationId: draft.destinationId } : {}), ...(draft.workflowId ? { workflowId: draft.workflowId } : {}), ...(draft.subscriptionId ? { subscriptionId: draft.subscriptionId } : {}) };
    const body = current ? { expectedRevision: current.revision, name: draft.name.trim(),
      ...(draft.accountHandle !== (current.accountHandle ?? "") ? { accountHandle: draft.accountHandle || null } : {}),
      ...(draft.enabled !== current.enabled ? { enabled: draft.enabled } : {}),
      ...(timingChanged ? { processingMode: draft.processingMode, ...(draft.processingMode === "realtime" && registrationQuote ? { expectedRealtimeSlotCost: registrationQuote.realtimeSlotCost } : {}) } : {}),
      ...(draft.poolPreference === "supporter" && current.poolKind !== "supporter" ? { poolKind: "supporter" } : {}),
      ...(settings.workflowId !== current.notificationSettings.workflowId || settings.destinationId !== current.notificationSettings.destinationId || settings.subscriptionId !== current.notificationSettings.subscriptionId ? { notificationSettings: settings } : {}) }
      : { accountHandle: draft.accountHandle, ...(draft.name.trim() ? { name: draft.name.trim() } : {}), ...(Object.keys(settings).length ? { notificationSettings: settings } : {}),
        ...(registrationQuote ? { processingMode: draft.processingMode, ...(draft.processingMode === "realtime" ? { expectedRealtimeSlotCost: registrationQuote.realtimeSlotCost,
          ...(draft.poolPreference === "supporter" ? { poolPreference: "supporter" } : {}) } : {}) } : {}) };
    await mutate(async () => {
      const version = mutationEpoch.current;
      let rawResponse;
      try { rawResponse = await api(current ? `x-monitors/${encodeURIComponent(current.id)}` : "x-monitors", current ? "PATCH" : "POST", body); }
      catch (cause) {
        if (!mounted.current || !activeRef.current || version !== mutationEpoch.current) return;
        const failure = cause && typeof cause === "object" ? cause as { code?: string; status?: number } : {};
        if (newRealtime || failure.code === "X_REALTIME_COST_CONFLICT") setProcessingQuoteStale(true);
        if (current && (["REVISION_CONFLICT", "X_MONITOR_REVISION_CONFLICT"].includes(failure.code ?? "") || failure.status === 409 && !failure.code)) setRevisionConflict(true);
        throw cause;
      }
      const response = xObject(rawResponse);
      const saved = parseXMonitor(response.item ?? response);
      if (!mounted.current || !activeRef.current || version !== mutationEpoch.current) return;
      epoch.current++; setLoading(false);
      setItems(previous => [...previous.filter(item => item.id !== saved.id), saved]); setDraft(null); setRegistrationStep("connection"); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); setReview(null); setEditorOpen(false);
      setNotice(saved.notificationSettings.subscriptionId ? "X監視の設定を保存しました。" : "X監視の設定を保存しました。接続設定から受信情報を選んでください。"); await load();
    });
  }
  async function toggle(item: XMonitor) {
    if (item.enabled || canResume(item)) await mutate(async () => {
      const version = mutationEpoch.current;
      const response = xObject(await api(`x-monitors/${encodeURIComponent(item.id)}`, "PATCH", { expectedRevision: item.revision, enabled: !item.enabled }));
      const saved = parseXMonitor(response.item ?? response);
      if (!mounted.current || !activeRef.current || version !== mutationEpoch.current) return;
      epoch.current++; setLoading(false);
      setItems(previous => previous.map(row => row.id === saved.id ? saved : row)); setNotice(item.enabled ? "X監視を停止しました。" : "X監視を再開しました。"); await load();
    });
  }
  return <div className="nx-monitor-panel">
    {!unified || active ? <>
    {!unified && setup?.rollout.mode === "supporters" ? <p role="status" className="nx-state-line"><ShieldCheck size={16} aria-hidden="true" /><span>支援者向けベータ版{setup.rollout.eligible ? "・利用できます" : "・受付対象の拡大待ち"}</span></p> : null}
    {!unified && setup?.rollout.mode === "disabled" && quota?.x.reasonCode !== "X_ROLLOUT_DISABLED" ? <p role="status" className="text-sm">{xReason("X_ROLLOUT_DISABLED")}</p> : null}
    {!unified && compact ? <div className="nx-status-grid"><section aria-label="Xの接続状況" className="nx-compact-status"><header><Radio size={17} aria-hidden="true" /><h3>Xとの接続</h3></header><strong>{!allowSetup ? "個人ページで設定" : !setup ? "接続状況を確認中" : !setup.subscriptions.length && !setup.nextCursor ? "受信情報を登録しましょう" : setup.subscriptions.some(item => item.receiverState === "listening") ? "サーバー接続を確認済み" : setup.nextCursor ? "続きの受信情報を確認" : "接続の準備・確認中"}</strong>{setup?.subscriptions.some(item => item.receiverState === "requires_reenrollment") ? <p>受信情報を登録し直してください。</p> : null}<a className="nx-text-link" href="/dashboard/automation/x">接続を確認<ArrowRight size={14} aria-hidden="true" /></a></section><section aria-label="X通知のタイミング" className="nx-compact-status"><header><Clock3 size={17} aria-hidden="true" /><h3>通知方法</h3></header>{!loading && !readError && items.every(item => item.processing) ? <div className="nx-monitor-timing-status"><span className="nx-timing-chip"><Zap size={14} aria-hidden="true" />リアルタイム {items.filter(item => item.processing?.effectiveMode === "realtime").length}件</span><span className="nx-timing-chip"><Clock3 size={14} aria-hidden="true" />プランの間隔 {items.filter(item => item.processing?.effectiveMode === "batch").length}件</span></div> : <strong>{loading ? "確認中…" : "通知方法の確認待ち"}</strong>}</section></div> : null}
    {!unified && quota && compact ? <section aria-label="X監視の個人利用枠" className="nx-quota-card"><dl className="nx-quota-summary"><div><dt>基本枠</dt><dd>{quota.currentPlan.baseSlotLimit}枠</dd></div><div><dt>支援による追加</dt><dd>{quota.personal.supporterExtraSlots}枠</dd></div><div><dt>使用中</dt><dd>{quota.personal.used}／{quota.personal.totalLimit}枠</dd></div><div><dt>残り</dt><dd>{quota.personal.available}枠</dd></div><div><dt>1枠で追加できるX監視</dt><dd>{quota.x.available}件</dd></div><div><dt>現在のプラン</dt><dd>{quota.currentPlan.label}</dd></div></dl><a href="/dashboard/automation/plans" className="nx-text-link"><Users size={15} aria-hidden="true" />プランと利用枠を確認<ArrowRight size={14} aria-hidden="true" /></a>
      {!quota.featureEnabled && !quota.x.reasonCode?.startsWith("X_ROLLOUT_") ? <p role="status">{xReason("X_MONITOR_UNAVAILABLE")}</p> : null}{quota.x.reasonCode && (quota.featureEnabled || quota.x.reasonCode !== "X_MONITOR_UNAVAILABLE") ? <p role="status">{xReason(quota.x.reasonCode)}</p> : null}</section> : null}
    {!unified && quota && !compact ? <details aria-label="X監視の個人利用枠" className="space-y-2 rounded border bg-muted/30 p-4 text-sm"><summary>利用状況 {quota.personal.used}／{quota.personal.totalLimit}枠</summary>
      <p className="font-medium">現在のプラン: {quota.currentPlan.label}</p>
      <dl className="grid gap-2 sm:grid-cols-2"><div><dt>基本枠</dt><dd>{quota.currentPlan.baseSlotLimit}枠</dd></div><div><dt>支援による追加</dt><dd>{quota.personal.supporterExtraSlots}枠</dd></div>
        <div><dt>使用中</dt><dd>{quota.personal.used}／{quota.personal.totalLimit}枠</dd></div><div><dt>残り</dt><dd>{quota.personal.available}枠</dd></div>
        <div><dt>登録している通知</dt><dd>{quota.personal.registeredCount === null ? "件数未取得" : `${quota.personal.registeredCount}件`}</dd></div>
        <div><dt>1枠で追加できるX監視</dt><dd>{quota.x.available}件</dd></div><div><dt>無料共有枠の全体空き</dt><dd>{quota.pools.free.available}／{quota.pools.free.limit}枠</dd></div>
        <div><dt>現在プランの確認間隔</dt><dd>{xInterval(quota.currentPlan.intervalMinutes)}</dd></div></dl>
      <p className="text-xs text-muted-foreground">通常通知とX監視は同じ枠を使います。停止中の通知と、確認間隔の短縮に使う追加枠も含みます。支援による追加枠は月額プランの解約後も引き継ぎます。</p>
      <p className="text-xs text-muted-foreground">標準の設定では、受信を開始すると通知を随時受け取り、現在のプランの間隔ごとに、届いた分をまとめて処理します。リアルタイムを選択して保存すると、受け取り次第処理します。通知先への送信には、ルールの条件と送信上限を適用します。</p>
      <p className="text-xs text-muted-foreground">確認間隔と送信上限には、現在の契約プランを適用します。どの種類の枠でも、1分{quota.currentPlan.minuteLimit}通・1日{quota.currentPlan.dayLimit}通までです。</p>
      {!quota.featureEnabled && !quota.x.reasonCode?.startsWith("X_ROLLOUT_") ? <p role="status">{xReason("X_MONITOR_UNAVAILABLE")}</p> : null}
      {quota.x.reasonCode && (quota.featureEnabled || quota.x.reasonCode !== "X_MONITOR_UNAVAILABLE") ? <p role="status">{xReason(quota.x.reasonCode)}</p> : null}
    </details> : null}
    {unified && quota?.x.reasonCode && (listFilter === "x" || listFilter === "all" && items.length > 0) ? <p role="status" className="text-sm">{xReason(quota.x.reasonCode)}</p> : null}
    {connectionLookupLoading ? <p role="status" className="text-sm">接続を確認しています…</p> : null}
    {connectionLookupError ? <p role="alert" className="text-sm text-destructive">{connectionLookupError} <button type="button" className={button} disabled={!active || busy || loading} onClick={() => { connectionLookup.current.seen.clear(); setConnectionLookupError(""); void reload(); }}>接続を再確認</button></p> : null}
    {readError && !(unified && suppressReadErrors) ? <p role="alert" className="text-sm text-destructive">{readError}</p> : null}{setupError && !(unified && suppressReadErrors) ? <p role="alert" className="text-sm text-destructive">{unified ? "受信情報を取得できませんでした。［更新］で再確認してください。" : setupError}</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
    {!unified ? <div className="flex flex-wrap gap-2">{!hideAddAction ? <button className="nx-primary" disabled={!active || busy || loading || !canRegister} onClick={() => { draftFocusPending.current = true; setEditorOpen(true); if (!draft) { setDraft(draftOf()); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); } }}>X監視を追加</button> : null}
      <button className={button} disabled={!active || busy || loading} onClick={() => { setReview(null); void load(); }}>X一覧・利用枠を更新</button></div>
      : null}
    {draft && !editorOpen ? <div className="nx-actions"><button className={button} onClick={() => { draftFocusPending.current = true; setEditorOpen(true); }}>編集中の設定を開く</button><details className="nx-field-note"><summary>入力を破棄</summary><button className={button} onClick={() => { setDraft(null); setRegistrationStep("connection"); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); setReview(null); setError(""); setProcessingQuoteStale(false); }}>この下書きを破棄</button></details></div> : null}
    {loading ? <p role="status" className="text-sm">X監視を読み込み中…</p> : null}
    {draft && editorOpen ? <AutomationDialog title={current ? "通知設定" : "Xアカウントを登録"} cancelLabel="あとで続ける" open={active} busy={busy || setupBusy} preserveInitialScroll onCancel={() => { if (setupOpen && !closeSetup()) return; setEditorOpen(false); }} error={error || undefined}>
      {unified && !current && !canRegister && registrationProblem ? <p role="status" className="nx-inline-note">{registrationProblem}</p> : null}
      {receiverNeedsReenrollment ? <div role="status" className="nx-inline-note"><span>この接続は受信情報を登録し直してください。</span>{allowSetup ? <button type="button" className={button} disabled={busy || setupBusy || !active} onClick={() => setSetupOpen(true)}>受信情報を登録し直す</button> : <a href="/dashboard/automation/x" className="nx-text-link">受信情報を登録し直す</a>}</div> : null}
      <form ref={draftForm} aria-label="X監視の登録設定" className="nx-unified-form" noValidate
        onPointerDownCapture={() => { if (loading) draftFocusPending.current = false; }}
        onKeyDownCapture={() => { if (loading) draftFocusPending.current = false; }}
        onSubmit={event => {
        event.preventDefault(); if (!canReview || guidedRegistration && registrationStep !== "delivery") return;
        reviewProcessingCost.current = newRealtime ? registrationQuote?.realtimeSlotCost ?? null : null;
        if (needsConfirmation) void mutate(async () => {
          const request = mutationEpoch.current, requested = draft;
          let selectedRule: any = null;
          if (draft.workflowId) { try { const found = await api(`workflows/${encodeURIComponent(draft.workflowId)}`); selectedRule = found && typeof found === "object" && "id" in found && found.id === draft.workflowId ? found : { id: draft.workflowId }; } catch { selectedRule = { id: draft.workflowId }; } }
          if (!mounted.current || !activeRef.current || request !== mutationEpoch.current || draftRef.current !== requested) return;
          setReviewedRule(selectedRule); setReview(current?.revision ?? 0);
        }); else void save(current?.revision ?? 0);
      }}>
      {!current ? <ol aria-label="X監視の登録手順" className="nx-registration-steps"><li aria-current={guidedRegistration && registrationStep === "connection" ? "step" : undefined}>接続</li><li aria-current={guidedRegistration && registrationStep === "account" ? "step" : undefined}>アカウント</li><li aria-current={guidedRegistration && registrationStep === "delivery" && review === null ? "step" : undefined}>通知先とタイミング</li><li aria-current={guidedRegistration && review !== null ? "step" : undefined}>確認して登録</li></ol> : null}
      {guidedRegistration ? <h3 ref={registrationHeading} tabIndex={-1} className="nx-stage-focus">{registrationStep === "connection" ? "使う接続を選択" : registrationStep === "account" ? "通知したいアカウント" : review === null ? "通知先とタイミング" : "登録内容を確認"}</h3> : null}
      <div hidden={guidedRegistration && registrationStep !== "connection"}>
      {!current && (!allowSetup || !setup?.subscriptions.length) ? <section aria-label="Xの接続準備" className="nx-editor-section">{!guidedRegistration ? <h3>接続を準備</h3> : null}{!allowSetup ? <a ref={privateSetupLink} href="/dashboard/automation/x" className="nx-text-link">個人ページで接続を準備</a> : <button ref={prepareConnection} type="button" className={button} disabled={busy || !active} onClick={() => setSetupOpen(true)}>接続を準備する</button>}</section> : null}
      {allowSetup ? <fieldset disabled={busy || !active} className="nx-editor-section"><legend className={guidedRegistration ? "sr-only" : undefined}>{current ? "接続設定" : "使う接続を選択"}</legend>
        <label className="text-sm">使用する自分の受信情報<select ref={receiverSelect} className={field} disabled={!setup?.available || loading} value={draft.subscriptionId} onChange={event => update("subscriptionId", event.target.value)}><option value="">受信情報を選択</option>{draft.subscriptionId && !setup?.subscriptions.some(item => item.id === draft.subscriptionId) ? <option value={draft.subscriptionId} disabled>現在の受信情報（一覧を確認）</option> : null}{setup?.subscriptions.map((item, index) => <option key={item.id} value={item.id} disabled={item.receiverState === "requires_reenrollment" && item.id !== current?.notificationSettings.subscriptionId}>受信情報 {index + 1} · {item.browserKind === "brave" ? "Brave" : item.browserKind === "chrome" ? "Chrome" : "Firefox"} · {xReceiverLabel(item.receiverState)}</option>)}</select></label>
        {current || setup?.subscriptions.length || setup?.nextCursor ? <button ref={prepareConnection} type="button" className={button} onClick={() => setSetupOpen(true)}>PCの通知データを登録</button> : null}
        {setup?.nextCursor ? <button type="button" className={button} disabled={busy || loading || !active} onClick={() => void mutate(async () => { const next = parseXSetupStatus(await setupApi(`x-setup?afterId=${encodeURIComponent(setup.nextCursor ?? "")}`)); if (mounted.current && activeRef.current) setSetup(previous => previous ? { ...next, subscriptions: [...previous.subscriptions, ...next.subscriptions.filter(item => !previous.subscriptions.some(row => row.id === item.id))] } : next); })}>受信情報の候補をさらに表示</button> : null}
      </fieldset> : null}
      {guidedRegistration ? <div className="nx-actions"><button type="button" className="nx-primary" disabled={busy || loading || !active || !draft.subscriptionId || !validSubscription} onClick={() => goToRegistrationStep("account")}>次へ</button><button type="button" className={button} disabled={busy || loading || !active} onClick={() => { update("subscriptionId", ""); goToRegistrationStep("account"); }}>あとで接続する</button></div> : null}
      </div>
      {editConflict ? <section aria-label="X通知設定の再確認" className="nx-feedback"><p>別の操作で設定が変更されました。変更した入力を保持して、最新の設定と確認できます。</p><button type="button" className={button} disabled={busy || loading || !active} onClick={() => void reloadDraft()}>最新設定を取得して入力を引き継ぐ</button></section> : null}
      {notice ? <p role="status" className="nx-field-note">{notice}</p> : null}
      <div hidden={guidedRegistration && registrationStep !== "account"}>
      <fieldset disabled={busy || !active} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Xアカウント名（@ユーザー名）{requiresHandle ? "・必須" : ""}<input ref={accountInput} className={field} required={requiresHandle} maxLength={16} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="@example" value={draft.accountHandle} onChange={event => update("accountHandle", event.target.value.replace(/^@/u, ""))} /></label>
        <label className="text-sm">監視の表示名（任意）<input className={field} maxLength={120} value={draft.name} onChange={event => update("name", event.target.value)} /></label>
      </fieldset>
      {!current ? <section aria-label="設定用ブラウザーで対象アカウントの通知を設定" className="nx-firefox-target-step">
        <h3>設定用ブラウザーで{validHandle ? ` @${draft.accountHandle} の` : "対象アカウントの"}投稿通知をON</h3>
        <p>設定用ブラウザーで通知を許可し、このアカウントのプロフィールにある投稿通知のベルをオンにしてください。</p>
        {selectedBrowser === "chrome" || selectedBrowser === "brave" ? <p className="nx-field-note">{guidedRegistration ? "通知をオンにしたら、更新した通知データを登録してください。" : "設定後は通知データを保存し、上の「PCの通知データを登録」からもう一度登録してください。"}</p> : null}
        {guidedRegistration && (!draft.subscriptionId || selectedBrowser === "chrome" || selectedBrowser === "brave") ? allowSetup
          ? <button type="button" className={button} disabled={busy || !active} onClick={() => setSetupOpen(true)}>{draft.subscriptionId ? "更新した通知データを登録" : "設定用ブラウザーを準備"}</button>
          : <a href="/dashboard/automation/x" className="nx-text-link">設定用ブラウザーを準備</a> : null}
        <div className="nx-actions"><button type="button" className={button} disabled={!validHandle || busy || !active} onClick={async () => {
          try { await navigator.clipboard.writeText(`https://x.com/${draft.accountHandle}`); if (mounted.current && activeRef.current) setProfileCopyMessage("プロフィールURLをコピーしました。"); }
          catch { if (mounted.current && activeRef.current) setProfileCopyMessage(`設定用ブラウザーで https://x.com/${draft.accountHandle} を開いてください。`); }
        }}>プロフィールURLをコピー</button></div>
        {profileCopyMessage ? <p role="status" className="nx-field-note">{profileCopyMessage}</p> : null}
        <label className="nx-firefox-ack"><input type="checkbox" disabled={!validHandle || busy || !active} checked={draft.browserAcknowledgedHandle === draft.accountHandle} onChange={event => update("browserAcknowledgedHandle", event.target.checked ? draft.accountHandle : null)} /><span>設定用ブラウザーで、このアカウントの投稿通知をONにしました</span></label>
        <small className="nx-field-note">実際の通知は登録後に確認できます。</small>
      </section> : null}
      {guidedRegistration ? <div className="nx-actions"><button type="button" className={button} disabled={busy} onClick={() => goToRegistrationStep("connection")}>戻る</button><button type="button" className="nx-primary" disabled={busy || !active || !validSubscription || !validHandle || draft.browserAcknowledgedHandle !== draft.accountHandle} onClick={() => goToRegistrationStep("delivery")}>次へ</button></div> : null}
      </div>
      <div hidden={guidedRegistration && (registrationStep !== "delivery" || review !== null)}>
      <fieldset disabled={busy || !active} className="nx-editor-section"><legend className={guidedRegistration ? "sr-only" : undefined}>通知先</legend>
        <label className="text-sm">通知先<select className={field} value={draft.destinationId} onChange={event => update("destinationId", event.target.value)}><option value="">{draft.workflowId ? "詳細ルールで指定" : "本人のDM"}</option>{draft.destinationId && !destinations.some(item => item.id === draft.destinationId && item.enabled !== false && item.scope !== "guild") ? <option value={draft.destinationId} disabled>現在の通知先（候補を確認）</option> : null}{destinations.filter(item => item.enabled !== false && item.scope !== "guild").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {onAddDestination ? <button type="button" className={button} disabled={busy || loading || !active} onClick={() => {
          const requestingDraft = draft, requestingContext = context.current;
          onAddDestination(id => {
            if (!mounted.current || !activeRef.current || context.current !== requestingContext || draftRef.current !== requestingDraft) return;
            setDraft(currentDraft => currentDraft === requestingDraft ? { ...currentDraft, destinationId: id } : currentDraft); setReview(null);
          });
        }}>チャンネル・Webhookを追加</button> : null}
      </fieldset>
      {registrationQuote ? <fieldset className="nx-timing-options nx-editor-section" disabled={busy || !active}><legend>通知タイミング</legend>
        <label className="nx-timing-option"><input type="radio" name="x-registration-timing" value="batch" checked={draft.processingMode === "batch"} onChange={() => chooseTiming("batch")} /><span><strong>プランの間隔で通知</strong><small>{xInterval(quota?.currentPlan.intervalMinutes ?? current?.quality.intervalMinutes ?? null)}・1枠</small></span></label>
        <label className="nx-timing-option"><input type="radio" name="x-registration-timing" value="realtime" checked={draft.processingMode === "realtime"} disabled={!registrationQuote.canEnableRealtime || !selectedSupporterAvailable || processingQuoteStale} onChange={() => chooseTiming("realtime")} /><span><strong>リアルタイム</strong><small>{realtimeQuoteReady ? <>受信後、間隔を待たずに処理・合計{registrationQuote.realtimeSlotCost}枠{xRealtimeBenefit(registrationQuote) ? `（${xRealtimeBenefit(registrationQuote)}）` : ""}</> : "利用資格と枠数を再確認してください"}</small></span></label>
      </fieldset> : <p role="status" className="nx-field-note">通知タイミングの確認待ち</p>}
      {current && supporterQuote?.eligible && current.poolKind !== "supporter" ? <section className="nx-supporter-action"><button type="button" className={button} disabled={busy || loading || !active || !supporterOffer || processingQuoteStale} onClick={() => {
        setDraft(previous => previous ? { ...previous, processingMode: "realtime", processingTouched: true, poolPreference: "supporter" } : previous); setReview(null);
      }}>支援者特典でリアルタイムに変更・1枠</button>{!supporterOffer ? <p role="status" className="nx-field-note">{supporterQuote.reason ?? "支援者優先枠の空きを確認してください。"}</p> : null}</section> : null}
      {newRealtime && draft.poolPreference === "supporter" && realtimeQuoteReady ? <p className="nx-slot-consent">支援者優先枠を使用・個人1枠</p> : null}
      {supporterQuote?.eligible && !supporterQuote.available || newRealtime && !selectedSupporterAvailable ? <p role="status" className="nx-field-note">{supporterQuote?.reason ?? "支援者優先枠の利用資格と空き状況を確認してください。"}</p> : null}
      {newRealtime && realtimeQuoteReady && registrationQuote?.realtimeSlotCost === 5 ? <p className="nx-slot-consent">個人枠を合計5枠使用します。通常の1枠に加えて4枠を確保します。</p> : null}
      {processingQuoteStale ? <p role="alert" className="nx-feedback">必要な枠数を再確認してください。<button type="button" className={button} disabled={busy || loading || !active} onClick={() => { setReview(null); void load(); }}>枠数を再確認</button></p> : null}
      <details className="nx-editor-advanced"><summary>詳細設定</summary><div className="space-y-3">
        <label className="text-sm">詳細ルール（任意）<select className={field} disabled={busy || !active} value={draft.workflowId} onChange={event => update("workflowId", event.target.value)}><option value="">未指定</option>{draft.workflowId && !rules.some(item => item.id === draft.workflowId && item.scope !== "guild") ? <option value={draft.workflowId} disabled>現在の詳細ルール（候補を確認）</option> : null}{rules.filter(item => item.scope !== "guild").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {current ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy || !active} checked={draft.enabled} onChange={event => update("enabled", event.target.checked)} />通知を有効にする</label> : null}
      </div></details>
      </div>
      <footer className="notification-editor-actions" hidden={guidedRegistration && registrationStep !== "delivery"}>
        {review !== null ? <section aria-label="X監視の変更確認" className="nx-change-review"><p className="text-sm">{draft.accountHandle ? `Xアカウント @${draft.accountHandle}` : "このX監視"}</p>
          <dl className="monitor-facts"><div><dt>通知先</dt><dd>{destinations.find(item => item.id === draft.destinationId)?.name ?? (draft.destinationId ? "選択した通知先" : draft.workflowId ? "詳細ルールで指定" : "本人のDM")}</dd></div>{registrationQuote ? <div><dt>通知タイミング</dt><dd>{draft.processingMode === "realtime" ? "リアルタイム" : "プランの間隔"}・合計{draft.processingMode === "realtime" ? registrationQuote.realtimeSlotCost : 1}枠</dd></div> : null}</dl>
          {guidedRegistration && !draft.subscriptionId ? <p role="status" className="nx-slot-consent">接続するまで通知は届きません。</p> : null}
          {draft.poolPreference === "supporter" ? <p className="nx-slot-consent">支援者優先枠を使用・個人1枠</p> : null}
          {draft.workflowId ? <div className="nx-field-note"><p>詳細ルール {rules.find(rule => rule.id === draft.workflowId)?.name || "選択したルール"}・{workflowStatusLabel(workflowStatus(draft.workflowId, reviewedRule?.id === draft.workflowId ? [reviewedRule] : rules))}</p>{onOpenWorkflow ? <button type="button" className={button} onClick={() => { setEditorOpen(false); onOpenWorkflow(draft.workflowId); }}>選択したルールを開く</button> : null}</div> : null}
          {!realtimePriceConfirmed ? <p role="alert">必要な枠数が変わりました。確認し直してください。</p> : null}
          {current && draft.accountHandle !== (current.accountHandle ?? "") ? <p className="text-sm">変更後のXアカウント名：{draft.accountHandle ? `@${draft.accountHandle}` : "未設定"}</p> : null}
          {deliveryChanged ? <p className="nx-slot-consent">設定を変更すると、変更前の未送信通知を取り消します。送信開始後は取り消せない場合があります。</p> : null}
          {review !== (current?.revision ?? 0) ? <p role="alert">設定が更新されています。変更内容を確認し直してください。</p> : null}
          <div className="nx-actions"><button type="button" className="nx-primary" disabled={!canReview || review !== (current?.revision ?? 0) || !realtimePriceConfirmed} onClick={() => void save()}>{unified && !current ? "通知を登録" : "このX監視設定で保存"}</button><button type="button" className={button} disabled={busy} onClick={() => guidedRegistration ? goToRegistrationStep("delivery") : setReview(null)}>編集に戻る</button></div>
        </section> : guidedRegistration && registrationStep !== "delivery" ? null : <button type="submit" className="nx-primary" disabled={!canReview}>{needsConfirmation ? unified && !current ? "登録内容を確認" : "変更を確認" : "設定を保存"}</button>}
        {guidedRegistration && registrationStep === "delivery" && review === null ? <button type="button" className={button} disabled={busy} onClick={() => goToRegistrationStep("account")}>戻る</button> : null}
      </footer>
      </form>
      {current ? <details className="nx-editor-advanced"><summary>利用枠の種類を変更</summary><p className="nx-field-note">現在の枠 {xPoolName(liveCurrent?.poolKind ?? current.poolKind)}</p><XMonitorMoveEditor row={liveCurrent ?? current} api={api} disabled={!active || busy} onBusy={value => { action.current = value; setBusy(value); if (value) { epoch.current++; setLoading(false); } }} onReload={load} onSaved={async saved => {
        if (!mounted.current || !activeRef.current || context.current !== renderContext) return;
        epoch.current++; setLoading(false);
        setItems(previous => previous.map(row => row.id === saved.id ? saved : row)); setDraft(previous => previous ? rebaseDraft(current, previous, saved) : previous); setEditingBaseline(saved); setRevisionConflict(false); setRebasedReview(true); setReview(null); await load();
      }} /></details> : null}
      {setupOpen ? <AutomationDialog title="Xとの接続" cancelLabel="戻る" busy={busy || setupBusy} open={active} onCancel={closeSetup}><XNotificationSetup api={setupApi} active={active} initiallyOpen embedded hideEmbeddedHeader onDirtyChange={onSetupDirtyChange} onBusyChange={onSetupBusyChange} onSubscriptionsChanged={() => { void load(); }} onChooseSubscription={subscription => {
        if (!activeRef.current || !mounted.current || context.current !== renderContext) return;
        chosenSubscriptions.current.set(subscription.id, subscription);
        setSetup(previous => previous ? { ...previous, subscriptions: [...previous.subscriptions.filter(item => item.id !== subscription.id), subscription] } : previous);
        if (subscription.receiverState !== "requires_reenrollment") setRejectedSubscriptionId(null);
        setDraft(previous => previous ? { ...previous, subscriptionId: subscription.id,
          browserAcknowledgedHandle: previous.subscriptionId === subscription.id ? previous.browserAcknowledgedHandle : null } : previous); setReview(null); setupDirty.current = false; setSetupOpen(false); void load();
      }} onCancel={() => { setupDirty.current = false; setSetupOpen(false); }} /></AutomationDialog> : null}
    </AutomationDialog> : null}
    </> : null}
    {(() => {
      const rows: XUnifiedRow[] = items.map(item => {
      const subscription = setup?.subscriptions.find(row => row.id === item.notificationSettings.subscriptionId);
      const readiness = monitorState(readinessOf({ ...item, ...item.notificationSettings }, rules, destinations));
      const state = !item.enabled || item.state === "suspended" || item.state === "deleted" ? "停止中" : readiness.action ? readiness.label : !item.notificationSettings.subscriptionId || subscription?.receiverState === "requires_reenrollment" ? "接続設定待ち" : item.processing?.effectiveMode !== "realtime" && (item.processing ? !item.processing.configured : item.quality.intervalMinutes === null) ? "間隔設定待ち" : subscription?.receiverState === "listening" ? "受信待ち" : subscription?.receiverState === "error" ? "接続の確認待ち" : "接続待ち";
      const filterState: XUnifiedRow["filterState"] = state === "停止中" ? "paused" : state === "受信待ち" ? "active" : "attention";
      const searchText = ["X", "x.com", item.name, item.accountHandle, item.accountHandle ? `@${item.accountHandle}` : "", item.accountHandle ? `https://x.com/${item.accountHandle}` : "", item.accountId].filter(Boolean).join(" ");
      const deliveryStages = <dl aria-label="X通知の状況" className="nx-delivery-stages"><div><dt>接続</dt><dd>{subscription ? xReceiverLabel(subscription.receiverState) : item.notificationSettings.subscriptionId ? "接続情報を確認" : "受信情報を選択"}</dd></div><div><dt>通知データの受信</dt><dd>{subscription?.lastReceivedAtMs ? <>最終受信 {new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(subscription.lastReceivedAtMs)}（接続単位）</> : subscription ? subscription.receiverState === "listening" ? "この接続の初回受信待ち" : "この接続の受信記録なし" : "確認待ち"}</dd></div></dl>;
      const node = <article key={`x:${item.id}`} aria-label={`${item.name || item.accountHandle || item.accountId}のX監視`} className="monitor-card nx-monitor-card">
      <header className="nx-monitor-card-heading"><div><h3 className="font-medium">{item.name || item.accountHandle || item.accountId}</h3><p className="nx-field-note">{unified ? <span>X </span> : null}{item.accountHandle ? `@${item.accountHandle}` : unified ? null : "Xアカウント"}</p></div><strong className={`nx-monitor-state${state === "停止中" ? " nx-monitor-state-muted" : ""}`}>{state}</strong></header>
      <dl className="monitor-facts"><div><dt>通知先</dt><dd>{destinations.find(destination => destination.id === item.notificationSettings.destinationId)?.name || (item.notificationSettings.destinationId ? "登録済みの通知先" : item.notificationSettings.workflowId ? "詳細ルールで指定" : "本人のDM")}</dd></div><div><dt>通知タイミング</dt><dd>{item.processing ? xTimingLabel(item.processing) : "確認待ち"}</dd></div>{!unified ? <div><dt>使用枠</dt><dd>{item.processing ? `${item.processing.slotCost}枠` : "確認待ち"}</dd></div> : null}</dl>
      {unified ? <details className="nx-field-note" aria-label="X通知の接続と利用状況"><summary>接続・利用状況</summary>
        <p>使用枠 {item.processing ? `${item.processing.slotCost}枠` : "確認待ち"}</p>{deliveryStages}
        {item.accountId !== null ? <p>XアカウントID：{item.accountId}</p> : null}<p>利用枠 {xPoolName(item.poolKind)}</p><p>送信上限 1分{item.quality.minuteLimit}通／1日{item.quality.dayLimit}通</p>
      </details> : deliveryStages}
      <MonitorDeliveryActivity api={api} kind="x" targetId={item.id} active={active} />
      {item.enabled && item.state === "ready" && readiness.action ? <p className="nx-field-note">{readiness.description}{readiness.action === "workflow" && onOpenWorkflow && item.notificationSettings.workflowId ? <button type="button" className={button} disabled={!active || busy} onClick={() => { setEditorOpen(false); onOpenWorkflow(item.notificationSettings.workflowId!); }}>割り当てたルールを開く</button> : null}</p> : null}
      {item.state === "suspended" ? <p className="nx-field-note">利用資格を確認してください。監視対象と通知設定は保持されています。</p> : null}
      {item.state !== "deleted" ? <div className="nx-actions"><button className={button} disabled={!active || busy || Boolean(draft && editingId !== item.id)} onClick={() => { if (!draft) { setDraft(draftOf(item)); setEditingId(item.id); setEditingBaseline(item); setRevisionConflict(false); setRebasedReview(false); setReview(null); setError(""); } draftFocusPending.current = true; setEditorOpen(true); }}>{unified ? "設定を変更" : "通知設定"}</button>
        {state === "接続設定待ち" || state === "接続待ち" || state === "接続の確認待ち" ? <button className="nx-text-link" disabled={!active || busy || Boolean(draft && editingId !== item.id)} onClick={() => { if (!draft) { setDraft(draftOf(item)); setEditingId(item.id); setEditingBaseline(item); setRevisionConflict(false); setRebasedReview(false); setReview(null); setError(""); } draftFocusPending.current = true; setEditorOpen(true); setSetupOpen(true); }}>接続を確認</button> : null}
        <details className="nx-monitor-menu"><summary>その他の操作</summary><div className="nx-actions"><button className={button} disabled={!active || busy || !item.enabled && !canResume(item)} onClick={() => void toggle(item)}>{item.enabled ? (unified ? "停止" : "X監視を停止") : (unified ? "再開" : "X監視を再開")}</button><button className={`${button} text-destructive`} disabled={!active || busy} onClick={() => setDeleting(item.id)}>{unified ? "削除" : "X監視を削除"}</button></div></details>
      </div> : null}
      {!unified ? <details className="nx-field-note"><summary>登録情報の詳細</summary>{item.accountId !== null ? <p>XアカウントID：{item.accountId}</p> : null}<p>利用枠 {xPoolName(item.poolKind)}</p><p>送信上限 1分{item.quality.minuteLimit}通／1日{item.quality.dayLimit}通</p></details> : null}
      {deleting === item.id ? <AutomationDialog title="X監視を削除" open={active} busy={busy} onCancel={() => setDeleting(null)} error={error || undefined}><p>このX監視の登録を削除して利用枠を解放します。</p><footer className="notification-editor-actions"><button className={`${button} text-destructive`} disabled={!active || busy} onClick={() => void mutate(async () => {
        const version = mutationEpoch.current;
        await api(`x-monitors/${encodeURIComponent(item.id)}`, "DELETE", { expectedRevision: item.revision });
        if (!mounted.current || !activeRef.current || version !== mutationEpoch.current) return;
        epoch.current++; setLoading(false); setItems(previous => previous.filter(row => row.id !== item.id)); setDeleting(null); if (editingId === item.id) { setDraft(null); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); }
        setNotice("X監視を削除しました。"); await load();
      })}>このX監視を削除</button></footer></AutomationDialog> : null}
    </article>;
      return { key: `x:${item.id}`, item, node, filterState, searchText };
      });
      return renderUnifiedList ? renderUnifiedList(active ? rows : [], { loading: active && loading, failed: active && Boolean(readError), reload }) : <div className="monitor-list">{rows.map(row => row.node)}</div>;
    })()}
    {!unified && !loading && !readError && items.length === 0 ? <p role="status" className="text-sm">登録済みのX監視はありません。</p> : null}
  </div>;
}

export function XMonitorManager({ api, setupApi = api, active = true, allowSetup = true, destinations = [], rules = [], onAddDestination, onOpenWorkflow, initiallyOpen = false, setupPlacement = "full", registrationRequest, hideAddAction = false, unified = false, renderUnifiedList, suppressReadErrors = false, listFilter = "all" }: { api: XMonitorAPI; setupApi?: XMonitorAPI; active?: boolean; allowSetup?: boolean; destinations?: Choice[]; rules?: Choice[]; onAddDestination?: AddDestination; onOpenWorkflow?: (id: string) => void; initiallyOpen?: boolean; setupPlacement?: "full" | "compact"; registrationRequest?: RegistrationRequest; hideAddAction?: boolean; unified?: boolean; renderUnifiedList?: UnifiedListRenderer; suppressReadErrors?: boolean; listFilter?: "all" | "x" | "other" }) {
  const [opened, setOpened] = useState(initiallyOpen || unified), [subscriptionsVersion, setSubscriptionsVersion] = useState(0);
  useEffect(() => { if (active && (registrationRequest || unified)) setOpened(true); }, [active, registrationRequest, unified]);
  const compact = setupPlacement === "compact";
  const Container = unified ? "div" : "section";
  return <Container {...(!unified ? { "aria-label": "Xアカウントの監視" } : {})} className="notification-x nx-monitor-panel">{!unified ? <header className="nx-section-heading"><h2>監視するアカウント</h2></header> : null}
    {!opened ? <button className={button} disabled={!active} onClick={() => setOpened(true)}>Xアカウントの監視を管理</button> : <>{!compact && !unified ? allowSetup ? <><XNotificationSetup api={setupApi} active={active} onSubscriptionsChanged={() => setSubscriptionsVersion(value => value + 1)} /><details className="nx-editor-advanced"><summary>共通の初期設定</summary><XProcessingSettings api={api} active={active} /></details></> : <a href="/dashboard/automation/x" className="inline-block text-sm text-primary underline">自分のX通知セットアップを開く</a> : null}<XMonitorEditor api={api} setupApi={setupApi} active={active} allowSetup={allowSetup} subscriptionsVersion={subscriptionsVersion} destinations={destinations} rules={rules} onAddDestination={onAddDestination} onOpenWorkflow={onOpenWorkflow} compact={compact} registrationRequest={registrationRequest} hideAddAction={hideAddAction} unified={unified} renderUnifiedList={renderUnifiedList} suppressReadErrors={suppressReadErrors} listFilter={listFilter} /></>}
  </Container>;
}
