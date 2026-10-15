"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import "./notification-x.css";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
type Choice = { id: string; name: string; enabled?: boolean; scope?: string };
type Draft = { accountHandle: string; name: string; enabled: boolean; destinationId: string; workflowId: string; subscriptionId: string; processingMode: XProcessingMode; processingTouched: boolean; poolPreference: "auto" | "supporter"; firefoxAcknowledgedHandle: string | null };
const draftOf = (item?: XMonitor): Draft => ({ accountHandle: item?.accountHandle ?? "", name: item?.name ?? "", enabled: item?.enabled ?? true,
  destinationId: item?.notificationSettings.destinationId ?? "", workflowId: item?.notificationSettings.workflowId ?? "", subscriptionId: item?.notificationSettings.subscriptionId ?? "", processingMode: item?.processing?.requestedMode ?? "batch", processingTouched: false, poolPreference: "auto", firefoxAcknowledgedHandle: null });
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
type RegistrationRequest = { id: number; accountHandle?: string; name?: string; destinationId?: string };
function XMonitorEditor({ api, active, allowSetup, subscriptionsVersion, destinations, rules, onAddDestination, onOpenWorkflow, compact, registrationRequest, hideAddAction }: { api: XMonitorAPI; active: boolean; allowSetup: boolean; subscriptionsVersion: number; destinations: Choice[]; rules: Choice[]; onAddDestination?: AddDestination; onOpenWorkflow?: (id: string) => void; compact: boolean; registrationRequest?: RegistrationRequest; hideAddAction: boolean }) {
  const [items, setItems] = useState<XMonitor[]>([]), [quota, setQuota] = useState<XMonitorQuota | null>(null);
  const [setup, setSetup] = useState<XSetupStatus | null>(null), [setupError, setSetupError] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [readError, setReadError] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null), [editingId, setEditingId] = useState<string | null>(null), [review, setReview] = useState<number | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  const [editingBaseline, setEditingBaseline] = useState<XMonitor | null>(null), [revisionConflict, setRevisionConflict] = useState(false), [rebasedReview, setRebasedReview] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false), [setupOpen, setSetupOpen] = useState(false);
  const [profileCopyMessage, setProfileCopyMessage] = useState("");
  const [reviewedRule, setReviewedRule] = useState<any>(null);
  const mounted = useRef(false), activeRef = useRef(active), epoch = useRef(0), action = useRef(false);
  const draftRef = useRef(draft); draftRef.current = draft;
  const consumedRequest = useRef(0), draftForm = useRef<HTMLFormElement>(null), draftFocusPending = useRef(false);
  const chosenSubscriptions = useRef(new Map<string, XSetupSubscription>()), consumedConnection = useRef(false);
  const reviewProcessingCost = useRef<number | null>(null), [processingQuoteStale, setProcessingQuoteStale] = useState(false);
  activeRef.current = active;
  const liveCurrent = items.find(item => item.id === editingId);
  const current = editingBaseline?.id === editingId ? editingBaseline : undefined;
  const editConflict = revisionConflict || Boolean(current && liveCurrent && current.revision !== liveCurrent.revision);
  const rolloutPermits = !allowSetup || Boolean(setup?.rollout.eligible && setup.rollout.mode !== "disabled");
  const canRegister = Boolean(rolloutPermits && quota?.featureEnabled && quota.personal.available > 0 && quota.x.available > 0
    && !["X_MONITOR_UNAVAILABLE", "X_MONITOR_PERSONAL_LIMIT", "X_MONITOR_POOL_FULL", "X_ROLLOUT_DISABLED", "X_ROLLOUT_SUPPORTERS_ONLY"].includes(quota.x.reasonCode ?? ""));
  const canResume = (item: XMonitor) => Boolean(rolloutPermits && quota?.featureEnabled && quota.personal.used <= quota.personal.totalLimit
    && (item.poolKind !== null || quota.pools.free.available > 0 || quota.x.specialLimit > quota.x.specialUsed
      || quota.personal.supporterExtraSlots > 0 && quota.pools.supporter.available > 0) && !["X_MONITOR_UNAVAILABLE", "X_ROLLOUT_DISABLED", "X_ROLLOUT_SUPPORTERS_ONLY"].includes(quota.x.reasonCode ?? ""));
  const load = useCallback(async () => {
    if (!activeRef.current || !mounted.current) return;
    const version = ++epoch.current; setLoading(true); setReadError("");
    const results = await Promise.allSettled([api("x-monitor-quota"), api("x-monitors"), allowSetup ? api("x-setup") : Promise.resolve(null)]);
    if (!mounted.current || !activeRef.current || version !== epoch.current) return;
    let nextQuota: XMonitorQuota | null = null, listLoaded = false;
    try { if (results[0].status === "fulfilled") nextQuota = parseXQuota(results[0].value); } catch { /* Use a valid owner-scoped list quota if available. */ }
    try {
      if (results[1].status !== "fulfilled") throw new Error("Unavailable X list");
      const list = xObject(results[1].value);
      if (!Array.isArray(list.items)) throw new Error("Invalid X list");
      setItems(list.items.map(parseXMonitor));
      listLoaded = true;
      if (nextQuota === null && list.quota) nextQuota = parseXQuota(list.quota);
    } catch { setReadError("X監視の一覧をもう一度読み込んでください。入力内容はそのまま残っています。"); }
    if (allowSetup) {
      try {
        if (results[2].status !== "fulfilled") throw new Error("Unavailable setup metadata");
        const metadata = parseXSetupStatus(results[2].value);
        setSetup({ ...metadata, subscriptions: [...metadata.subscriptions, ...[...chosenSubscriptions.current.values()].filter(item => !metadata.subscriptions.some(row => row.id === item.id))] }); setSetupError("");
      }
      catch { setSetup(null); setSetupError("受信情報の候補をもう一度読み込んでください。「X一覧・利用枠を更新」から再試行できます。"); }
    } else { setSetup(null); setSetupError(""); }
    setQuota(nextQuota); if (listLoaded || nextQuota?.registrationProcessing) setProcessingQuoteStale(false);
    if (nextQuota === null) setReadError(previous => previous || "現在のプランと利用枠を読み直してください。取得済みの監視は停止・削除できます。追加・再開は、利用枠を確認してから行えます。");
    setLoading(false);
    return listLoaded;
  }, [api, allowSetup]);
  useEffect(() => { mounted.current = true; if (active) void load(); return () => { mounted.current = false; epoch.current++; }; }, [load, active, subscriptionsVersion]);
  useEffect(() => {
    if (!active || loading || !setup || draftRef.current || consumedConnection.current) return;
    const selectedId = new URLSearchParams(window.location.search).get("xSubscriptionId");
    if (!selectedId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(selectedId) || !setup.subscriptions.some(item => item.id === selectedId)) return;
    const existing = items.find(item => item.notificationSettings.subscriptionId === selectedId && item.state !== "deleted");
    consumedConnection.current = true; setEditingId(existing?.id ?? null); setEditingBaseline(existing ?? null); setRevisionConflict(false); setRebasedReview(false); setDraft({ ...draftOf(existing), subscriptionId: selectedId }); setEditorOpen(true); draftFocusPending.current = true;
  }, [active, loading, setup, items]);
  useEffect(() => {
    if (!active || !registrationRequest || !Number.isSafeInteger(registrationRequest.id) || registrationRequest.id <= consumedRequest.current) return;
    consumedRequest.current = registrationRequest.id;
    setEditorOpen(true);
    if (draftRef.current) { draftForm.current?.querySelector<HTMLInputElement>("input")?.focus(); draftForm.current?.scrollIntoView?.({ block: "nearest" }); return; }
    draftFocusPending.current = true; setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); setReview(null);
    setDraft({ ...draftOf(), accountHandle: registrationRequest.accountHandle?.replace(/^@/u, "") ?? "", name: registrationRequest.name ?? "", destinationId: registrationRequest.destinationId ?? "" });
  }, [active, registrationRequest]);
  useEffect(() => {
    if (!active || !draft || !draftFocusPending.current) return;
    draftFocusPending.current = false; draftForm.current?.querySelector<HTMLInputElement>("input")?.focus(); draftForm.current?.scrollIntoView?.({ block: "nearest" });
  }, [active, draft]);
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { if (!action.current) { setDraft(previous => previous ? { ...previous, [key]: value, ...(key === "accountHandle" && value !== previous.accountHandle ? { firefoxAcknowledgedHandle: null } : {}) } : previous); if (key === "accountHandle") setProfileCopyMessage(""); setReview(null); setNotice(""); } }
  async function mutate(work: () => Promise<void>) {
    if (action.current || !activeRef.current) return;
    action.current = true; const version = ++epoch.current; setLoading(false); setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (cause) { if (mounted.current && activeRef.current && version === epoch.current) { setReview(null); setError(xFeedback(cause)); } }
    finally { action.current = false; if (mounted.current) setBusy(false); }
  }
  const validSubscription = !draft?.subscriptionId || draft.subscriptionId === current?.notificationSettings.subscriptionId || Boolean(setup?.available && setup.subscriptions.some(item => item.id === draft.subscriptionId));
  const requiresHandle = !current || current.accountId === null;
  const validHandle = Boolean(draft && /^[A-Za-z0-9_]{1,15}$/u.test(draft.accountHandle) && !["i", "intent"].includes(draft.accountHandle.toLowerCase()));
  const valid = Boolean(draft && validSubscription && (validHandle || !requiresHandle && !draft.accountHandle) && draft.name.length <= 120 && (!current || draft.name.trim().length > 0)
    && (current || draft.firefoxAcknowledgedHandle === draft.accountHandle));
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
      const version = epoch.current, response = xObject(await api("x-monitors"));
      if (!Array.isArray(response.items)) throw new Error("Invalid X list");
      const latestItems = response.items.map(parseXMonitor), latest = latestItems.find(item => item.id === before.id && item.state !== "deleted");
      if (!mounted.current || !activeRef.current || version !== epoch.current || draftRef.current !== requested) return;
      if (!latest) throw { code: "NOT_FOUND", status: 404 };
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
      const version = epoch.current;
      let rawResponse;
      try { rawResponse = await api(current ? `x-monitors/${encodeURIComponent(current.id)}` : "x-monitors", current ? "PATCH" : "POST", body); }
      catch (cause) {
        const failure = cause && typeof cause === "object" ? cause as { code?: string; status?: number } : {};
        if (newRealtime || failure.code === "X_REALTIME_COST_CONFLICT") setProcessingQuoteStale(true);
        if (current && (["REVISION_CONFLICT", "X_MONITOR_REVISION_CONFLICT"].includes(failure.code ?? "") || failure.status === 409 && !failure.code)) setRevisionConflict(true);
        throw cause;
      }
      const response = xObject(rawResponse);
      const saved = parseXMonitor(response.item ?? response);
      if (!mounted.current || !activeRef.current || version !== epoch.current) return;
      setItems(previous => [...previous.filter(item => item.id !== saved.id), saved]); setDraft(null); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); setReview(null); setEditorOpen(false);
      setNotice(saved.notificationSettings.subscriptionId ? "X監視の設定を保存しました。" : "X監視の設定を保存しました。接続設定から受信情報を選んでください。"); await load();
    });
  }
  async function toggle(item: XMonitor) {
    if (item.enabled || canResume(item)) await mutate(async () => {
      const version = epoch.current;
      const response = xObject(await api(`x-monitors/${encodeURIComponent(item.id)}`, "PATCH", { expectedRevision: item.revision, enabled: !item.enabled }));
      const saved = parseXMonitor(response.item ?? response);
      if (!mounted.current || !activeRef.current || version !== epoch.current) return;
      setItems(previous => previous.map(row => row.id === saved.id ? saved : row)); setNotice(item.enabled ? "X監視を停止しました。" : "X監視を再開しました。"); await load();
    });
  }
  return <div className="nx-monitor-panel">
    {setup?.rollout.mode === "supporters" ? <p role="status" className="nx-state-line"><ShieldCheck size={16} aria-hidden="true" /><span>支援者向けベータ版{setup.rollout.eligible ? "・利用できます" : "・受付対象の拡大待ち"}</span></p> : null}
    {setup?.rollout.mode === "disabled" && quota?.x.reasonCode !== "X_ROLLOUT_DISABLED" ? <p role="status" className="text-sm">{xReason("X_ROLLOUT_DISABLED")}</p> : null}
    {compact ? <div className="nx-status-grid"><section aria-label="Xの接続状況" className="nx-compact-status"><header><Radio size={17} aria-hidden="true" /><h3>Xとの接続</h3></header><strong>{!allowSetup ? "個人ページで設定" : !setup ? "接続状況を確認中" : !setup.subscriptions.length && !setup.nextCursor ? "受信情報を登録しましょう" : setup.subscriptions.some(item => item.receiverState === "listening") ? "サーバー接続を確認済み" : setup.nextCursor ? "続きの受信情報を確認" : "接続の準備・確認中"}</strong>{setup?.subscriptions.some(item => item.receiverState === "requires_reenrollment") ? <p>受信情報を登録し直してください。</p> : null}<a className="nx-text-link" href="/dashboard/automation/x">接続を確認<ArrowRight size={14} aria-hidden="true" /></a></section><section aria-label="X通知のタイミング" className="nx-compact-status"><header><Clock3 size={17} aria-hidden="true" /><h3>通知方法</h3></header>{!loading && !readError && items.every(item => item.processing) ? <div className="nx-monitor-timing-status"><span className="nx-timing-chip"><Zap size={14} aria-hidden="true" />リアルタイム {items.filter(item => item.processing?.effectiveMode === "realtime").length}件</span><span className="nx-timing-chip"><Clock3 size={14} aria-hidden="true" />プランの間隔 {items.filter(item => item.processing?.effectiveMode === "batch").length}件</span></div> : <strong>{loading ? "確認中…" : "通知方法の確認待ち"}</strong>}</section></div> : null}
    {quota && compact ? <section aria-label="X監視の個人利用枠" className="nx-quota-card"><dl className="nx-quota-summary"><div><dt>X監視の登録数</dt><dd>{quota.x.used}件</dd></div><div><dt>1枠利用で追加可能</dt><dd>{quota.x.available}件</dd></div><div><dt>現在のプラン</dt><dd>{quota.currentPlan.label}</dd></div></dl><a href="/dashboard/automation/plans" className="nx-text-link"><Users size={15} aria-hidden="true" />プランと利用枠を確認<ArrowRight size={14} aria-hidden="true" /></a>
      {!quota.featureEnabled && !quota.x.reasonCode?.startsWith("X_ROLLOUT_") ? <p role="status">{xReason("X_MONITOR_UNAVAILABLE")}</p> : null}{quota.x.reasonCode && (quota.featureEnabled || quota.x.reasonCode !== "X_MONITOR_UNAVAILABLE") ? <p role="status">{xReason(quota.x.reasonCode)}</p> : null}</section> : null}
    {quota && !compact ? <details aria-label="X監視の個人利用枠" className="space-y-2 rounded border bg-muted/30 p-4 text-sm"><summary>利用状況 {quota.personal.used}／{quota.personal.totalLimit}枠</summary>
      <p className="font-medium">現在のプラン: {quota.currentPlan.label}</p>
      <dl className="grid gap-2 sm:grid-cols-2"><div><dt>個人の総登録上限</dt><dd>{quota.personal.totalLimit}枠（基本{quota.currentPlan.baseSlotLimit}＋支援追加{quota.personal.supporterExtraSlots}）</dd></div>
        <div><dt>現在の登録数</dt><dd>{quota.personal.registeredCount === null ? "件数未取得" : `${quota.personal.registeredCount}件`}</dd></div>
        <div><dt>現在の使用枠</dt><dd>{quota.personal.used}／{quota.personal.totalLimit}枠（空き{quota.personal.available}枠）</dd></div><div><dt>支援者追加枠の保有数</dt><dd>{quota.personal.supporterExtraSlots}枠</dd></div>
        <div><dt>X監視の利用数・空き枠</dt><dd>{quota.x.used}件／空き{quota.x.available}件</dd></div><div><dt>無料共有枠の全体空き</dt><dd>{quota.pools.free.available}／{quota.pools.free.limit}枠</dd></div>
        <div><dt>現在プランの確認間隔</dt><dd>{xInterval(quota.currentPlan.intervalMinutes)}</dd></div></dl>
      <p className="text-xs text-muted-foreground">X監視の使用枠は、通知方法ごとに確認できます。通常通知とX監視は、同じ個人の登録上限で数えます。寄付へのお礼で付与された追加枠は、月額プランの解約後も引き継ぎます。申込資格と全体枠の空きは、それぞれ確認します。</p>
      <p className="text-xs text-muted-foreground">確認間隔の短縮に配分した追加枠も使用枠数に含みます。登録件数とは別に数えます。</p>
      <p className="text-xs text-muted-foreground">標準の設定では、受信を開始すると通知を随時受け取り、現在のプランの間隔ごとに、届いた分をまとめて処理します。リアルタイムを選択して保存すると、受け取り次第処理します。通知先への送信には、ルールの条件と送信上限を適用します。</p>
      <p className="text-xs text-muted-foreground">確認間隔と送信上限には、現在の契約プランを適用します。どの種類の枠でも、1分{quota.currentPlan.minuteLimit}通・1日{quota.currentPlan.dayLimit}通までです。</p>
      {!quota.featureEnabled && !quota.x.reasonCode?.startsWith("X_ROLLOUT_") ? <p role="status">{xReason("X_MONITOR_UNAVAILABLE")}</p> : null}
      {quota.x.reasonCode && (quota.featureEnabled || quota.x.reasonCode !== "X_MONITOR_UNAVAILABLE") ? <p role="status">{xReason(quota.x.reasonCode)}</p> : null}
    </details> : null}
    {readError ? <p role="alert" className="text-sm text-destructive">{readError}</p> : null}{setupError ? <p role="alert" className="text-sm text-destructive">{setupError}</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <div className="flex flex-wrap gap-2">{!hideAddAction ? <button className="nx-primary" disabled={!active || busy || loading || !canRegister} onClick={() => { setEditorOpen(true); if (!draft) { setDraft(draftOf()); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); } }}>X監視を追加</button> : null}
      <button className={button} disabled={!active || busy || loading} onClick={() => { setReview(null); void load(); }}>X一覧・利用枠を更新</button></div>
    {draft && !editorOpen ? <div className="nx-actions"><button className={button} onClick={() => setEditorOpen(true)}>編集中の設定を開く</button><details className="nx-field-note"><summary>入力を破棄</summary><button className={button} onClick={() => { setDraft(null); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); setReview(null); setError(""); setProcessingQuoteStale(false); }}>この下書きを破棄</button></details></div> : null}
    {loading ? <p role="status" className="text-sm">X監視を読み込み中…</p> : null}
    {draft && editorOpen ? <AutomationDialog title={current ? "通知設定" : "Xアカウントを登録"} open={active} busy={busy} onCancel={() => { setEditorOpen(false); setSetupOpen(false); }} error={error || undefined}>
      <form ref={draftForm} aria-label="X監視の登録設定" className="nx-unified-form" noValidate onSubmit={event => {
        event.preventDefault(); if (!canReview) return;
        reviewProcessingCost.current = newRealtime ? registrationQuote?.realtimeSlotCost ?? null : null;
        if (needsConfirmation) void mutate(async () => {
          const request = epoch.current, requested = draft;
          let selectedRule: any = null;
          if (draft.workflowId) { try { const found = await api(`workflows/${encodeURIComponent(draft.workflowId)}`); selectedRule = found && typeof found === "object" && "id" in found && found.id === draft.workflowId ? found : { id: draft.workflowId }; } catch { selectedRule = { id: draft.workflowId }; } }
          if (!mounted.current || !activeRef.current || request !== epoch.current || draftRef.current !== requested) return;
          setReviewedRule(selectedRule); setReview(current?.revision ?? 0);
        }); else void save(current?.revision ?? 0);
      }}>
      {editConflict ? <section aria-label="X通知設定の再確認" className="nx-feedback"><p>別の操作で設定が変更されました。変更した入力を保持して、最新の設定と確認できます。</p><button type="button" className={button} disabled={busy || loading || !active} onClick={() => void reloadDraft()}>最新設定を取得して入力を引き継ぐ</button></section> : null}
      {notice ? <p role="status" className="nx-field-note">{notice}</p> : null}
      <fieldset disabled={busy || !active} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Xアカウント名（@ユーザー名）{requiresHandle ? "・必須" : ""}<input className={field} required={requiresHandle} maxLength={16} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="@example" value={draft.accountHandle} onChange={event => update("accountHandle", event.target.value.replace(/^@/u, ""))} /></label>
        <label className="text-sm">監視の表示名（任意）<input className={field} maxLength={120} value={draft.name} onChange={event => update("name", event.target.value)} /></label>
      </fieldset>
      <p className="nx-field-note">通知を受け取りたい相手の現在の@ユーザー名を入力してください。</p>
      {!current ? <section aria-label="追加用Firefoxで対象アカウントの通知を設定" className="nx-firefox-target-step">
        <h3>追加用Firefoxで{validHandle ? ` @${draft.accountHandle} の` : "対象アカウントの"}投稿通知をON</h3>
        <p>保存ツールで開いた追加用Firefoxで、ブラウザー通知を許可し、対象プロフィールの投稿通知ベルをONにしてください。X側の設定と、この画面での登録が両方必要です。</p>
        <p className="nx-field-note">登録済みの接続を使う場合も、追加するアカウントごとに設定します。設定後は追加用Firefoxを閉じ、この画面へ戻ってください。</p>
        <div className="nx-actions"><button type="button" className={button} disabled={!validHandle || busy || !active} onClick={async () => {
          try { await navigator.clipboard.writeText(`https://x.com/${draft.accountHandle}`); if (mounted.current && activeRef.current) setProfileCopyMessage("プロフィールURLをコピーしました。"); }
          catch { if (mounted.current && activeRef.current) setProfileCopyMessage(`追加用Firefoxで https://x.com/${draft.accountHandle} を開いてください。`); }
        }}>プロフィールURLをコピー</button><button type="button" className="nx-text-link" disabled={busy || !active} onClick={() => setSetupOpen(true)}>Firefoxの準備手順</button></div>
        {profileCopyMessage ? <p role="status" className="nx-field-note">{profileCopyMessage}</p> : null}
        <label className="nx-firefox-ack"><input type="checkbox" disabled={!validHandle || busy || !active} checked={draft.firefoxAcknowledgedHandle === draft.accountHandle} onChange={event => update("firefoxAcknowledgedHandle", event.target.checked ? draft.accountHandle : null)} /><span>追加用Firefoxで、このアカウントの投稿通知をONにしました</span></label>
        <small className="nx-field-note">ご自身での確認です。接続状態と実際の通知は、登録後に確認できます。</small>
      </section> : null}
      <fieldset disabled={busy || !active} className="nx-editor-section"><legend>通知先</legend>
        <label className="text-sm">通知先<select className={field} value={draft.destinationId} onChange={event => update("destinationId", event.target.value)}><option value="">{draft.workflowId ? "詳細ルールで指定" : "本人のDM"}</option>{draft.destinationId && !destinations.some(item => item.id === draft.destinationId && item.enabled !== false && item.scope !== "guild") ? <option value={draft.destinationId} disabled>現在の通知先（候補を確認）</option> : null}{destinations.filter(item => item.enabled !== false && item.scope !== "guild").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {onAddDestination ? <button type="button" className={button} disabled={busy || loading || !active} onClick={() => {
          const requestingDraft = draft;
          onAddDestination(id => {
            if (!mounted.current || !activeRef.current || draftRef.current !== requestingDraft) return;
            setDraft(currentDraft => currentDraft === requestingDraft ? { ...currentDraft, destinationId: id } : currentDraft); setReview(null);
          });
        }}>チャンネル・Webhookを追加</button> : null}
      </fieldset>
      {registrationQuote ? <fieldset className="nx-timing-options nx-editor-section" disabled={busy || !active}><legend>通知タイミング</legend>
        <label className="nx-timing-option"><input type="radio" name="x-registration-timing" value="batch" checked={draft.processingMode === "batch"} onChange={() => chooseTiming("batch")} /><span><strong>プランの間隔で通知</strong><small>{xInterval(quota?.currentPlan.intervalMinutes ?? current?.quality.intervalMinutes ?? null)}・1枠</small></span></label>
        <label className="nx-timing-option"><input type="radio" name="x-registration-timing" value="realtime" checked={draft.processingMode === "realtime"} disabled={!registrationQuote.canEnableRealtime || !selectedSupporterAvailable || processingQuoteStale} onChange={() => chooseTiming("realtime")} /><span><strong>リアルタイム</strong><small>{realtimeQuoteReady ? <>受信後すぐに通知・合計{registrationQuote.realtimeSlotCost}枠{xRealtimeBenefit(registrationQuote) ? `（${xRealtimeBenefit(registrationQuote)}）` : ""}</> : "利用資格と枠数を再確認してください"}</small></span></label>
      </fieldset> : <p role="status" className="nx-field-note">通知タイミングの確認待ち</p>}
      {current && supporterQuote?.eligible && current.poolKind !== "supporter" ? <section className="nx-supporter-action"><button type="button" className={button} disabled={busy || loading || !active || !supporterOffer || processingQuoteStale} onClick={() => {
        setDraft(previous => previous ? { ...previous, processingMode: "realtime", processingTouched: true, poolPreference: "supporter" } : previous); setReview(null);
      }}>支援者特典でリアルタイムに変更・1枠</button>{!supporterOffer ? <p role="status" className="nx-field-note">{supporterQuote.reason ?? "支援者優先枠の空きを確認してください。"}</p> : null}</section> : null}
      {newRealtime && draft.poolPreference === "supporter" && realtimeQuoteReady ? <p className="nx-slot-consent">支援者優先枠を使用・個人1枠</p> : null}
      {supporterQuote?.eligible && !supporterQuote.available || newRealtime && !selectedSupporterAvailable ? <p role="status" className="nx-field-note">{supporterQuote?.reason ?? "支援者優先枠の利用資格と空き状況を確認してください。"}</p> : null}
      {newRealtime && realtimeQuoteReady && registrationQuote?.realtimeSlotCost === 5 ? <p className="nx-slot-consent">個人枠を合計5枠使用します。通常の1枠に加えて4枠を確保します。</p> : null}
      {processingQuoteStale ? <p role="alert" className="nx-feedback">必要な枠数を再確認してください。<button type="button" className={button} disabled={busy || loading || !active} onClick={() => { setReview(null); void load(); }}>枠数を再確認</button></p> : null}
      {allowSetup ? <fieldset disabled={busy || !active} className="nx-editor-section"><legend>接続設定</legend>
        <label className="text-sm">使用する自分の受信情報<select className={field} disabled={!setup?.available || loading} value={draft.subscriptionId} onChange={event => update("subscriptionId", event.target.value)}><option value="">受信情報を選択</option>{draft.subscriptionId && !setup?.subscriptions.some(item => item.id === draft.subscriptionId) ? <option value={draft.subscriptionId} disabled>現在の受信情報（一覧を確認）</option> : null}{setup?.subscriptions.map((item, index) => <option key={item.id} value={item.id}>受信情報 {index + 1} · {xReceiverLabel(item.receiverState)}</option>)}</select></label>
        <button type="button" className={button} onClick={() => setSetupOpen(true)}>PCの通知データを登録</button>
        {setup?.nextCursor ? <button type="button" className={button} disabled={busy || loading || !active} onClick={() => void mutate(async () => { const next = parseXSetupStatus(await api(`x-setup?afterId=${encodeURIComponent(setup.nextCursor ?? "")}`)); if (mounted.current && activeRef.current) setSetup(previous => previous ? { ...next, subscriptions: [...previous.subscriptions, ...next.subscriptions.filter(item => !previous.subscriptions.some(row => row.id === item.id))] } : next); })}>受信情報の候補をさらに表示</button> : null}
      </fieldset> : null}
      <details className="nx-editor-advanced"><summary>詳細設定</summary><div className="space-y-3">
        <label className="text-sm">詳細ルール（任意）<select className={field} disabled={busy || !active} value={draft.workflowId} onChange={event => update("workflowId", event.target.value)}><option value="">未指定</option>{draft.workflowId && !rules.some(item => item.id === draft.workflowId && item.scope !== "guild") ? <option value={draft.workflowId} disabled>現在の詳細ルール（候補を確認）</option> : null}{rules.filter(item => item.scope !== "guild").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {current ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy || !active} checked={draft.enabled} onChange={event => update("enabled", event.target.checked)} />通知を有効にする</label> : null}
      </div></details>
      <footer className="notification-editor-actions">
        {review !== null ? <section aria-label="X監視の変更確認" className="nx-change-review"><p className="text-sm">{draft.accountHandle ? `Xアカウント @${draft.accountHandle}` : "このX監視"}</p>
          <dl className="monitor-facts"><div><dt>通知先</dt><dd>{destinations.find(item => item.id === draft.destinationId)?.name ?? (draft.destinationId ? "選択した通知先" : draft.workflowId ? "詳細ルールで指定" : "本人のDM")}</dd></div>{registrationQuote ? <div><dt>通知タイミング</dt><dd>{draft.processingMode === "realtime" ? "リアルタイム" : "プランの間隔"}・合計{draft.processingMode === "realtime" ? registrationQuote.realtimeSlotCost : 1}枠</dd></div> : null}</dl>
          {draft.poolPreference === "supporter" ? <p className="nx-slot-consent">支援者優先枠を使用・個人1枠</p> : null}
          {draft.workflowId ? <div className="nx-field-note"><p>詳細ルール {rules.find(rule => rule.id === draft.workflowId)?.name || "選択したルール"}・{workflowStatusLabel(workflowStatus(draft.workflowId, reviewedRule?.id === draft.workflowId ? [reviewedRule] : rules))}</p>{onOpenWorkflow ? <button type="button" className={button} onClick={() => { setEditorOpen(false); onOpenWorkflow(draft.workflowId); }}>選択したルールを開く</button> : null}</div> : null}
          {!realtimePriceConfirmed ? <p role="alert">必要な枠数が変わりました。確認し直してください。</p> : null}
          {current && draft.accountHandle !== (current.accountHandle ?? "") ? <p className="text-sm">変更後のXアカウント名：{draft.accountHandle ? `@${draft.accountHandle}` : "未設定"}</p> : null}
          {deliveryChanged ? <p className="nx-slot-consent">設定を変更すると、変更前の未送信通知を取り消します。送信開始後は取り消せない場合があります。</p> : null}
          {review !== (current?.revision ?? 0) ? <p role="alert">設定が更新されています。変更内容を確認し直してください。</p> : null}
          <div className="nx-actions"><button type="button" className="nx-primary" disabled={!canReview || review !== (current?.revision ?? 0) || !realtimePriceConfirmed} onClick={() => void save()}>このX監視設定で保存</button><button type="button" className={button} disabled={busy} onClick={() => setReview(null)}>編集に戻る</button></div>
        </section> : <button type="submit" className="nx-primary" disabled={!canReview}>{needsConfirmation ? "変更を確認" : "設定を保存"}</button>}
        <button type="button" className={button} disabled={busy} onClick={() => { setEditorOpen(false); setSetupOpen(false); }}>あとで続ける</button>
      </footer>
      </form>
      {current ? <details className="nx-editor-advanced"><summary>利用枠の種類を変更</summary><p className="nx-field-note">現在の枠 {xPoolName(liveCurrent?.poolKind ?? current.poolKind)}</p><XMonitorMoveEditor row={liveCurrent ?? current} api={api} disabled={!active || busy} onBusy={value => { action.current = value; setBusy(value); if (value) { epoch.current++; setLoading(false); } }} onReload={load} onSaved={async saved => {
        setItems(previous => previous.map(row => row.id === saved.id ? saved : row)); setDraft(previous => previous ? rebaseDraft(current, previous, saved) : previous); setEditingBaseline(saved); setRevisionConflict(false); setRebasedReview(true); setReview(null); await load();
      }} /></details> : null}
      {setupOpen ? <AutomationDialog title="Xとの接続" busy={busy} open={active} onCancel={() => setSetupOpen(false)}><XNotificationSetup api={api} active={active} initiallyOpen embedded onSubscriptionsChanged={() => { void load(); }} onChooseSubscription={subscription => {
        if (!activeRef.current || !mounted.current) return;
        chosenSubscriptions.current.set(subscription.id, subscription);
        setSetup(previous => previous ? { ...previous, subscriptions: [...previous.subscriptions.filter(item => item.id !== subscription.id), subscription] } : previous);
        setDraft(previous => previous ? { ...previous, subscriptionId: subscription.id } : previous); setReview(null); setSetupOpen(false); void load();
      }} onCancel={() => setSetupOpen(false)} /></AutomationDialog> : null}
    </AutomationDialog> : null}
    <div className="monitor-list">{items.map(item => {
      const subscription = setup?.subscriptions.find(row => row.id === item.notificationSettings.subscriptionId);
      const readiness = monitorState(readinessOf({ ...item, ...item.notificationSettings }, rules, destinations));
      const state = !item.enabled || item.state === "suspended" || item.state === "deleted" ? "停止中" : readiness.action ? readiness.label : !item.notificationSettings.subscriptionId || subscription?.receiverState === "requires_reenrollment" ? "接続設定待ち" : item.processing?.effectiveMode !== "realtime" && (item.processing ? !item.processing.configured : item.quality.intervalMinutes === null) ? "間隔設定待ち" : subscription?.receiverState === "listening" ? "受信待ち" : subscription?.receiverState === "error" ? "接続の確認待ち" : "接続待ち";
      return <article key={item.id} aria-label={`${item.name || item.accountHandle || item.accountId}のX監視`} className="monitor-card nx-monitor-card">
      <header className="nx-monitor-card-heading"><div><h3 className="font-medium">{item.name || item.accountHandle || item.accountId}</h3><p className="nx-field-note">{item.accountHandle ? `@${item.accountHandle}` : "Xアカウント"}</p></div><strong className={`nx-monitor-state${state === "停止中" ? " nx-monitor-state-muted" : ""}`}>{state}</strong></header>
      <dl className="monitor-facts"><div><dt>通知先</dt><dd>{destinations.find(destination => destination.id === item.notificationSettings.destinationId)?.name || (item.notificationSettings.destinationId ? "登録済みの通知先" : item.notificationSettings.workflowId ? "詳細ルールで指定" : "本人のDM")}</dd></div><div><dt>通知タイミング</dt><dd>{item.processing ? xTimingLabel(item.processing) : "確認待ち"}</dd></div><div><dt>使用枠</dt><dd>{item.processing ? `${item.processing.slotCost}枠` : "確認待ち"}</dd></div></dl>
      {subscription?.lastReceivedAtMs ? <p className="nx-field-note">最終受信 {new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(subscription.lastReceivedAtMs)}（接続単位）</p> : null}
      <MonitorDeliveryActivity api={api} kind="x" targetId={item.id} active={active} />
      {item.enabled && item.state === "ready" && readiness.action ? <p className="nx-field-note">{readiness.description}{readiness.action === "workflow" && onOpenWorkflow && item.notificationSettings.workflowId ? <button type="button" className={button} disabled={!active || busy} onClick={() => { setEditorOpen(false); onOpenWorkflow(item.notificationSettings.workflowId!); }}>割り当てたルールを開く</button> : null}</p> : null}
      {item.state === "suspended" ? <p className="nx-field-note">利用資格を確認してください。監視対象と通知設定は保持されています。</p> : null}
      {item.state !== "deleted" ? <div className="nx-actions"><button className={button} disabled={!active || busy || Boolean(draft && editingId !== item.id)} onClick={() => { if (!draft) { setDraft(draftOf(item)); setEditingId(item.id); setEditingBaseline(item); setRevisionConflict(false); setRebasedReview(false); setReview(null); setError(""); } setEditorOpen(true); }}>通知設定</button>
        {state === "接続設定待ち" || state === "接続待ち" || state === "接続の確認待ち" ? <button className="nx-text-link" disabled={!active || busy || Boolean(draft && editingId !== item.id)} onClick={() => { if (!draft) { setDraft(draftOf(item)); setEditingId(item.id); setEditingBaseline(item); setRevisionConflict(false); setRebasedReview(false); setReview(null); setError(""); } setEditorOpen(true); setSetupOpen(true); }}>接続を確認</button> : null}
        <details className="nx-monitor-menu"><summary>その他の操作</summary><div className="nx-actions"><button className={button} disabled={!active || busy || !item.enabled && !canResume(item)} onClick={() => void toggle(item)}>{item.enabled ? "X監視を停止" : "X監視を再開"}</button><button className={`${button} text-destructive`} disabled={!active || busy} onClick={() => setDeleting(item.id)}>X監視を削除</button></div></details>
      </div> : null}
      <details className="nx-field-note"><summary>登録情報の詳細</summary>{item.accountId !== null ? <p>XアカウントID：{item.accountId}</p> : null}<p>利用枠 {xPoolName(item.poolKind)}</p><p>送信上限 1分{item.quality.minuteLimit}通／1日{item.quality.dayLimit}通</p></details>
      {deleting === item.id ? <AutomationDialog title="X監視を削除" open={active} busy={busy} onCancel={() => setDeleting(null)} error={error || undefined}><p>このX監視の登録を削除して利用枠を解放します。</p><footer className="notification-editor-actions"><button className={`${button} text-destructive`} disabled={!active || busy} onClick={() => void mutate(async () => {
        await api(`x-monitors/${encodeURIComponent(item.id)}`, "DELETE", { expectedRevision: item.revision });
        if (!mounted.current) return; setItems(previous => previous.filter(row => row.id !== item.id)); setDeleting(null); if (editingId === item.id) { setDraft(null); setEditingId(null); setEditingBaseline(null); setRevisionConflict(false); setRebasedReview(false); }
        setNotice("X監視を削除しました。"); await load();
      })}>このX監視を削除</button></footer></AutomationDialog> : null}
    </article>; })}</div>
    {!loading && !readError && items.length === 0 ? <p role="status" className="text-sm">登録済みのX監視はありません。</p> : null}
  </div>;
}

