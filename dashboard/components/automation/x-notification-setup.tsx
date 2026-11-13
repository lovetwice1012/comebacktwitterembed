"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { xObject, type XMonitorAPI } from "./x-monitor-view";
import { parseXSetupPreview, parseXSetupSession, parseXSetupStatus, parseXSetupSubscription, X_SETUP_DOWNLOAD_URL, X_SETUP_CHROME_DOWNLOAD_URL, X_SETUP_MAX_FILE_BYTES, xSetupFeedback, xSetupStatusFailure, xReceiverLabel, xReceiverDescription,
  type XSetupPreview, type XSetupSession, type XSetupStatus, type XSetupSubscription } from "./x-setup-view";
import { ArrowRight, Check, Download, FileUp, Radio, ShieldCheck } from "lucide-react";
import "./notification-x.css";

const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
const date = (value: number) => new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(value);

async function readFile(file: File): Promise<string> {
  const bytes = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => reader.result !== null && typeof reader.result !== "string" ? resolve(reader.result) : reject(new Error("Invalid file"));
    reader.onerror = () => reject(new Error("Unreadable file"));
    reader.readAsArrayBuffer(file);
  });
  // Reject malformed UTF-8 instead of silently replacing bytes in key material.
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export type XNotificationSetupProps = {
  api: XMonitorAPI;
  active?: boolean;
  initiallyOpen?: boolean;
  embedded?: boolean;
  onSubscriptionsChanged?: () => void;
  onChooseSubscription?: (subscription: XSetupSubscription) => void;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  hideEmbeddedHeader?: boolean;
};

