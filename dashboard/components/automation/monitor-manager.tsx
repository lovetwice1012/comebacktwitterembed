"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Info, LockKeyhole } from "lucide-react";
import { valueLabels } from "./rule-labels";
import { AutomationDialog } from "./automation-dialog";
import { MonitorRegistration } from "./monitor-registration";
import { sourceProvider, monitorState } from "../../../src/automation/monitor-input";
import { automationPlanName } from "./automation-feedback";
import { MonitorCadenceEditor } from "./monitor-cadence-editor";
import { XMonitorManager } from "./x-monitor-manager";
import { DestinationEditor } from "./destination-editor";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
type Props = { api: (path: string, method?: string, body?: any) => Promise<any>; guildId?: string; canEdit: boolean; scope: string; destinations: any[]; rules: any[]; refresh: () => Promise<void>; refreshDestination?: (id: string) => Promise<void>; active?: boolean };
type DestinationOrigin = { kind: "normal"; monitor: any } | { kind: "x"; onCreated?: (id: string) => void };
const newMonitor = (kind: string) => ({ kind, name: "", providerId: kind === "auto" ? "youtube" : "amazon", source: "", locale: "ja", destinationId: "", enabled: true, mode: "change", maxPriceAmount: "", minDiscountPercent: "", workflowId: "" });
type NotificationProfile = { plan: { id: string; tier: string; name: string; priority: number; slotLimit: number; minuteLimit: number; dayLimit: number }; slots: { used: number; max: number; available: number }; usage: { entries: { targetKind: string; targetId: string; todayUsed: number; todayReserved: number; dayLimit: number; minuteLimit: number; resetAtMs: number; allowed?: boolean }[] } };
function receiveSummary(row: any) {
  if (row.kind === "auto") return "新しい投稿を通知";
  if (row.mode === "change") return "価格の変化を通知";
  return [row.maxPriceAmount != null && `価格が${row.maxPriceAmount}以下`, row.minDiscountPercent != null && `割引率が${row.minDiscountPercent}%以上`].filter(Boolean).join(" または ");
}