export function XMonitorManager({ api, active = true, allowSetup = true, destinations = [], rules = [], onAddDestination, onOpenWorkflow, initiallyOpen = false, setupPlacement = "full", registrationRequest, hideAddAction = false }: { api: XMonitorAPI; active?: boolean; allowSetup?: boolean; destinations?: Choice[]; rules?: Choice[]; onAddDestination?: AddDestination; onOpenWorkflow?: (id: string) => void; initiallyOpen?: boolean; setupPlacement?: "full" | "compact"; registrationRequest?: RegistrationRequest; hideAddAction?: boolean }) {
  const [opened, setOpened] = useState(initiallyOpen), [subscriptionsVersion, setSubscriptionsVersion] = useState(0);
  useEffect(() => { if (active && registrationRequest) setOpened(true); }, [active, registrationRequest]);
  const compact = setupPlacement === "compact";
  return <section aria-label="Xアカウントの監視" className="notification-x nx-monitor-panel"><header className="nx-section-heading"><h2>監視するアカウント</h2></header>
    {!opened ? <button className={button} disabled={!active} onClick={() => setOpened(true)}>Xアカウントの監視を管理</button> : <>{!compact ? allowSetup ? <><XNotificationSetup api={api} active={active} onSubscriptionsChanged={() => setSubscriptionsVersion(value => value + 1)} /><details className="nx-editor-advanced"><summary>共通の初期設定</summary><XProcessingSettings api={api} active={active} /></details></> : <a href="/dashboard/automation/x" className="inline-block text-sm text-primary underline">自分のX通知セットアップを開く</a> : null}<XMonitorEditor api={api} active={active} allowSetup={allowSetup} subscriptionsVersion={subscriptionsVersion} destinations={destinations} rules={rules} onAddDestination={onAddDestination} onOpenWorkflow={onOpenWorkflow} compact={compact} registrationRequest={registrationRequest} hideAddAction={hideAddAction} /></>}
  </section>;
}