export function XNotificationSetup({ api, active = true, initiallyOpen = false, embedded = false, onSubscriptionsChanged, onChooseSubscription, onCancel, onDirtyChange, onBusyChange, hideEmbeddedHeader = false }: XNotificationSetupProps) {
  const [opened, setOpened] = useState(initiallyOpen), [status, setStatus] = useState<XSetupStatus | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [loginRequired, setLoginRequired] = useState(false);
  const [consent, setConsent] = useState(false), [fileReady, setFileReady] = useState(false), [preview, setPreview] = useState<XSetupPreview | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false), [stage, setStage] = useState<"prepare" | "upload">("prepare");
  const [browser, setBrowser] = useState<"firefox" | "chrome" | "brave" | null>(null);
  const chromiumLabel = browser === "brave" ? "Brave" : "Chrome";
  const [chosenId, setChosenId] = useState<string | null>(null);
  const mounted = useRef(false), enabled = useRef(active), epoch = useRef(0), fileEpoch = useRef(0), action = useRef(false);
  const finished = useRef(false);
  // Secret file contents and one-use sessions stay in memory only, outside React state.
  const fileText = useRef<string | null>(null), session = useRef<XSetupSession | null>(null), input = useRef<HTMLInputElement>(null);
  const reviewPanel = useRef<HTMLElement>(null), errorMessage = useRef<HTMLParagraphElement>(null), noticeMessage = useRef<HTMLParagraphElement>(null);
  const setupHeading = useRef<HTMLElement>(null), stagePanel = useRef<HTMLElement>(null), focusStage = useRef(embedded);
  enabled.current = active;
  useEffect(() => { onDirtyChange?.(Boolean(consent || fileReady || preview)); }, [consent, fileReady, preview, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);
  const setSetupBusy = (value: boolean) => { onBusyChange?.(value); setBusy(value); };
  const clearFile = useCallback((clearInput = true) => { fileEpoch.current++; fileText.current = null; session.current = null;
    if (clearInput && input.current) input.current.value = "";
    if (mounted.current) { setFileReady(false); setPreview(null); }
  }, []);
  const load = useCallback(async (afterId?: string) => {
    if (!mounted.current || !enabled.current) return;
    const version = ++epoch.current; setLoading(true); setError(""); setLoginRequired(false);
    try {
      const next = parseXSetupStatus(await api(afterId ? `x-setup?afterId=${encodeURIComponent(afterId)}` : "x-setup"));
      if (mounted.current && enabled.current && version === epoch.current) { setStatus(previous => afterId && previous ? { ...next, subscriptions: [...previous.subscriptions, ...next.subscriptions.filter(item => !previous.subscriptions.some(row => row.id === item.id))] } : next); if (!next.available) { clearFile(); setConsent(false); setAdding(false); setStage("prepare"); } }
    } catch (cause) { if (mounted.current && enabled.current && version === epoch.current) { setStatus(null); clearFile(); setError(xSetupStatusFailure(cause)); const failure = cause && typeof cause === "object" ? cause as { code?: unknown; status?: unknown } : {}; setLoginRequired(failure.code === "AUTH_REQUIRED" || failure.status === 401); } }
    finally { if (mounted.current && enabled.current && version === epoch.current) setLoading(false); }
  }, [api, clearFile]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; fileEpoch.current++; fileText.current = null; session.current = null; if (input.current) input.current.value = ""; };
  }, []);
  useEffect(() => { clearFile(); setConsent(false); setDeleting(null); if (active && opened) void load(); else { epoch.current++; setLoading(false); } }, [active, opened, load, clearFile]);
  useEffect(() => {
    if (status && (browser === "chrome" && !status.chromeEnabled || browser === "brave" && !status.braveEnabled)) {
      setBrowser(null); clearFile(); setConsent(false); setStage("prepare");
      setNotice("選んだブラウザーは現在利用できません。受付状態を確認してください。");
    }
  }, [status, browser, clearFile]);
  useEffect(() => {
    // Bring the next action or its outcome into view after the long instructions.
    if (error) errorMessage.current?.focus();
    else if (notice) noticeMessage.current?.focus();
    else if (preview) reviewPanel.current?.focus();
  }, [error, notice, preview]);
  useEffect(() => {
    if (!focusStage.current || loading || !status) return;
    const target = stagePanel.current ?? (embedded ? setupHeading.current : null);
    if (!target) return;
    focusStage.current = false; target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: "start" });
  }, [stage, adding, loading, status, embedded, browser]);
  const canUpload = Boolean(active && status?.available && consent && !busy && !loading && !finished.current);
  async function choose(file: File | undefined) {
    clearFile(false); setError(""); setNotice("");
    if (!file || !canUpload) { clearFile(); return; }
    if (!file.name.toLowerCase().endsWith(".json") || file.size === 0) { clearFile(); setError("保存ツールで作成したJSONファイルを選んでください。"); return; }
    if (file.size > Math.min(status?.maxFileBytes ?? X_SETUP_MAX_FILE_BYTES, X_SETUP_MAX_FILE_BYTES)) { clearFile(); setError(xSetupFeedback({ code: "X_SETUP_FILE_TOO_LARGE" })); return; }
    const version = fileEpoch.current;
    setSetupBusy(true);
    try {
      const text = await readFile(file);
      if (mounted.current && enabled.current && version === fileEpoch.current) { fileText.current = text; onDirtyChange?.(true); setFileReady(true); }
    } catch { if (mounted.current && enabled.current && version === fileEpoch.current) { clearFile(); setError("ファイルを読み取れませんでした。保存ツールで作成したUTF-8のJSONファイルを選び直してください。"); } }
    finally { if (mounted.current) setSetupBusy(false); }
  }
  async function validate() {
    if (!canUpload || !fileReady || fileText.current === null || action.current) return;
    action.current = true; setSetupBusy(true); setError(""); setNotice(""); setPreview(null); session.current = null;
    const version = fileEpoch.current;
    try {
      const next = parseXSetupSession(await api("x-setup/sessions", "POST", { consent: true }));
      if (!mounted.current || !enabled.current || version !== fileEpoch.current) return;
      if (next.expiresAtMs <= Date.now()) throw { code: "X_SETUP_SESSION_EXPIRED" };
      session.current = next;
      const checked = parseXSetupPreview(await api("x-setup/validate", "POST", { sessionId: next.sessionId, fileText: fileText.current }));
      if (mounted.current && enabled.current && version === fileEpoch.current) setPreview(checked);
    } catch (cause) { if (mounted.current && enabled.current && version === fileEpoch.current) { clearFile(); setError(xSetupFeedback(cause)); } }
    finally { action.current = false; if (mounted.current) setSetupBusy(false); }
  }
  async function save() {
    if (!canUpload || !preview || fileText.current === null || !session.current || action.current) return;
    if (session.current.expiresAtMs <= Date.now()) { clearFile(); setError(xSetupFeedback({ code: "X_SETUP_SESSION_EXPIRED" })); return; }
    action.current = true; setSetupBusy(true); setError(""); setNotice("");
    const version = fileEpoch.current;
    try {
      const response = xObject(await api("x-setup/import", "POST", { sessionId: session.current.sessionId, fileText: fileText.current, consent: true }));
      const saved = parseXSetupSubscription(response.subscription);
      if (typeof response.duplicate !== "boolean") throw new Error("Invalid import response");
      if (!mounted.current || !enabled.current || version !== fileEpoch.current) return;
      setStatus(previous => previous ? { ...previous, subscriptions: [...previous.subscriptions.filter(item => item.id !== saved.id), saved] } : previous);
      if (saved.receiverState === "requires_reenrollment") {
        setNotice(response.duplicate ? "このファイルは再登録が必要な受信情報と同じです。設定用ブラウザーで通知を設定し直し、新しいファイルを作成してください。" : "この受信情報は登録し直す必要があります。設定用ブラウザーで通知を設定し直し、新しいファイルを作成してください。");
        setConsent(false); setAdding(false); setStage("prepare"); clearFile(); onSubscriptionsChanged?.();
        return;
      }
      setNotice(response.duplicate ? "同じ受信情報が登録済みです。下の一覧で接続状態を確認し、監視するアカウントと通知先を設定してください。" : "受信情報を登録しました。次に、下の一覧で接続状態を確認し、監視するアカウントと通知先を設定してください。");
      setConsent(false); setAdding(false); setStage("prepare");
      // Clear the private file before returning to the monitor's in-memory draft.
      // An import replay returns its exact existing subscription, never another row.
      clearFile();
      onSubscriptionsChanged?.();
      if (embedded && onChooseSubscription && !finished.current) {
        finished.current = true; setChosenId(saved.id); onChooseSubscription(saved);
      }
    } catch (cause) { if (mounted.current && enabled.current && version === fileEpoch.current) setError(xSetupFeedback(cause)); }
    finally { action.current = false; clearFile(); if (mounted.current) setSetupBusy(false); }
  }
  async function remove(item: XSetupSubscription) {
    if (!active || busy || loading || action.current || deleting !== item.id) return;
    action.current = true; setSetupBusy(true); setError(""); setNotice(""); clearFile();
    const version = fileEpoch.current;
    try {
      const result = xObject(await api(`x-setup/subscriptions/${encodeURIComponent(item.id)}`, "DELETE", { expectedRevision: item.revision }));
      if (result.deleted !== true) throw new Error("Invalid delete response");
      if (!mounted.current || !enabled.current || version !== fileEpoch.current) return;
      setStatus(previous => previous ? { ...previous, subscriptions: previous.subscriptions.filter(row => row.id !== item.id) } : previous); setDeleting(null);
      setNotice("サービス上の受信情報を削除しました。Xとブラウザー側の通知を止める場合は、それぞれの設定から解除してください。");
      onSubscriptionsChanged?.();
    } catch (cause) { if (mounted.current && enabled.current && version === fileEpoch.current) setError(xSetupFeedback(cause)); }
    finally { action.current = false; if (mounted.current) setSetupBusy(false); }
  }
  const registered = Boolean(status?.subscriptions.length || status?.nextCursor), showPreparation = !loading && Boolean(status?.available) && (!registered || adding);
  const openUpload = () => { clearFile(); setConsent(false); focusStage.current = true; setStage("upload"); };
  const confirmDiscard = () => !(fileReady || consent || preview) || confirm("選択したファイルと同意を取り消します。続けますか？");
  const reloadStatus = (afterId?: string) => {
    if (!active || busy || loading || action.current || finished.current || !confirmDiscard()) return;
    clearFile(); setConsent(false); setDeleting(null); void load(afterId);
  };
  const togglePreparation = () => {
    if (!active || busy || loading || action.current || finished.current || chosenId !== null || !status?.available) return;
    if (adding && !confirmDiscard()) return;
    clearFile(); setConsent(false); setDeleting(null); focusStage.current = !adding; setAdding(value => !value); setStage("prepare");
  };
  const chooseSubscription = (item: XSetupSubscription) => {
    if (!active || loading || busy || action.current || finished.current || !onChooseSubscription
      || item.receiverState === "requires_reenrollment"
      || !status?.subscriptions.some(row => row.id === item.id && row.revision === item.revision)) return;
    if (!confirmDiscard()) return;
    finished.current = true; clearFile(); setConsent(false); setChosenId(item.id); onChooseSubscription(item);
  };
  const cancel = () => {
    if (!active || busy || action.current || finished.current || !confirmDiscard()) return;
    finished.current = true; epoch.current++; clearFile(); setConsent(false); onCancel?.();
  };
  const monitorLink = (id?: string) => `/dashboard/automation${id ? `?xSubscriptionId=${encodeURIComponent(id)}` : ""}#x-notifications`;
  return <section aria-label="X通知の受信設定" className={`notification-x nx-setup${embedded ? " nx-setup-embedded" : ""}`}>
    {embedded && hideEmbeddedHeader ? <span ref={setupHeading} tabIndex={-1} className="sr-only">Xの接続を選ぶ</span> : <header ref={setupHeading} tabIndex={-1} className="nx-section-heading nx-stage-focus"><div><h2>{embedded ? "Xの接続を選ぶ" : "受信情報"}</h2></div>{embedded && onCancel ? <button type="button" className={button} disabled={!active || busy} onClick={cancel}>通知の設定に戻る</button> : <Radio size={28} aria-hidden="true" />}</header>}
    {!opened ? <button className="nx-primary" disabled={!active} onClick={() => setOpened(true)}>X通知の受信設定を始める<ArrowRight size={16} aria-hidden="true" /></button> : <>
      {loading ? <p role="status" className="nx-inline-note">受付状態と登録一覧を読み込み中…</p> : null}{busy ? <p role="status" className="nx-inline-note">処理中です…</p> : null}
      {error ? <p ref={errorMessage} tabIndex={-1} role="alert" className="nx-feedback nx-feedback-error">{error}{loginRequired ? <> <a href="/api/auth/signin/discord?callbackUrl=/dashboard/automation" target="_blank" rel="noreferrer" className="nx-text-link">ログインする</a></> : null}</p> : null}{notice ? <p ref={noticeMessage} tabIndex={-1} role="status" className="nx-feedback">{notice}</p> : null}
      {status && !status.available ? <p role="status" className="nx-inline-note">{xSetupFeedback({ code: status.reasonCode || status.rollout.reasonCode || "X_SETUP_NOT_CONFIGURED" })}</p> : null}
      {registered && !adding ? <div className="nx-section-heading nx-section-heading-small"><div><h3>{embedded ? "使う接続を選ぶ" : "登録した受信情報"}</h3></div><button className={button} disabled={!active || busy || loading} onClick={() => reloadStatus()}>更新</button></div> : null}
      {registered && !adding ? <section aria-label="登録済みのX通知受信情報" className="nx-receiver-list">
        {status?.subscriptions.map((item, index) => <article key={item.id} aria-label={`受信情報${index + 1}`} className="nx-receiver-card"><header><div><h4>受信情報 {index + 1}</h4><span className="nx-field-note">{item.browserKind === "brave" ? "Brave" : item.browserKind === "chrome" ? "Chrome" : "Firefox"}</span></div><span className="nx-state-pill" data-state={item.receiverState === "listening" ? "ready" : "pending"}>{xReceiverLabel(item.receiverState)}</span></header>
          {item.boundMonitorCount === 0 && !embedded ? <p className="nx-inline-note">X監視の編集で「使用する自分の受信情報」にこの受信情報を選ぶと、サーバーとの接続を進められます。</p> : null}
          {item.lastProviderLossAtMs !== undefined ? <p role="status" className="nx-inline-note">{date(item.lastProviderLossAtMs)}に、通知サービスから未受信の通知が失われたと報告されました。Xの投稿を確認してください。</p> : null}
          {item.receiptCounts && (item.receiptCounts.unsupported > 0 || item.receiptCounts.decryptionFailed > 0 || (item.receiptCounts.unmatched ?? 0) > 0) ? <p role="status" className="nx-inline-note">処理を確認する通知があります。「接続と受信の詳細」を確認してください。</p> : null}
          <details className="nx-receiver-details"><summary>接続と受信の詳細</summary><p>{xReceiverDescription(item.receiverState)}</p><div className="nx-last-received"><span>最終受信日時（日本時間）</span><strong>{item.lastReceivedAtMs === null ? "最初の受信を待っています" : date(item.lastReceivedAtMs)}</strong></div><p>受信記録と通知先への配信結果は別です。</p>
          {item.receiptCounts ? <section aria-label="受信データの処理状況" className="nx-receipt-status"><h5>受信データの処理状況</h5><dl className="nx-receipt-counts"><div><dt>処理待ち</dt><dd>{item.receiptCounts.received}件</dd></div><div><dt>振り分け処理済み</dt><dd>{item.receiptCounts.routed}件</dd></div><div><dt>形式の確認が必要</dt><dd>{item.receiptCounts.unsupported}件</dd></div><div><dt>内容の読み取りに失敗</dt><dd>{item.receiptCounts.decryptionFailed}件</dd></div>{item.receiptCounts.unmatched !== undefined ? <div><dt>監視対象との一致を確認できない受信データ</dt><dd>{item.receiptCounts.unmatched}件</dd></div> : null}</dl>
            {item.receiptCounts.unsupported > 0 ? <p role="status">Xからの通知データは届いています。形式の確認が必要な通知が{item.receiptCounts.unsupported}件あり、これらは送信処理に進んでいません。通知データは保管されています。管理者による対応が必要なため、確認間隔を待つだけでは送信されません。</p> : null}
            {item.receiptCounts.decryptionFailed > 0 ? <p role="status">内容を読み取れなかった通知が{item.receiptCounts.decryptionFailed}件あり、これらは送信処理に進んでいません。管理者に受信情報の確認を依頼してください。</p> : null}
            {(item.receiptCounts.unmatched ?? 0) > 0 ? <p role="status">監視対象との一致を確認できず、送信していない受信データ：{item.receiptCounts.unmatched}件。通知データは保管されています。監視するアカウントと、この受信情報の割り当てを確認してください。</p> : null}
            <p className="nx-muted">振り分け処理済みの件数は、通知先への送信成功数とは別です。配信結果は通知履歴で確認できます。</p>
          </section> : null}
          <dl><div><dt>ブラウザー</dt><dd>{item.browserKind === "brave" ? "Brave" : item.browserKind === "chrome" ? "Chrome" : "Firefox"} {item.browserVersion}</dd></div><div><dt>登録日時（日本時間）</dt><dd>{date(item.createdAtMs)}</dd></div><div><dt>更新日時（日本時間）</dt><dd>{date(item.updatedAtMs)}</dd></div></dl></details>
          <footer>{embedded ? <button type="button" className="nx-primary" disabled={!active || busy || loading || chosenId !== null || item.receiverState === "requires_reenrollment"} onClick={() => chooseSubscription(item)}>この接続を使う<ArrowRight size={16} aria-hidden="true" /></button> : <a href={monitorLink(item.id)} className="nx-text-link">この接続の監視を開く<ArrowRight size={14} aria-hidden="true" /></a>}<button className={`${button} text-destructive`} disabled={!active || busy || loading || chosenId !== null} onClick={() => { if (!confirmDiscard()) return; clearFile(); setConsent(false); setDeleting(item.id); }}>受信情報を削除</button></footer>
          {deleting === item.id ? <section aria-label="受信情報の削除確認" className="nx-feedback nx-feedback-error"><p>この受信情報を削除すると、これを使う{item.boundMonitorCount}件の監視は受信情報の再登録・設定まで停止します。監視するアカウントと利用枠は保持します。Xとブラウザー側の通知を止める場合は、それぞれの設定で解除してください。</p><div className="nx-actions"><button className={`${button} text-destructive`} disabled={!active || busy || loading} onClick={() => void remove(item)}>この受信情報を削除</button><button className={button} disabled={busy} onClick={() => setDeleting(null)}>削除を取り消す</button></div></section> : null}
        </article>)}
        {status?.nextCursor ? <button className={button} disabled={!active || busy || loading} onClick={() => reloadStatus(status.nextCursor ?? undefined)}>受信情報をさらに表示</button> : null}
      </section> : null}
      {registered && status?.available ? <button type="button" className={button} disabled={!active || busy || loading || chosenId !== null} aria-expanded={adding} onClick={togglePreparation}>{adding ? "追加の手順を閉じる" : "受信情報を追加"}</button> : null}
      {registered && !adding ? <div className="nx-setup-maintenance"><details><summary>PCを閉じる前に</summary><p>設定用ブラウザーを閉じたまま使えます。「接続を確認済み」と表示されたら、実際のX通知が通知先に届くことを確認してください。確認後は、PCの電源を切って使えます。サーバーとブラウザーが同時に接続すると、通知の受信が競合する場合があります。</p></details></div> : null}
      {showPreparation ? <section aria-label="X通知の接続手順" className="nx-onboarding"><ol className="nx-stepper" aria-label="X接続の手順"><li aria-current={stage === "prepare" ? "step" : undefined}><span>{stage === "upload" ? <Check size={16} aria-hidden="true" /> : "1"}</span>準備</li><li aria-current={stage === "upload" ? "step" : undefined}><span>2</span>登録</li><li><span>3</span>{embedded ? "通知先" : "接続確認"}</li></ol>
        {stage === "prepare" ? <div className="nx-preparation"><header ref={stagePanel} tabIndex={-1} className="nx-stage-focus"><h3>PCでファイルを作成</h3></header><fieldset className="grid gap-2 sm:grid-cols-3"><legend className="mb-2 font-semibold">設定に使うブラウザーを選ぶ</legend>
          <label className={`flex min-h-12 items-center gap-2 rounded-lg border bg-background px-4 py-3 text-base ${browser === "firefox" ? "border-primary bg-primary/5" : ""}`}><input type="radio" name="x-setup-browser" checked={browser === "firefox"} onChange={() => setBrowser("firefox")} /><span>Firefox</span></label>
          {status?.chromeEnabled ? <label className={`flex min-h-12 items-center gap-2 rounded-lg border bg-background px-4 py-3 text-base ${browser === "chrome" ? "border-primary bg-primary/5" : ""}`}><input type="radio" name="x-setup-browser" checked={browser === "chrome"} onChange={() => setBrowser("chrome")} /><span>Chrome</span></label> : null}
          {status?.braveEnabled ? <label className={`flex min-h-12 items-center gap-2 rounded-lg border bg-background px-4 py-3 text-base ${browser === "brave" ? "border-primary bg-primary/5" : ""}`}><input type="radio" name="x-setup-browser" checked={browser === "brave"} onChange={() => setBrowser("brave")} /><span>Brave</span></label> : null}
        </fieldset>{browser === null ? null : browser !== "firefox" && status?.chromeEnabled ? <ol className="nx-instruction-list">
          <li><Download size={22} aria-hidden="true" /><div><h4>{chromiumLabel}用の保存ツール</h4><p>WindowsのPCでダウンロード後、ZIPを右クリックして「すべて展開」を選びます。</p><a href={X_SETUP_CHROME_DOWNLOAD_URL} download aria-label={`${chromiumLabel}用の保存ツールをダウンロード`} className="nx-primary">ダウンロード<Download size={15} aria-hidden="true" /></a></div></li>
          <li><span className="nx-step-number">2</span><div><h4>設定用{chromiumLabel}で通知をオンにする</h4><p>展開したフォルダーで「{chromiumLabel}で開始」を開き、Xにログインします。監視したいアカウントごとに投稿通知をオンにし、ブラウザー通知を許可してください。</p></div></li>
          <li><span className="nx-step-number">3</span><div><h4>通知データを保存</h4><p>ツールの「通知データを保存」を押します。設定用{chromiumLabel}が閉じ、アップロード用のファイルができます。</p></div></li>
        </ol> : <ol className="nx-instruction-list">
          <li><Download size={22} aria-hidden="true" /><div><h4>Firefox用の保存ツール</h4><p>WindowsのPCでダウンロード後、ZIPを右クリックして「すべて展開」を選びます。</p><a href={X_SETUP_DOWNLOAD_URL} download aria-label="Firefox用の保存ツールをダウンロード" className="nx-primary">ダウンロード<Download size={15} aria-hidden="true" /></a>{status ? <div className="nx-download-meta"><span>バージョン {status.download.version}</span><details><summary>ダウンロードの照合用情報</summary><p>SHA-256</p><code>{status.download.sha256}</code></details></div> : null}</div></li>
          <li><span className="nx-step-number">2</span><div><h4>専用Firefoxを開く</h4><p>「ダブルクリックで開始.cmd」を開き、ツール専用のFirefox環境を作ります。普段使いのFirefoxと分けて使えます。</p><p>Firefoxが見つからない場合は「Firefoxを選ぶ」で指定します。</p></div></li>
          <li><span className="nx-step-number">3</span><div><h4>Xにログインして通知を許可</h4><p>専用FirefoxでXにログインし、ブラウザー通知を許可します。監視するアカウントごとに、プロフィールのベルを押して投稿通知をオンにしてください。</p></div></li>
          <li><span className="nx-step-number">4</span><div><h4>Firefoxを閉じてJSONを保存</h4><p>専用Firefoxのウィンドウをすべて閉じ、保存ツールでJSONファイルを作成します。他サイトの通知設定もある場合は、作成前に通知の扱いを確認できます。</p></div></li>
        </ol>}{browser !== null ? <div className="nx-step-actions"><button className={button} disabled={!active || busy || loading} onClick={openUpload}>作成したファイルを登録<ArrowRight size={16} aria-hidden="true" /></button></div> : null}</div> : <div className="nx-upload-stage"><header ref={stagePanel} tabIndex={-1} className="nx-stage-focus"><h3>JSONファイルを登録</h3></header>
          <section aria-label="登録するデータと通知の取り扱い" className="nx-consent-information"><h4><ShieldCheck size={18} aria-hidden="true" />登録するデータをご確認ください</h4><p><strong>ファイルに入る情報</strong><br />X通知の受信先、識別子、通知を読み取るための秘密鍵が入ります。Cookie、閲覧履歴、保存パスワード、他サイトの秘密鍵は含みません。</p><p><strong>他サイトの通知について</strong><br />設定用ブラウザーに他サイトの通知設定もある場合、そのサイトの暗号化された通知や識別情報もサーバーへ届くことがあります。サーバーに届く以上、運営側でそのデータを取得することは可能です。現在は、X以外の通知を受信後に破棄します。別途明確な許可をいただくまでは、復号・利用・保存を行いません。他サイトの通知を利用する際は、あらためて許可を確認します。破棄された通知は、ブラウザーでも受け取れなくなる場合があります。</p><p><strong>ファイルの保管</strong><br />ファイルには、X通知を読むための鍵が入っています。ファイル自体は暗号化せずに保存するので、ご自身のPCで保管し、この登録画面にアップロードしてください。登録後、PC上のファイルが不要になったら削除できます。</p><p><strong>利用を終了するとき</strong><br />サービス上の受信情報は、登録一覧から削除できます。Xとブラウザー側の通知も止めるには、それぞれの設定で通知を解除してください。</p></section>
          {status && !status.available ? <p role="status" className="nx-inline-note">{status.rollout.reasonCode ? xSetupFeedback({ code: status.rollout.reasonCode }) : "現在、ファイルの受付は準備中です。手順の確認と保存ツールのダウンロードができます。"}</p> : null}
          <form aria-label="X通知ファイルの登録" className="nx-upload-form" onSubmit={event => { event.preventDefault(); void validate(); }}><label className="nx-consent-checkbox"><input type="checkbox" checked={consent} disabled={!active || !status?.available || busy || loading} onChange={event => { onDirtyChange?.(event.target.checked); setConsent(event.target.checked); clearFile(); setError(""); setNotice(""); }} /><span>サーバーでX通知を受信・復号することに同意します。他サイトの通知も届く可能性と、別途許可するまでの破棄方針を確認しました。</span></label><label className="nx-file-field"><FileUp size={24} aria-hidden="true" /><span>保存ツールで作成したJSONファイル（32 KiB以下）</span><input ref={input} type="file" accept=".json,application/json" disabled={!canUpload} onChange={event => void choose(event.target.files?.[0])} /></label><p className="nx-muted">「ファイルの内容を確認」を押すと、このサービスへファイルを送信します。</p>{fileReady ? <p role="status">ファイルを選択しました。</p> : null}<div className="nx-actions">{!preview ? <button type="submit" className="nx-primary" disabled={!canUpload || !fileReady}>ファイルの内容を確認<ArrowRight size={16} aria-hidden="true" /></button> : null}{fileReady ? <button type="button" className={button} disabled={busy} onClick={() => { clearFile(); setNotice("ファイルの選択を取り消しました。必要なファイルを選び直せます。"); }}>ファイルの選択を取り消す</button> : null}</div></form>
          {preview ? <section ref={reviewPanel} tabIndex={-1} aria-label="X通知ファイルの登録確認" className="nx-review"><h4>この受信情報を保存します</h4><p>登録できる形式です。対象サイト：X（x.com）、{preview.browserKind === "brave" ? "Brave" : preview.formatVersion === 2 ? "Chrome" : "Firefox"} {preview.browserVersion}、ファイル形式 {preview.formatVersion}。</p><button className="nx-primary" disabled={!canUpload || chosenId !== null} onClick={() => void save()}>この受信情報を登録<Check size={16} aria-hidden="true" /></button></section> : null}
          <button className="nx-text-link" disabled={busy} onClick={() => { if (!confirmDiscard()) return; clearFile(); setConsent(false); focusStage.current = true; setStage("prepare"); }}>PCでの準備手順を確認</button>
        </div>}
      </section> : null}
      {!registered ? <button className={button} disabled={!active || busy || loading} onClick={() => reloadStatus()}>更新</button> : null}
      {status && !status.receiverEnabled ? <p role="status" className="nx-state-line"><Radio size={15} aria-hidden="true" />サーバーの受信開始待ち</p> : null}
    </>}
  </section>;
}