export function MonitorManager({ api, guildId, canEdit, scope, destinations, rules, refresh, refreshDestination, active = true }: Props) {
  const [kind, setKind] = useState("auto"), [items, setItems] = useState<any[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<any>(null), [monitor, setMonitor] = useState<any>(null), [dest, setDest] = useState<any>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [monitorOpen, setMonitorOpen] = useState(false), [destOpen, setDestOpen] = useState(false);
  const [query, setQuery] = useState(""), [state, setState] = useState("all"), [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<NotificationProfile | null>(null), [profileError, setProfileError] = useState("");
  const visible = items;
  const filtered = !!query.trim() || state !== "all";
  const requestEpoch = useRef(0);
  const profileEpoch = useRef(0);
  const cadenceDrafts = useRef(new Map<string, string>());
  const destinationSaving = useRef(false);
  const destinationOrigin = useRef<DestinationOrigin | null>(null), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; destinationOrigin.current = null; }; }, []);
  const kindRef = useRef(kind); kindRef.current = kind;
  const activeRef = useRef(active); activeRef.current = active;
  const editable = (row: any) => row?.scope !== "guild" || canEdit;
  const autoRegistrationAllowed = catalog?.autoRegistration?.eligible === true;
  const loadProfile = useCallback(async () => {
    if (!activeRef.current) return;
    const epoch = ++profileEpoch.current;
    try {
      const result = await api("entitlements");
      if (!activeRef.current || epoch !== profileEpoch.current) return;
      setProfile(result); setProfileError("");
    } catch {
      if (activeRef.current && epoch === profileEpoch.current) setProfileError("利用枠を確認できません。［更新］で再確認してください。");
    }
  }, [api]);
  function begin() {
    if (monitor) { setKind(monitor.kind || kind); setMonitorOpen(true); return; }
    const destination = destinations.find(d => d.enabled && (scope !== "guild" || d.scope === "guild"));
    setMonitor({ ...newMonitor(kind), scope, destinationId: destination?.id || "" });
    setMonitorOpen(true);
  }
  function beginDestination(onCreated?: (id: string) => void) {
    destinationOrigin.current = onCreated ? { kind: "x", onCreated } : { kind: "normal", monitor };
    setError(""); setDestOpen(true);
    if (!dest) setDest({ name: "", kind: "dm", scope: "private", guildId: guildId || "", webhookUrl: "", channelId: "", enabled: true });
  }
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
        if (!dest.id && mounted.current && activeRef.current && origin && destinationOrigin.current === origin) {
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
    const nextKind = providerId ? ["amazon", "steam"].includes(providerId) ? "price" : "auto" : kind;
    if (providerId && !catalog?.[nextKind]?.some((p: any) => p.id === providerId)) { setMonitor({ ...monitor, source }); setError(`${valueLabels[providerId] || providerId}は対象外です。対応サービスのURLを入力してください。`); return; }
    if (monitor.id && nextKind !== kind) { setMonitor({ ...monitor, source }); setError("通知の種類は変更できません。別の通知を追加してください。"); return; }
    setKind(nextKind);
    setMonitor({ ...monitor, source, kind: nextKind, providerId: providerId || monitor.providerId });
  }
  const task = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e: any) { setError(e.message); if (e.code === "AUTOMATION_SLOT_LIMIT") void loadProfile(); } finally { setBusy(false); } };
  async function load(selectedKind = kind, afterId?: string) {
    if (!activeRef.current) return;
    const epoch = ++requestEpoch.current;
    if (!afterId) setLoading(true);
    const search = new URLSearchParams({ query, state, ...(afterId ? { afterId } : {}) });
    try {
      const result = await api(`monitors/${selectedKind}?${search}`);
      if (!activeRef.current || epoch !== requestEpoch.current) return;
      setItems(old => afterId ? [...old, ...result.items] : result.items); setCursor(result.nextCursor);
      void loadProfile();
    } catch (error) { if (activeRef.current && epoch === requestEpoch.current) throw error;
    } finally { if (activeRef.current && epoch === requestEpoch.current) setLoading(false); }
  }
  useEffect(() => { let alive = true; api("providers").then(providers => { if (alive) setCatalog(providers); }).catch(e => alive && setError(e.message)); return () => { alive = false; }; }, [api]);
  useEffect(() => { if (active) void loadProfile(); return () => { profileEpoch.current++; }; }, [loadProfile, active]);
  useEffect(() => {
    if (!active) { requestEpoch.current++; return; }
    let alive = true; const epoch = ++requestEpoch.current; setLoading(true); setError("");
    setNotice("");
    const timer = setTimeout(() => { const search = new URLSearchParams({ query, state });
      api(`monitors/${kind}?${search}`).then(result => { if (alive && epoch === requestEpoch.current) { setItems(result.items); setCursor(result.nextCursor); } })
        .catch(e => alive && epoch === requestEpoch.current && setError(e.message)).finally(() => alive && epoch === requestEpoch.current && setLoading(false));
    }, query ? 250 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [api, kind, query, state, active, rules]);
  async function saveMonitor(current = monitor) {
    const monitor = current;
    const input = { ...monitor, name: monitor.name.trim() || monitor.source.trim().slice(0, 120), scope: monitor.scope || scope, expectedRevision: monitor.revision,
      maxPriceAmount: monitor.maxPriceAmount === "" ? null : monitor.maxPriceAmount,
      minDiscountPercent: monitor.minDiscountPercent === "" ? null : monitor.minDiscountPercent };
    const result = await api(`monitors/${kind}${monitor.id ? `/${monitor.id}` : ""}`, monitor.id ? "PATCH" : "POST", input);
    // The target is persisted first. If the optional rule assignment fails, show
    // its saved ID and let the user retry the assignment, not duplicate creation.
    const saved = { ...monitor, id: result.id, revision: result.revision, scope: input.scope };
    setMonitor(saved);
    await load();
    try {
      if (monitor.workflowId) await api(`workflows/${monitor.workflowId}/attach`, "POST", { targetKind: kind, targetId: result.id });
      else if (monitor.id) await api(`monitors/${kind}/${result.id}`, "POST", { action: "detach", expectedRevision: result.revision });
    } catch { throw new Error("通知は保存済みです。詳細ルールを割り当てるには、もう一度保存してください。"); }
    await load(); setMonitor(null); setMonitorOpen(false); setNotice(kind === "auto" ? "新着通知を保存しました。" : "価格通知を保存しました。");
  }
  async function reloadCadence(id: string) {
    if (!activeRef.current || kindRef.current !== "auto") return null;
    const epoch = ++requestEpoch.current;
    const result = await api(`monitors/auto?${new URLSearchParams({ query, state })}`);
    if (!activeRef.current || epoch !== requestEpoch.current || kindRef.current !== "auto") return null;
    setItems(result.items); setCursor(result.nextCursor); await loadProfile();
    return result.items.find((row: any) => row.id === id) ?? null;
  }
  return <div className="monitor-workspace space-y-5">
    {error && !monitorOpen && !destOpen && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error}</p>}{notice && <p role="status" className="rounded border p-3 text-sm">{notice}</p>}
    <section className="space-y-4">
      {monitor && !monitorOpen && <div role="status" className="automation-draft-banner"><span>通知の入力を保持しています</span><button className={button} onClick={() => { setKind(monitor.kind || kind); setMonitorOpen(true); }}>通知の入力を再開</button><button className={button} onClick={() => { if (confirm("通知の入力を破棄しますか？")) setMonitor(null); }}>通知の入力を破棄</button></div>}
      <div className="monitor-overview"><h2>通知一覧</h2></div>
      {profileError ? <p role="status" className="text-xs text-muted-foreground">{profileError}</p> : profile?.plan && profile.slots && <p role="status" className="text-sm text-muted-foreground">{automationPlanName(profile.plan.name) || "現在のプラン"} · 通知枠 {profile.slots.used} / {profile.slots.max}（残り{profile.slots.available}枠）<br />1枠あたり1日{profile.plan.dayLimit}通・1分{profile.plan.minuteLimit}通まで{profile.plan.priority > 0 ? " · 優先処理" : ""}<span className="block text-xs">新着・価格の合計枠です。確認間隔に配分した追加枠も含みます。停止中の登録も枠に含みます。実際に送信したメッセージ1件＝1通。日ごとの上限は日本時間の0時にリセットします。</span></p>}
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex gap-1" aria-label="通知の種類">{[["auto", "新着"], ["price", "価格"]].map(([id, label]) => <button key={id} className={button} aria-pressed={kind === id} disabled={busy || monitorOpen} onClick={() => setKind(id)}>{label}</button>)}</div><div className="flex gap-2"><button className="rounded border bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40" disabled={busy || monitorOpen || scope === "guild" && !canEdit || kind === "auto" && !autoRegistrationAllowed} onClick={begin}>通知を追加</button><button className={button} disabled={busy} onClick={() => void task(() => load())}>更新</button></div></div>
      {scope === "guild" && !canEdit && <p className="automation-critical-note"><LockKeyhole size={16} aria-hidden="true" />通知の変更にはサーバーの編集権限が必要です。</p>}
      {kind === "auto" && catalog && !autoRegistrationAllowed && <p role="status" className="automation-critical-note"><LockKeyhole size={16} aria-hidden="true" />現在は新着通知を追加・再開できません。利用枠と通知の状態を確認してください。</p>}
      <div className="monitor-toolbar"><label className="monitor-search">通知を検索<input type="search" className={field} placeholder="名前・サービス・URLで検索" value={query} onChange={e => setQuery(e.target.value)} /></label><label>状態<select className={field} value={state} onChange={e => setState(e.target.value)}><option value="all">すべて</option><option value="active">監視中</option><option value="attention">確認・待機が必要</option><option value="paused">停止中</option></select></label></div>
      {loading && <p role="status">通知を読み込んでいます…</p>}
      {!loading && visible.length > 0 && <p role="status" className="text-xs text-muted-foreground">{visible.length}件</p>}
      <div className="monitor-list">{!loading && visible.map(row => <article key={row.id} className="monitor-card space-y-3"><div className="monitor-card-heading"><h3 className="font-medium break-all">{row.name}</h3><span className="monitor-state" data-state={monitorState(row).id}>{monitorState(row).label}</span></div>
        <p className="text-sm">{receiveSummary({ ...row, kind })}</p><div className="monitor-source"><div><span>{valueLabels[row.providerId] || row.providerId}</span><span>{row.scope === "guild" ? "サーバー共有" : "自分用"}</span></div><a href={row.source} target="_blank" rel="noreferrer">{row.source}</a></div>
        {!profileError && profile?.usage?.entries?.filter(entry => entry.targetKind === kind && entry.targetId === row.id).map(entry => <div key={`${entry.targetKind}:${entry.targetId}`}><p className="text-xs text-muted-foreground">今日の送信 {entry.todayUsed} / {entry.dayLimit}通{entry.todayReserved > 0 ? ` · 予約・確認待ち ${entry.todayReserved}通` : ""} · 1分{entry.minuteLimit}通まで</p>{entry.allowed === false && <p className="automation-critical-note text-xs">この通知は現在のプランの登録枠を超えています。不要な通知を削除して利用枠を確認してください。</p>}</div>)}
        {kind === "auto" && row.canAllocateCadence === true ? <MonitorCadenceEditor row={row} pool={profileError ? null : profile?.slots ?? null} api={api} disabled={busy || !active || !editable(row)} draftValue={cadenceDrafts.current.get(row.id)} onDraft={value => cadenceDrafts.current.set(row.id, value)} onReload={() => reloadCadence(row.id)} /> : null}
        <dl className="monitor-facts"><div><dt>通知先</dt><dd>{destinations.find(d => d.id === row.destinationId)?.name || (row.destinationType === "dm" ? "本人のDM" : "登録済みチャンネル")}</dd></div><div><dt>次回確認</dt><dd>{!row.enabled ? "停止中" : row.nextCheckAtMs ? new Date(row.nextCheckAtMs).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "調整中"}</dd></div></dl>
        <details className="text-xs text-muted-foreground"><summary>確認履歴・詳細ルール</summary><dl className="monitor-facts mt-2"><div><dt>前回確認</dt><dd>{row.lastCheckedAtMs ? new Date(row.lastCheckedAtMs).toLocaleString() : "未確認"}</dd></div>{row.intervalMinutes != null && <div><dt>確認間隔</dt><dd>{row.intervalMinutes}分</dd></div>}<div><dt>詳細ルール</dt><dd>{rules.find(r => r.id === row.workflowId)?.name || (row.workflowId ? "割り当てあり" : "通常の通知")}</dd></div></dl></details>
        {monitorState(row).id === "error" && <p className="automation-critical-note"><Info size={16} aria-hidden="true" />{/INVALID_CURSOR/.test(row.errorCode) ? "監視履歴の復旧が必要です。" : /NOT_FOUND/.test(row.errorCode) ? "URLと公開状態を確認してください。" : "取得に失敗しました。次回の確認で再試行します。"}</p>}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !editable(row)} onClick={() => { if (monitor && !confirm("保持中の通知の入力を破棄して、別の通知を編集しますか？")) return; setMonitorOpen(true); setMonitor({ ...row, maxPriceAmount: row.maxPriceAmount ?? "", minDiscountPercent: row.minDiscountPercent ?? "", destinationId: row.destinationId || "", workflowId: row.workflowId || "" }); }}>編集</button>
          <button className={button} disabled={busy || !editable(row) || kind === "auto" && !row.enabled && !autoRegistrationAllowed} onClick={() => void task(async () => { await api(`monitors/${kind}/${row.id}`, "PATCH", { expectedRevision: row.revision, enabled: !row.enabled }); await load(); })}>{row.enabled ? "停止" : "再開"}</button>
          <button className={`${button} text-destructive`} disabled={busy || !editable(row)} onClick={() => { if (confirm(`「${row.name}」を削除しますか？未送信の通知も取り消します。`)) void task(async () => { await api(`monitors/${kind}/${row.id}`, "DELETE", { expectedRevision: row.revision }); if (monitor?.id === row.id) setMonitor(null); await load(); }); }}>削除</button></div>
      </article>)}</div>{!loading && !error && visible.length === 0 && <div className="monitor-empty"><p role="status">{filtered ? "検索結果は0件です" : "登録した通知は0件です"}</p>{filtered && <button className={button} onClick={() => { setQuery(""); setState("all"); }}>検索条件をクリア</button>}</div>}{cursor && <button className={button} disabled={busy} onClick={() => void task(() => load(kind, cursor))}>続きを読み込む</button>}
      {monitor && <AutomationDialog title={monitor.id ? "通知を編集" : "通知を追加"} busy={busy} error={error} open={monitorOpen} onCancel={() => { setMonitorOpen(false); setError(""); }}>
        <MonitorRegistration api={api} monitor={monitor} kind={kind} scope={scope} guildId={guildId} destinations={destinations} rules={rules} catalog={catalog} busy={busy} onChange={setMonitor} onSourceChange={changeSource} onSave={saveMonitor} run={task} refresh={refresh} />
      </AutomationDialog>}
    </section>
    <details className="space-y-3 rounded border bg-card p-4"><summary className="font-semibold">通知先</summary>
      {dest && !destOpen && <div role="status" className="automation-draft-banner"><span>通知先の入力を保持しています</span><button className={button} onClick={() => setDestOpen(true)}>通知先の入力を再開</button><button className={button} onClick={() => { if (confirm("通知先の入力を破棄しますか？")) setDest(null); }}>通知先の入力を破棄</button></div>}
      <button className={button} disabled={busy} onClick={() => beginDestination()}>通知先を追加</button>
      <div className="grid gap-2 md:grid-cols-2">{destinations.map(d => <div key={d.id} className="rounded border p-3"><h3 className="text-sm font-medium">{d.name}</h3><div className="automation-meta"><span>{d.kind === "dm" ? "DM" : d.createdByBot ? "チャンネル" : "Webhook"}</span><span>{d.enabled ? "有効" : "停止中"}</span></div><div className="mt-2 flex gap-2"><button className={button} disabled={busy || !editable(d)} onClick={() => { if (dest && !confirm("保持中の通知先の入力を破棄しますか？")) return; setDestOpen(true); setDest({ ...d, webhookUrl: "" }); }}>名前・状態を編集</button><button className={button} disabled={busy || !editable(d)} onClick={() => { if (confirm("この通知先を削除しますか？割り当て済みの通知は送信できなくなります。")) void task(async () => { await api(`destinations/${d.id}`, "DELETE", { expectedRevision: d.revision }); await refresh(); }); }}>削除</button></div></div>)}</div>
    </details>
      {dest && <AutomationDialog title={dest.id ? "通知先を編集" : "通知先を追加"} busy={busy} error={error} open={destOpen} onCancel={cancelDestination}><DestinationEditor api={api} draft={dest} onChange={setDest} guildId={guildId} scope={scope} canEdit={canEdit} busy={busy} open={destOpen} onSave={() => void saveDestination()} /></AutomationDialog>}
    {scope === "private" ? <XMonitorManager api={api} active={active} allowSetup={!guildId} destinations={destinations} rules={rules} onAddDestination={beginDestination} /> : null}
  </div>;
}
