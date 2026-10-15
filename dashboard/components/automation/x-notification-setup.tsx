"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { xObject, type XMonitorAPI } from "./x-monitor-view";
import { parseXSetupPreview, parseXSetupSession, parseXSetupStatus, parseXSetupSubscription, X_SETUP_DOWNLOAD_URL, X_SETUP_MAX_FILE_BYTES, xSetupFeedback, xReceiverLabel, xReceiverDescription,
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
};

export function XNotificationSetup({ api, active = true, initiallyOpen = false, embedded = false, onSubscriptionsChanged, onChooseSubscription, onCancel }: XNotificationSetupProps) {
  const [opened, setOpened] = useState(initiallyOpen), [status, setStatus] = useState<XSetupStatus | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false), [fileReady, setFileReady] = useState(false), [preview, setPreview] = useState<XSetupPreview | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false), [stage, setStage] = useState<"prepare" | "upload">("prepare");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const mounted = useRef(false), enabled = useRef(active), epoch = useRef(0), fileEpoch = useRef(0), action = useRef(false);
  const finished = useRef(false);
  // Secret file contents and one-use sessions stay in memory only, outside React state.
  const fileText = useRef<string | null>(null), session = useRef<XSetupSession | null>(null), input = useRef<HTMLInputElement>(null);
  const reviewPanel = useRef<HTMLElement>(null), errorMessage = useRef<HTMLParagraphElement>(null), noticeMessage = useRef<HTMLParagraphElement>(null);
  const setupHeading = useRef<HTMLElement>(null), stagePanel = useRef<HTMLElement>(null), focusStage = useRef(embedded);
  enabled.current = active;
  const clearFile = useCallback(() => { fileEpoch.current++; fileText.current = null; session.current = null;
    if (input.current) input.current.value = "";
    if (mounted.current) { setFileReady(false); setPreview(null); }
  }, []);
  const load = useCallback(async (afterId?: string) => {
    if (!mounted.current || !enabled.current) return;
    const version = ++epoch.current; setLoading(true); setError("");
    try {
      const next = parseXSetupStatus(await api(afterId ? `x-setup?afterId=${encodeURIComponent(afterId)}` : "x-setup"));
      if (mounted.current && enabled.current && version === epoch.current) { setStatus(previous => afterId && previous ? { ...next, subscriptions: [...previous.subscriptions, ...next.subscriptions.filter(item => !previous.subscriptions.some(row => row.id === item.id))] } : next); if (!next.available) clearFile(); }
    } catch { if (mounted.current && enabled.current && version === epoch.current) { setStatus(null); clearFile(); setError("受付状態と登録一覧を取得できませんでした。下の更新ボタンから再試行できます。"); } }
    finally { if (mounted.current && enabled.current && version === epoch.current) setLoading(false); }
  }, [api, clearFile]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; fileEpoch.current++; fileText.current = null; session.current = null; if (input.current) input.current.value = ""; };
  }, []);
  useEffect(() => { clearFile(); setConsent(false); setDeleting(null); if (active && opened) void load(); else { epoch.current++; setLoading(false); } }, [active, opened, load, clearFile]);
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
  }, [stage, adding, loading, status, embedded]);
  const canUpload = Boolean(active && status?.available && consent && !busy && !loading && !finished.current);
  async function choose(file: File | undefined) {
    clearFile(); setError(""); setNotice("");
    if (!file || !canUpload) return;
    if (!file.name.toLowerCase().endsWith(".json") || file.size === 0) { setError("保存ツールで作成したJSONファイルを選んでください。"); return; }
    if (file.size > Math.min(status?.maxFileBytes ?? X_SETUP_MAX_FILE_BYTES, X_SETUP_MAX_FILE_BYTES)) { setError(xSetupFeedback({ code: "X_SETUP_FILE_TOO_LARGE" })); return; }
    const version = fileEpoch.current;
    setBusy(true);
    try {
      const text = await readFile(file);
      if (mounted.current && enabled.current && version === fileEpoch.current) { fileText.current = text; setFileReady(true); }
    } catch { if (mounted.current && enabled.current && version === fileEpoch.current) setError("ファイルを読み取れませんでした。保存ツールで作成したUTF-8のJSONファイルを選び直してください。"); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function validate() {
    if (!canUpload || !fileReady || fileText.current === null || action.current) return;
    action.current = true; setBusy(true); setError(""); setNotice(""); setPreview(null); session.current = null;
    const version = fileEpoch.current;
    try {
      const next = parseXSetupSession(await api("x-setup/sessions", "POST", { consent: true }));
      if (!mounted.current || !enabled.current || version !== fileEpoch.current) return;
      if (next.expiresAtMs <= Date.now()) throw { code: "X_SETUP_SESSION_EXPIRED" };
      session.current = next;
      const checked = parseXSetupPreview(await api("x-setup/validate", "POST", { sessionId: next.sessionId, fileText: fileText.current }));
      if (mounted.current && enabled.current && version === fileEpoch.current) setPreview(checked);
    } catch (cause) { if (mounted.current && enabled.current && version === fileEpoch.current) { clearFile(); setError(xSetupFeedback(cause)); } }
    finally { action.current = false; if (mounted.current) setBusy(false); }
  }
  async function save() {
    if (!canUpload || !preview || fileText.current === null || !session.current || action.current) return;
    if (session.current.expiresAtMs <= Date.now()) { clearFile(); setError(xSetupFeedback({ code: "X_SETUP_SESSION_EXPIRED" })); return; }
    action.current = true; setBusy(true); setError(""); setNotice("");
    const version = fileEpoch.current;
    try {
      const response = xObject(await api("x-setup/import", "POST", { sessionId: session.current.sessionId, fileText: fileText.current, consent: true }));
      const saved = parseXSetupSubscription(response.subscription);
      if (typeof response.duplicate !== "boolean") throw new Error("Invalid import response");
      if (!mounted.current || !enabled.current || version !== fileEpoch.current) return;
      setStatus(previous => previous ? { ...previous, subscriptions: [...previous.subscriptions.filter(item => item.id !== saved.id), saved] } : previous);
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
    finally { action.current = false; clearFile(); if (mounted.current) setBusy(false); }
  }
  async function remove(item: XSetupSubscription) {
    if (!active || busy || loading || action.current || deleting !== item.id) return;
    action.current = true; setBusy(true); setError(""); setNotice(""); clearFile();
    const version = fileEpoch.current;
    try {
      const result = xObject(await api(`x-setup/subscriptions/${encodeURIComponent(item.id)}`, "DELETE", { expectedRevision: item.revision }));
      if (result.deleted !== true) throw new Error("Invalid delete response");
      if (!mounted.current || !enabled.current || version !== fileEpoch.current) return;
      setStatus(previous => previous ? { ...previous, subscriptions: previous.subscriptions.filter(row => row.id !== item.id) } : previous); setDeleting(null);
      setNotice("サービス上の受信情報を削除しました。X・Firefox側の通知や購読を止める場合は、それぞれの設定から解除してください。");
      onSubscriptionsChanged?.();
    } catch (cause) { if (mounted.current && enabled.current && version === fileEpoch.current) setError(xSetupFeedback(cause)); }
    finally { action.current = false; if (mounted.current) setBusy(false); }
  }
  const registered = Boolean(status?.subscriptions.length || status?.nextCursor), showPreparation = !loading && (!registered || adding);
  const listening = status?.subscriptions.filter(item => item.receiverState === "listening").length ?? 0;
  const bound = status?.subscriptions.reduce((sum, item) => sum + item.boundMonitorCount, 0) ?? 0;
  const needsBinding = bound === 0 && !status?.nextCursor;
  const openUpload = () => { clearFile(); setConsent(false); focusStage.current = true; setStage("upload"); };
  const chooseSubscription = (item: XSetupSubscription) => {
    if (!active || loading || busy || action.current || finished.current || !onChooseSubscription
      || item.receiverState === "requires_reenrollment"
      || !status?.subscriptions.some(row => row.id === item.id && row.revision === item.revision)) return;
    finished.current = true; clearFile(); setConsent(false); setChosenId(item.id); onChooseSubscription(item);
  };
  const cancel = () => {
    if (finished.current) return;
    finished.current = true; epoch.current++; clearFile(); setConsent(false); onCancel?.();
  };
  const monitorLink = (id?: string) => `/dashboard/automation${id ? `?xSubscriptionId=${encodeURIComponent(id)}` : ""}#x-notifications`;
  return <section aria-label="X通知の受信設定" className={`notification-x nx-setup${embedded ? " nx-setup-embedded" : ""}`}>
    <header ref={setupHeading} tabIndex={-1} className="nx-section-heading nx-stage-focus"><div><h2>{embedded ? "Xの接続を選ぶ" : "受信情報"}</h2></div>{embedded && onCancel ? <button type="button" className={button} onClick={cancel}>通知の設定に戻る</button> : <Radio size={28} aria-hidden="true" />}</header>
    {!opened ? <button className="nx-primary" disabled={!active} onClick={() => setOpened(true)}>X通知の受信設定を始める<ArrowRight size={16} aria-hidden="true" /></button> : <>
      {status?.rollout.mode === "supporters" ? <p role="status" className="nx-inline-note">支援者向けベータ版{status.rollout.eligible ? "・利用できます" : "・受付対象の拡大待ち"}</p> : null}
      {status?.rollout.mode === "disabled" ? <p role="status" className="nx-inline-note">{xSetupFeedback({ code: "X_ROLLOUT_DISABLED" })}</p> : null}
      {loading ? <p role="status" className="nx-inline-note">受付状態と登録一覧を読み込み中…</p> : null}{busy ? <p role="status" className="nx-inline-note">処理中です…</p> : null}
      {error ? <p ref={errorMessage} tabIndex={-1} role="alert" className="nx-feedback nx-feedback-error">{error}</p> : null}{notice ? <p ref={noticeMessage} tabIndex={-1} role="status" className="nx-feedback">{notice}</p> : null}
      {registered && !embedded ? <section aria-label="現在のX接続" className="nx-connection-overview"><div><span className="nx-state-pill" data-state={listening ? "ready" : "pending"}>{listening ? "接続を確認済み" : status?.nextCursor ? "続きの受信情報を確認" : "接続の準備・確認中"}</span>{needsBinding ? <h3>監視への割り当て待ち</h3> : null}<a className="nx-primary" href={monitorLink()}>監視アカウントを開く<ArrowRight size={16} aria-hidden="true" /></a></div><dl className="nx-summary-numbers"><div><dt>表示中の受信情報</dt><dd>{status?.subscriptions.length}件</dd></div><div><dt>表示中の接続確認済み</dt><dd>{listening}件</dd></div></dl></section> : null}
      {registered ? <div className="nx-section-heading nx-section-heading-small"><div><h3>登録した受信情報</h3></div><button className={button} disabled={!active || busy || loading} onClick={() => { clearFile(); setDeleting(null); void load(); }}>受付状態・登録一覧を更新</button></div> : null}
      <section aria-label="登録済みのX通知受信情報" className="nx-receiver-list">
        {status?.subscriptions.map((item, index) => <article key={item.id} aria-label={`受信情報${index + 1}`} className="nx-receiver-card"><header><div><h4>受信情報 {index + 1}</h4><span className="nx-field-note">保存済み</span></div><span className="nx-state-pill" data-state={item.receiverState === "listening" ? "ready" : "pending"}>{xReceiverLabel(item.receiverState)}</span></header>
          <p className="nx-binding-count">この受信情報を使う監視：{item.boundMonitorCount}件</p>
          {item.boundMonitorCount === 0 ? <p className="nx-inline-note">{embedded ? "この接続を選び、通知先とタイミングを確認してください。" : "X監視の編集で「使用する自分の受信情報」にこの受信情報を選ぶと、サーバーとの接続を進められます。"}</p> : null}
          <div className="nx-last-received"><span>サーバーが最後に通知データを受け取った日時（日本時間）</span><strong>{item.lastReceivedAtMs === null ? "最初の受信を待っています" : date(item.lastReceivedAtMs)}</strong></div>
          <details className="nx-receiver-details"><summary>接続と受信の詳細</summary><p>{xReceiverDescription(item.receiverState)}</p><p>この日時はデータの受信記録です。通知内容の読み取りや通知先への配信結果は、別に確認します。</p>
          {item.receiptCounts ? <section aria-label="受信データの処理状況" className="nx-receipt-status"><h5>受信データの処理状況</h5><dl className="nx-receipt-counts"><div><dt>処理待ち</dt><dd>{item.receiptCounts.received}件</dd></div><div><dt>振り分け処理済み</dt><dd>{item.receiptCounts.routed}件</dd></div><div><dt>形式の確認が必要</dt><dd>{item.receiptCounts.unsupported}件</dd></div><div><dt>内容の読み取りに失敗</dt><dd>{item.receiptCounts.decryptionFailed}件</dd></div>{item.receiptCounts.unmatched !== undefined ? <div><dt>監視対象との一致を確認できない受信データ</dt><dd>{item.receiptCounts.unmatched}件</dd></div> : null}</dl>
            {item.receiptCounts.unsupported > 0 ? <p role="status">Xからの通知データは届いています。形式の確認が必要な通知が{item.receiptCounts.unsupported}件あり、これらは送信処理に進んでいません。通知データは保管されています。管理者による対応が必要なため、確認間隔を待つだけでは送信されません。</p> : null}
            {item.receiptCounts.decryptionFailed > 0 ? <p role="status">内容を読み取れなかった通知が{item.receiptCounts.decryptionFailed}件あり、これらは送信処理に進んでいません。管理者に受信情報の確認を依頼してください。</p> : null}
            {(item.receiptCounts.unmatched ?? 0) > 0 ? <p role="status">監視対象との一致を確認できず、送信していない受信データ：{item.receiptCounts.unmatched}件。通知データは保管されています。監視するアカウントと、この受信情報の割り当てを確認してください。</p> : null}
            <p className="nx-muted">振り分け処理済みの件数は、通知先への送信成功数とは別です。配信結果は通知履歴で確認できます。</p>
          </section> : null}
          <dl><div><dt>Firefox</dt><dd>{item.browserVersion}</dd></div><div><dt>登録日時（日本時間）</dt><dd>{date(item.createdAtMs)}</dd></div><div><dt>更新日時（日本時間）</dt><dd>{date(item.updatedAtMs)}</dd></div></dl></details>
          <footer>{embedded ? <button type="button" className="nx-primary" disabled={!active || busy || loading || chosenId !== null || item.receiverState === "requires_reenrollment"} onClick={() => chooseSubscription(item)}>この接続を使う<ArrowRight size={16} aria-hidden="true" /></button> : <a href={monitorLink(item.id)} className="nx-text-link">この接続の監視を開く<ArrowRight size={14} aria-hidden="true" /></a>}<button className={`${button} text-destructive`} disabled={!active || busy || loading || chosenId !== null} onClick={() => { clearFile(); setDeleting(item.id); }}>受信情報を削除</button></footer>
          {deleting === item.id ? <section aria-label="受信情報の削除確認" className="nx-feedback nx-feedback-error"><p>この受信情報を削除すると、これを使う{item.boundMonitorCount}件の監視は受信情報の再登録・設定まで停止します。監視するアカウントと利用枠は保持します。X・Firefox側の通知を止める場合は、それぞれの設定で解除してください。</p><div className="nx-actions"><button className={`${button} text-destructive`} disabled={!active || busy || loading} onClick={() => void remove(item)}>この受信情報を削除</button><button className={button} disabled={busy} onClick={() => setDeleting(null)}>削除を取り消す</button></div></section> : null}
        </article>)}
        {status?.nextCursor ? <button className={button} disabled={!active || busy || loading} onClick={() => { clearFile(); void load(status.nextCursor ?? undefined); }}>受信情報をさらに表示</button> : null}
      </section>
      {registered ? <div className="nx-setup-maintenance"><details><summary>PCを閉じる前に</summary><p>専用Firefoxを閉じたまま使えます。「サーバー接続を確認済み」と表示されたら、実際のX通知が通知先に届くことを確認してください。確認後は、PCの電源を切って使えます。専用Firefoxとサーバーが同時に接続すると、受信が競合する場合があります。</p></details><button className={button} disabled={!active || busy || chosenId !== null} onClick={() => { clearFile(); setConsent(false); focusStage.current = !adding; setAdding(value => !value); setStage("prepare"); }}>{adding ? "追加の手順を閉じる" : "受信情報を追加・登録し直す"}</button></div> : null}
      {showPreparation ? <section aria-label="X通知の接続手順" className="nx-onboarding"><ol className="nx-stepper" aria-label="X接続の手順"><li aria-current={stage === "prepare" ? "step" : undefined}><span>{stage === "upload" ? <Check size={16} aria-hidden="true" /> : "1"}</span>PCで準備</li><li aria-current={stage === "upload" ? "step" : undefined}><span>2</span>ファイルを登録</li><li><span>3</span>{embedded ? "通知先とタイミング" : "接続を確認"}</li></ol>
        {stage === "prepare" ? <div className="nx-preparation"><header ref={stagePanel} tabIndex={-1} className="nx-stage-focus"><h3>PCでファイルを作成</h3></header><ol className="nx-instruction-list">
          {registered && listening > 0 ? <li><Radio size={22} aria-hidden="true" /><div><h4>追加の設定後は専用Firefoxを閉じる</h4><p>アカウントを追加したら、専用Firefoxのウィンドウをすべて閉じて、この画面に戻ってください。サーバーと専用Firefoxの同時接続では、通知の受信が競合する場合があります。</p></div></li> : null}
          <li><Download size={22} aria-hidden="true" /><div><h4>保存ツールをダウンロード</h4><p>初回設定にはWindowsのPCとFirefoxが必要です。ZIPを保存し、右クリックの「すべて展開」で解凍してください。</p><a href={X_SETUP_DOWNLOAD_URL} download className="nx-primary">保存ツール（ZIP）をダウンロード<Download size={15} aria-hidden="true" /></a>{status ? <div className="nx-download-meta"><span>バージョン {status.download.version}</span><details><summary>ダウンロードの照合用情報</summary><p>SHA-256</p><code>{status.download.sha256}</code></details></div> : null}</div></li>
          <li><span className="nx-step-number">2</span><div><h4>専用Firefoxを開く</h4><p>展開先の「ダブルクリックで開始.cmd」を開き、画面の案内に従って、ツール専用のFirefox環境を作ります。普段使いのFirefoxと分けて使えます。</p><p>Firefoxが見つからない場合は「Firefoxを選ぶ」で指定します。</p></div></li>
          <li><span className="nx-step-number">3</span><div><h4>Xにログインして通知を許可</h4><p>専用FirefoxでXにログインし、ブラウザー通知を許可します。通知を受け取りたいアカウントのプロフィールでベルを押し、投稿通知を有効にしてください。</p><p>監視するアカウントごとに登録します。必要な利用枠は、通知方法を選ぶ画面で確認できます。Xのログイン情報は、専用Firefoxで開いたXの画面に入力してください。</p></div></li>
          <li><span className="nx-step-number">4</span><div><h4>Firefoxを閉じてJSONを保存</h4><p>専用Firefoxのウィンドウをすべて閉じ、保存ツールに戻ります。保存先を選び、説明を確認してJSONファイルを作成します。他サイトの通知設定も見つかった場合は、ファイル作成の直前に、その通知の扱いを確認できます。</p><p>ここまでの作業は、ご自身のPC内で完了します。作成したファイルは、次の手順でこの画面からアップロードします。保存先はツールの完了画面に表示されます。</p></div></li>
        </ol><div className="nx-step-actions"><button className="nx-primary" disabled={!active || busy || loading} onClick={openUpload}>ファイルを登録する<ArrowRight size={16} aria-hidden="true" /></button></div></div> : <div className="nx-upload-stage"><header ref={stagePanel} tabIndex={-1} className="nx-stage-focus"><h3>JSONファイルを登録</h3></header>
          <section aria-label="登録するデータと通知の取り扱い" className="nx-consent-information"><h4><ShieldCheck size={18} aria-hidden="true" />登録するデータをご確認ください</h4><p><strong>ファイルに入る情報</strong><br />X通知の受信先、識別子、通知を読み取るための秘密鍵が入ります。Cookie、閲覧履歴、保存パスワード、他サイトの秘密鍵は含みません。</p><p><strong>他サイトの通知について</strong><br />専用Firefoxに他サイトの通知設定もある場合、そのサイトの暗号化された通知や識別情報もサーバーへ届くことがあります。サーバーに届く以上、運営側でそのデータを取得することは可能です。現在は、X以外の通知を受信後に破棄します。別途明確な許可をいただくまでは、復号・利用・保存を行いません。他サイトの通知を利用する際は、あらためて許可を確認します。破棄された通知は、Firefoxでも受け取れなくなる場合があります。</p><p><strong>ファイルの保管</strong><br />ファイルには、X通知を読むための鍵が入っています。ファイル自体は暗号化せずに保存するので、ご自身のPCで保管し、この登録画面にアップロードしてください。登録後、PC上のファイルが不要になったら削除できます。</p><p><strong>利用を終了するとき</strong><br />サービス上の受信情報は、登録一覧から削除できます。X・Firefox側の通知も止めるには、それぞれの設定で通知を解除してください。</p></section>
          {status && !status.available ? <p role="status" className="nx-inline-note">{status.rollout.reasonCode ? xSetupFeedback({ code: status.rollout.reasonCode }) : "現在、ファイルの受付は準備中です。手順の確認と保存ツールのダウンロードができます。"}</p> : null}
          <form aria-label="X通知ファイルの登録" className="nx-upload-form" onSubmit={event => { event.preventDefault(); void validate(); }}><label className="nx-consent-checkbox"><input type="checkbox" checked={consent} disabled={!active || !status?.available || busy || loading} onChange={event => { setConsent(event.target.checked); clearFile(); setError(""); setNotice(""); }} /><span>サーバーでX通知を受信・復号することに同意します。他サイトの通知も届く可能性と、別途許可するまでの破棄方針を確認しました。</span></label><label className="nx-file-field"><FileUp size={24} aria-hidden="true" /><span>保存ツールで作成したJSONファイル（32 KiB以下）</span><input ref={input} type="file" accept=".json,application/json" disabled={!canUpload} onChange={event => void choose(event.target.files?.[0])} /></label><p className="nx-muted">「ファイルの内容を確認」を押すと、このサービスへファイルを送信します。確認画面には、Firefoxのバージョンなど必要な情報だけを表示します。</p>{fileReady ? <p role="status">ファイルを選択しました。「ファイルの内容を確認」で次へ進めます。</p> : null}<div className="nx-actions"><button type="submit" className="nx-primary" disabled={!canUpload || !fileReady}>ファイルの内容を確認<ArrowRight size={16} aria-hidden="true" /></button>{fileReady ? <button type="button" className={button} disabled={busy} onClick={() => { clearFile(); setNotice("ファイルの選択を取り消しました。必要なファイルを選び直せます。"); }}>ファイルの選択を取り消す</button> : null}</div></form>
          {preview ? <section ref={reviewPanel} tabIndex={-1} aria-label="X通知ファイルの登録確認" className="nx-review"><h4>この受信情報を保存します</h4><p>登録できる形式です。対象サイト：X（x.com）、Firefox {preview.browserVersion}、ファイル形式 {preview.formatVersion}。</p><p>{embedded ? "接続を保存して、入力中の通知設定に戻ります。通知先と利用枠を確認してから監視を開始します。" : "次のボタンで、通知を受け取るための情報を保存します。その後、監視するアカウントと通知先を設定し、サーバーの接続状態を確認してください。利用枠は監視するアカウントの登録時に確保します。"}</p><button className="nx-primary" disabled={!canUpload || chosenId !== null} onClick={() => void save()}>この受信情報を登録<Check size={16} aria-hidden="true" /></button></section> : null}
          <button className="nx-text-link" disabled={busy} onClick={() => { clearFile(); setConsent(false); focusStage.current = true; setStage("prepare"); }}>PCでの準備手順を確認</button>
        </div>}
      </section> : null}
      {!registered ? <button className={button} disabled={!active || busy || loading} onClick={() => { clearFile(); setDeleting(null); void load(); }}>受付状態・登録一覧を更新</button> : null}
      {status && !status.receiverEnabled ? <p role="status" className="nx-state-line"><Radio size={15} aria-hidden="true" />サーバーの受信開始待ち</p> : null}
    </>}
  </section>;
}
