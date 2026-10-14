"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseXMonitor, parseXQuota, xFeedback, xInterval, xObject, xPoolName, xReason, type XMonitor, type XMonitorAPI, type XMonitorQuota } from "./x-monitor-view";
import { XMonitorMoveEditor } from "./x-monitor-move-editor";
import { XNotificationSetup } from "./x-notification-setup";
import { XProcessingSettings } from "./x-processing-settings";
import { parseXSetupStatus, xReceiverLabel, xReceiverDescription, type XSetupStatus } from "./x-setup-view";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
type Choice = { id: string; name: string; enabled?: boolean; scope?: string };
type Draft = { accountHandle: string; name: string; enabled: boolean; destinationId: string; workflowId: string; subscriptionId: string };
const draftOf = (item?: XMonitor): Draft => ({ accountHandle: item?.accountHandle ?? "", name: item?.name ?? "", enabled: item?.enabled ?? true,
  destinationId: item?.notificationSettings.destinationId ?? "", workflowId: item?.notificationSettings.workflowId ?? "", subscriptionId: item?.notificationSettings.subscriptionId ?? "" });

function XMonitorEditor({ api, active, allowSetup, subscriptionsVersion, destinations, rules }: { api: XMonitorAPI; active: boolean; allowSetup: boolean; subscriptionsVersion: number; destinations: Choice[]; rules: Choice[] }) {
  const [items, setItems] = useState<XMonitor[]>([]), [quota, setQuota] = useState<XMonitorQuota | null>(null);
  const [setup, setSetup] = useState<XSetupStatus | null>(null), [setupError, setSetupError] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [readError, setReadError] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null), [editingId, setEditingId] = useState<string | null>(null), [review, setReview] = useState<number | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  const mounted = useRef(false), activeRef = useRef(active), epoch = useRef(0), action = useRef(false);
  activeRef.current = active;
  const current = items.find(item => item.id === editingId);
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
      try { if (results[2].status !== "fulfilled") throw new Error("Unavailable setup metadata"); setSetup(parseXSetupStatus(results[2].value)); setSetupError(""); }
      catch { setSetup(null); setSetupError("受信情報の候補をもう一度読み込んでください。「X一覧・利用枠を更新」から再試行できます。"); }
    } else { setSetup(null); setSetupError(""); }
    setQuota(nextQuota);
    if (nextQuota === null) setReadError(previous => previous || "現在のプランと利用枠を読み直してください。取得済みの監視は停止・削除できます。追加・再開は、利用枠を確認してから行えます。");
    setLoading(false);
    return listLoaded;
  }, [api, allowSetup]);
  useEffect(() => { mounted.current = true; if (active) void load(); return () => { mounted.current = false; epoch.current++; }; }, [load, active, subscriptionsVersion]);
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { if (!action.current) { setDraft(previous => previous ? { ...previous, [key]: value } : previous); setReview(null); setNotice(""); } }
  async function mutate(work: () => Promise<void>) {
    if (action.current || !activeRef.current) return;
    action.current = true; epoch.current++; setLoading(false); setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (cause) { if (mounted.current) { setReview(null); setError(xFeedback(cause)); } }
    finally { action.current = false; if (mounted.current) setBusy(false); }
  }
  const validSubscription = !draft?.subscriptionId || draft.subscriptionId === current?.notificationSettings.subscriptionId || Boolean(setup?.available && setup.subscriptions.some(item => item.id === draft.subscriptionId));
  const requiresHandle = !current || current.accountId === null;
  const validHandle = Boolean(draft && /^[A-Za-z0-9_]{1,15}$/u.test(draft.accountHandle) && !["i", "intent"].includes(draft.accountHandle.toLowerCase()));
  const valid = Boolean(draft && validSubscription && (validHandle || !requiresHandle && !draft.accountHandle) && draft.name.length <= 120 && (!current || draft.name.trim().length > 0));
  const resumes = Boolean(current && draft?.enabled && !current.enabled);
  const canReview = valid && !busy && !loading && active && (editingId ? Boolean(current) && (!resumes || Boolean(current && canResume(current))) : canRegister);
  async function save() {
    if (!draft || !canReview || review === null || review !== (current?.revision ?? 0)) return;
    const settings = { ...(draft.destinationId ? { destinationId: draft.destinationId } : {}), ...(draft.workflowId ? { workflowId: draft.workflowId } : {}), ...(draft.subscriptionId ? { subscriptionId: draft.subscriptionId } : {}) };
    const body = current ? { expectedRevision: current.revision, name: draft.name.trim(),
      ...(draft.accountHandle !== (current.accountHandle ?? "") ? { accountHandle: draft.accountHandle || null } : {}),
      ...(draft.enabled !== current.enabled ? { enabled: draft.enabled } : {}),
      ...(settings.workflowId !== current.notificationSettings.workflowId || settings.destinationId !== current.notificationSettings.destinationId || settings.subscriptionId !== current.notificationSettings.subscriptionId ? { notificationSettings: settings } : {}) }
      : { accountHandle: draft.accountHandle, ...(draft.name.trim() ? { name: draft.name.trim() } : {}), ...(Object.keys(settings).length ? { notificationSettings: settings } : {}) };
    await mutate(async () => {
      const response = xObject(await api(current ? `x-monitors/${encodeURIComponent(current.id)}` : "x-monitors", current ? "PATCH" : "POST", body));
      const saved = parseXMonitor(response.item ?? response);
      if (!mounted.current) return;
      setItems(previous => [...previous.filter(item => item.id !== saved.id), saved]); setDraft(null); setEditingId(null); setReview(null);
      setNotice(saved.notificationSettings.subscriptionId ? "X監視の設定を保存しました。次に、サーバーの接続状態と、通知先への到着を確認してください。" : "X監視の設定を保存しました。次に、通知を受け取るための受信情報を登録し、この監視で使う情報を選んでください。"); await load();
    });
  }
  async function toggle(item: XMonitor) {
    if (item.enabled || canResume(item)) await mutate(async () => {
      const response = xObject(await api(`x-monitors/${encodeURIComponent(item.id)}`, "PATCH", { expectedRevision: item.revision, enabled: !item.enabled }));
      const saved = parseXMonitor(response.item ?? response);
      if (!mounted.current) return;
      setItems(previous => previous.map(row => row.id === saved.id ? saved : row)); setNotice(item.enabled ? "X監視を停止しました。" : "X監視を再開しました。"); await load();
    });
  }
  return <div className="space-y-4">
    {setup?.rollout.mode === "supporters" ? <p role="status" className="rounded border bg-muted/30 p-3 text-sm">現在は、受付対象となっている既存の寄付者の方にご案内しています。{setup.rollout.eligible ? "このアカウントでお申し込みいただけます。" : "受付対象の拡大をお待ちください。"}寄付は活動への支援として受け付け、参加資格と利用枠は別に確認します。</p> : null}
    {setup?.rollout.mode === "disabled" && quota?.x.reasonCode !== "X_ROLLOUT_DISABLED" ? <p role="status" className="text-sm">{xReason("X_ROLLOUT_DISABLED")}</p> : null}
    {quota ? <section aria-label="X監視の個人利用枠" className="space-y-2 rounded border bg-muted/30 p-4 text-sm">
      <p className="font-medium">現在のプラン: {quota.currentPlan.label}</p>
      <dl className="grid gap-2 sm:grid-cols-2"><div><dt>個人の総登録上限</dt><dd>{quota.personal.totalLimit}枠（基本{quota.currentPlan.baseSlotLimit}＋支援追加{quota.personal.supporterExtraSlots}）</dd></div>
        <div><dt>現在の登録数</dt><dd>{quota.personal.registeredCount === null ? "件数未取得" : `${quota.personal.registeredCount}件`}</dd></div>
        <div><dt>現在の使用枠</dt><dd>{quota.personal.used}／{quota.personal.totalLimit}枠（空き{quota.personal.available}枠）</dd></div><div><dt>支援者追加枠の保有数</dt><dd>{quota.personal.supporterExtraSlots}枠</dd></div>
        <div><dt>X監視の利用数・空き枠</dt><dd>{quota.x.used}件／空き{quota.x.available}件</dd></div><div><dt>無料共有枠の全体空き</dt><dd>{quota.pools.free.available}／{quota.pools.free.limit}枠</dd></div>
        <div><dt>現在プランの確認間隔</dt><dd>{xInterval(quota.currentPlan.intervalMinutes)}</dd></div></dl>
      <p className="text-xs text-muted-foreground">監視するXアカウント1件につき1枠を使います。通常通知とX監視は、同じ個人の登録上限で数えます。寄付へのお礼で付与された追加枠は、月額プランの解約後も引き継ぎます。申込資格と全体枠の空きは、それぞれ確認します。</p>
      <p className="text-xs text-muted-foreground">確認間隔の短縮に配分した追加枠も使用枠数に含みます。登録件数とは別に数えます。</p>
      <p className="text-xs text-muted-foreground">標準の設定では、受信を開始すると通知を随時受け取り、現在のプランの間隔ごとに、届いた分をまとめて処理します。リアルタイムを選択して保存すると、受け取り次第処理します。通知先への送信には、ルールの条件と送信上限を適用します。</p>
      <p className="text-xs text-muted-foreground">確認間隔と送信上限には、現在の契約プランを適用します。どの種類の枠でも、1分{quota.currentPlan.minuteLimit}通・1日{quota.currentPlan.dayLimit}通までです。</p>
      {!quota.featureEnabled && !quota.x.reasonCode?.startsWith("X_ROLLOUT_") ? <p role="status">{xReason("X_MONITOR_UNAVAILABLE")}</p> : null}
      {quota.x.reasonCode && (quota.featureEnabled || quota.x.reasonCode !== "X_MONITOR_UNAVAILABLE") ? <p role="status">{xReason(quota.x.reasonCode)}</p> : null}
    </section> : null}
    {readError ? <p role="alert" className="text-sm text-destructive">{readError}</p> : null}{setupError ? <p role="alert" className="text-sm text-destructive">{setupError}</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{notice ? <p role="status" className="text-sm">{notice}</p> : null}
    <div className="flex flex-wrap gap-2"><button className={button} disabled={!active || busy || loading || !canRegister} onClick={() => { if (!draft) { setDraft(draftOf()); setEditingId(null); } }}>X監視を追加</button>
      <button className={button} disabled={!active || busy || loading} onClick={() => { setReview(null); void load(); }}>X一覧・利用枠を更新</button></div>
    {loading ? <p role="status" className="text-sm">X監視を読み込み中…</p> : null}
    {draft ? <form aria-label="X監視の登録設定" className="space-y-3 rounded border p-4" noValidate onSubmit={event => { event.preventDefault(); if (canReview) { setReview(current?.revision ?? 0); setError(""); } }}>
      <fieldset disabled={busy || !active} className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Xアカウント名（@ユーザー名）{requiresHandle ? "・必須" : ""}<input className={field} required={requiresHandle} maxLength={16} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="@example" value={draft.accountHandle} onChange={event => update("accountHandle", event.target.value.replace(/^@/u, ""))} /></label>
        <label className="text-sm">監視の表示名（任意）<input className={field} maxLength={120} value={draft.name} onChange={event => update("name", event.target.value)} /></label>
        <label className="text-sm">通知先（任意）<select className={field} value={draft.destinationId} onChange={event => update("destinationId", event.target.value)}><option value="">未指定</option>{draft.destinationId && !destinations.some(item => item.id === draft.destinationId && item.enabled !== false && item.scope !== "guild") ? <option value={draft.destinationId} disabled>現在の通知先（候補を確認）</option> : null}{destinations.filter(item => item.enabled !== false && item.scope !== "guild").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="text-sm">詳細ルール（任意）<select className={field} value={draft.workflowId} onChange={event => update("workflowId", event.target.value)}><option value="">未指定</option>{draft.workflowId && !rules.some(item => item.id === draft.workflowId && item.scope !== "guild") ? <option value={draft.workflowId} disabled>現在の詳細ルール（候補を確認）</option> : null}{rules.filter(item => item.scope !== "guild").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {allowSetup ? <label className="text-sm">使用する自分の受信情報<select className={field} disabled={!setup?.available || loading} value={draft.subscriptionId} onChange={event => update("subscriptionId", event.target.value)}><option value="">受信情報を選択（受信の開始には設定が必要）</option>{draft.subscriptionId && !setup?.subscriptions.some(item => item.id === draft.subscriptionId) ? <option value={draft.subscriptionId} disabled>現在の受信情報（一覧を確認）</option> : null}{setup?.subscriptions.map((item, index) => <option key={item.id} value={item.id}>受信情報 {index + 1} · Firefox {item.browserVersion} · {xReceiverLabel(item.receiverState)}</option>)}</select></label> : null}
        {current ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => update("enabled", event.target.checked)} />X監視を有効にする</label> : null}
      </fieldset>
      <p className="text-xs text-muted-foreground">Xのプロフィールに表示される@ユーザー名を入力すると登録できます。先頭の@は、付けても付けなくても入力できます。</p>
      <p className="text-xs text-muted-foreground">Xから届く投稿通知は、「Xアカウント名」の@ユーザー名で監視対象と照合します。通知を受け取りたいアカウントの現在のユーザー名を入力してください。登録後も、この欄から変更できます。</p>
      {allowSetup ? <div className="space-y-2 text-sm"><p>1つの受信情報を複数の監視対象に割り当てられます。専用FirefoxのXで各対象のベルを有効にしてください。監視するアカウントごとの利用枠は別です。</p>{!draft.subscriptionId ? <p role="status">通知を受け取る準備として、下のリンクから受信情報を登録し、この監視で使う情報を選んでください。</p> : null}{setup && setup.subscriptions.length === 0 ? <p>先に受信情報を登録し、この一覧を更新して割り当ててください。</p> : null}<a href="/dashboard/automation/x" className="inline-block text-primary underline">X通知の受信情報を登録・確認する</a>{setup?.nextCursor ? <button type="button" className={button} disabled={busy || loading || !active} onClick={() => void mutate(async () => { const next = parseXSetupStatus(await api(`x-setup?afterId=${encodeURIComponent(setup.nextCursor ?? "")}`)); if (mounted.current && activeRef.current) setSetup(previous => previous ? { ...next, subscriptions: [...previous.subscriptions, ...next.subscriptions.filter(item => !previous.subscriptions.some(row => row.id === item.id))] } : next); })}>受信情報の候補をさらに表示</button> : null}</div> : <p className="text-sm">受信情報の登録・割り当ては個人ページで確認してください。<a href="/dashboard/automation" className="text-primary underline">個人の通知一覧を開く</a></p>}
      {review !== null ? <section aria-label="X監視の変更確認" className="space-y-2 rounded border bg-muted/30 p-3"><p className="text-sm">{draft.accountHandle ? `Xアカウント @${draft.accountHandle}` : "このX監視"} の登録設定を保存します。{current ? "現在の利用枠と、変更していない通知設定・受信情報を引き継ぎます。" : "利用枠の割当はサーバーで確認します。"}</p>
        {current && draft.accountHandle !== (current.accountHandle ?? "") ? <p className="text-sm">変更後のXアカウント名：{draft.accountHandle ? `@${draft.accountHandle}` : "未設定"}</p> : null}
        {review !== (current?.revision ?? 0) ? <p role="alert" className="text-sm text-destructive">監視の設定が更新されています。変更内容を確認し直してください。</p> : null}
        <button type="button" className={button} disabled={!canReview || review !== (current?.revision ?? 0)} onClick={() => void save()}>このX監視設定で保存</button><button type="button" className={button} disabled={busy} onClick={() => setReview(null)}>X監視の編集に戻る</button>
      </section> : <button type="submit" className={button} disabled={!canReview}>X監視の変更を確認</button>}
      <button type="button" className={button} disabled={busy} onClick={() => { setDraft(null); setEditingId(null); setReview(null); }}>X監視の入力を取り消す</button>
    </form> : null}
    <div className="monitor-list">{items.map(item => <article key={item.id} aria-label={`${item.name || item.accountHandle || item.accountId}のX監視`} className="monitor-card space-y-3">
      <h3 className="font-medium">{item.name || item.accountHandle || item.accountId}</h3><p className="text-sm">{item.accountHandle ? `@${item.accountHandle}` : "Xアカウント"} · {!item.enabled ? "停止中" : item.state === "suspended" ? "利用資格の確認が必要" : item.state === "deleted" ? "削除済み" : "登録済み"}</p>
      {item.accountId !== null ? <details className="text-xs text-muted-foreground"><summary>登録情報の詳細</summary><p>XアカウントID：{item.accountId}</p></details> : null}
      {item.state === "suspended" ? <p className="text-sm text-muted-foreground">停止中も現在の全体枠と個人枠を保持します。監視対象と通知設定もそのまま残ります。枠を変更する場合は「利用枠の種類を変更」から選んでください。</p> : null}
      <dl className="monitor-facts"><div><dt>確認間隔</dt><dd>{xInterval(item.quality.intervalMinutes)}</dd></div><div><dt>送信上限</dt><dd>1分{item.quality.minuteLimit}通／1日{item.quality.dayLimit}通</dd></div><div><dt>受信情報の割り当て</dt><dd>{item.notificationSettings.subscriptionId ? "割り当て済み" : "受信情報の設定待ち"}</dd></div></dl>
      {allowSetup && item.notificationSettings.subscriptionId ? (() => { const subscription = setup?.subscriptions.find(row => row.id === item.notificationSettings.subscriptionId); return subscription ? <div className="space-y-1 text-sm"><p className="font-medium">{xReceiverLabel(subscription.receiverState)}</p><p>{xReceiverDescription(subscription.receiverState)}</p></div> : <p className="text-sm">受信情報の一覧を開き、この監視で使う情報の接続状態を確認してください。</p>; })() : null}
      <details className="text-xs text-muted-foreground"><summary>利用枠の詳細</summary><p>{xPoolName(item.poolKind)}を使用しています。確認間隔と送信上限には、現在の契約プラン {item.quality.planId} を適用します。</p></details>
      {item.state !== "deleted" ? <div className="flex flex-wrap gap-2"><button className={button} disabled={!active || busy || Boolean(draft)} onClick={() => { setDraft(draftOf(item)); setEditingId(item.id); setReview(null); setError(""); }}>X監視を編集</button>
        <button className={button} disabled={!active || busy || !item.enabled && !canResume(item)} onClick={() => void toggle(item)}>{item.enabled ? "X監視を停止" : "X監視を再開"}</button><button className={`${button} text-destructive`} disabled={!active || busy} onClick={() => setDeleting(item.id)}>X監視を削除</button></div> : null}
      {item.state !== "deleted" ? <XMonitorMoveEditor row={item} api={api} disabled={!active || busy || Boolean(draft)} onBusy={value => { action.current = value; setBusy(value); if (value) { epoch.current++; setLoading(false); } }} onReload={load} onSaved={async saved => {
        setItems(previous => previous.map(row => row.id === saved.id ? saved : row)); await load();
      }} /> : null}
      {deleting === item.id ? <section aria-label="X監視の削除確認" className="space-y-2"><p className="text-sm">このX監視の登録を削除して利用枠を解放します。</p><button className={`${button} text-destructive`} disabled={!active || busy} onClick={() => void mutate(async () => {
        await api(`x-monitors/${encodeURIComponent(item.id)}`, "DELETE", { expectedRevision: item.revision });
        if (!mounted.current) return; setItems(previous => previous.filter(row => row.id !== item.id)); setDeleting(null); if (editingId === item.id) { setDraft(null); setEditingId(null); }
        setNotice("X監視を削除しました。"); await load();
      })}>このX監視を削除</button><button className={button} disabled={busy} onClick={() => setDeleting(null)}>X監視の削除を取り消す</button></section> : null}
    </article>)}</div>
    {!loading && !readError && items.length === 0 ? <p role="status" className="text-sm">登録済みのX監視はありません。</p> : null}
  </div>;
}

export function XMonitorManager({ api, active = true, allowSetup = true, destinations = [], rules = [] }: { api: XMonitorAPI; active?: boolean; allowSetup?: boolean; destinations?: Choice[]; rules?: Choice[] }) {
  const [opened, setOpened] = useState(false), [subscriptionsVersion, setSubscriptionsVersion] = useState(0);
  return <section aria-label="Xアカウントの監視" className="space-y-3 rounded border bg-card p-4"><h2 className="font-semibold">Xアカウントの監視</h2>
    <p className="text-sm text-muted-foreground">通知を受け取りたいXアカウントと、利用できる枠を管理します。Xアカウントを1件登録するごとに1枠を使います。</p>
    {!opened ? <button className={button} disabled={!active} onClick={() => setOpened(true)}>Xアカウントの監視を管理</button> : <>{allowSetup ? <><XNotificationSetup api={api} active={active} onSubscriptionsChanged={() => setSubscriptionsVersion(value => value + 1)} /><XProcessingSettings api={api} active={active} /></> : <a href="/dashboard/automation/x" className="inline-block text-sm text-primary underline">自分のX通知セットアップを開く</a>}<XMonitorEditor api={api} active={active} allowSetup={allowSetup} subscriptionsVersion={subscriptionsVersion} destinations={destinations} rules={rules} /></>}
  </section>;
}
