"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { xObject, type XMonitorAPI } from "./x-monitor-view";
import { parseXSetupPreview, parseXSetupSession, parseXSetupStatus, parseXSetupSubscription, X_SETUP_DOWNLOAD_URL, X_SETUP_MAX_FILE_BYTES, xSetupFeedback, xReceiverLabel, xReceiverDescription,
  type XSetupPreview, type XSetupSession, type XSetupStatus, type XSetupSubscription } from "./x-setup-view";

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

export function XNotificationSetup({ api, active = true, initiallyOpen = false, onSubscriptionsChanged }: { api: XMonitorAPI; active?: boolean; initiallyOpen?: boolean; onSubscriptionsChanged?: () => void }) {
  const [opened, setOpened] = useState(initiallyOpen), [status, setStatus] = useState<XSetupStatus | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false), [fileReady, setFileReady] = useState(false), [preview, setPreview] = useState<XSetupPreview | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const mounted = useRef(false), enabled = useRef(active), epoch = useRef(0), fileEpoch = useRef(0), action = useRef(false);
  // Secret file contents and one-use sessions stay in memory only, outside React state.
  const fileText = useRef<string | null>(null), session = useRef<XSetupSession | null>(null), input = useRef<HTMLInputElement>(null);
  const reviewPanel = useRef<HTMLElement>(null), errorMessage = useRef<HTMLParagraphElement>(null), noticeMessage = useRef<HTMLParagraphElement>(null);
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
  const canUpload = Boolean(active && status?.available && consent && !busy && !loading);
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
      onSubscriptionsChanged?.();
      setConsent(false);
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
  return <section aria-label="X通知の受信設定" className="space-y-3 rounded border bg-muted/20 p-4">
    <h3 className="font-medium">X通知をサーバーで受け取る準備</h3>
    <p className="text-sm text-muted-foreground">専用のFirefoxでX通知を設定し、保存したファイルをこの画面にアップロードします。</p>
    {!opened ? <button className={button} disabled={!active} onClick={() => setOpened(true)}>X通知の受信設定を始める</button> : <>
      <p role="status" className="rounded border bg-muted/30 p-3 text-sm">準備版：ファイル作成と登録の手順をご案内しています。実際のX通知を使った受信・配信は、次の確認段階です。受信機能は標準で停止しています。通知を届けるには、サーバー接続と、監視するアカウント・通知先の設定が必要です。接続状態は下の一覧で確認できます。</p>
      {status?.rollout.mode === "supporters" ? <p role="status" className="text-sm">現在は、これまでに寄付いただいた方を対象にしたベータ版です。ご利用にあたり、受付資格と共有枠の空きを確認します。寄付はサービスへの支援であり、ベータ参加や利用枠の購入ではありません。{status.rollout.eligible ? "このアカウントでお申し込みいただけます。" : "受付対象の拡大をお待ちください。"}</p> : null}
      {status?.rollout.mode === "disabled" ? <p role="status" className="text-sm">{xSetupFeedback({ code: "X_ROLLOUT_DISABLED" })}</p> : null}
      <ol className="list-decimal space-y-4 pl-5 text-sm">
        <li className="space-y-2"><h4 className="font-medium">WindowsのPCで保存ツールをダウンロード</h4><p>初回設定にはWindowsのPCとFirefoxが必要です。ZIPを保存し、右クリックの「すべて展開」で解凍してください。</p>
          <a href={X_SETUP_DOWNLOAD_URL} download className={`${button} inline-block`}>X通知データの保存ツール（ZIP）をダウンロード</a>
          {status ? <><p className="text-xs text-muted-foreground">バージョン {status.download.version}</p><details className="text-xs text-muted-foreground"><summary>ダウンロードの照合用情報</summary><p>SHA-256</p><code className="break-all">{status.download.sha256}</code></details></> : null}
        </li>
        <li className="space-y-2"><h4 className="font-medium">ダブルクリックして専用Firefoxを開く</h4><p>展開先の「ダブルクリックで開始.cmd」を開き、画面の案内に従って、ツール専用のFirefox環境を作ります。普段使いのFirefoxと分けて使えます。</p><p>ダブルクリックだけで起動できます。Firefoxが見つからない場合は、画面の「Firefoxを選ぶ」からFirefox本体を選びます。このツールではFirefoxを使用します。</p></li>
        <li className="space-y-2"><h4 className="font-medium">Xにログインして通知を有効にする</h4><p>専用FirefoxでXにログインし、ブラウザー通知を許可します。通知を受け取りたいアカウントのプロフィールでベルを押し、投稿通知を有効にしてください。</p><p>1つの専用環境で複数のアカウントを設定できます。利用枠は、監視するアカウント1件につき1枠です。</p><p>Xのログイン情報は、専用Firefoxで開いたXの画面に入力してください。</p></li>
        <li className="space-y-2"><h4 className="font-medium">専用Firefoxを閉じてファイルを保存</h4><p>専用Firefoxのウィンドウをすべて閉じ、保存ツールに戻ります。保存先を選び、説明を確認してJSONファイルを作成します。他サイトの通知設定も見つかった場合は、ファイル作成の直前に、その通知の扱いを確認できます。</p><p>ここまでの作業は、ご自身のPC内で完了します。作成したファイルは、次の手順でこの画面からアップロードします。保存先はツールの完了画面に表示されます。</p></li>
        <li className="space-y-3"><h4 className="font-medium">この画面に戻ってファイルをアップロード</h4><div className="space-y-3 rounded border p-3"><p><strong>ファイルに入る情報</strong><br />X通知の受信先、識別子、通知を読み取るための秘密鍵が入ります。Cookie、閲覧履歴、保存パスワード、他サイトの秘密鍵は含みません。</p><p><strong>他サイトの通知について</strong><br />専用Firefoxに他サイトの通知設定もある場合、そのサイトの暗号化された通知や識別情報もサーバーへ届くことがあります。サーバーに届く以上、運営側でそのデータを取得することは可能です。現在は、X以外の通知を受信後に破棄します。別途明確な許可をいただくまでは、復号・利用・保存を行いません。他サイトの通知を利用する際は、あらためて許可を確認します。破棄された通知は、Firefoxでも受け取れなくなる場合があります。</p><p><strong>ファイルの保管</strong><br />ファイルには、X通知を読むための鍵が入っています。ファイル自体は暗号化せずに保存するので、ご自身のPCで保管し、この登録画面にアップロードしてください。登録後、PC上のファイルが不要になったら削除できます。</p><p><strong>利用を終了するとき</strong><br />サービス上の受信情報は、下の一覧から削除できます。X・Firefox側の通知も止めるには、それぞれの設定で通知を解除してください。</p></div>
          {status && !status.available ? <p role="status">{status.rollout.reasonCode ? xSetupFeedback({ code: status.rollout.reasonCode }) : "現在、ファイルの受付は準備中です。手順の確認と保存ツールのダウンロードができます。"}</p> : null}
          <form aria-label="X通知ファイルの登録" className="space-y-3" onSubmit={event => { event.preventDefault(); void validate(); }}>
            <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={!active || !status?.available || busy || loading} onChange={event => { setConsent(event.target.checked); clearFile(); setError(""); setNotice(""); }} /><span>サーバーでX通知を受信・復号することに同意します。他サイトの通知も届く可能性と、別途許可するまでの破棄方針を確認しました。</span></label>
            <label className="block space-y-1"><span>保存ツールで作成したJSONファイル（32 KiB以下）</span><input ref={input} type="file" accept=".json,application/json" className="block w-full rounded border p-2 text-sm" disabled={!canUpload} onChange={event => void choose(event.target.files?.[0])} /></label>
            <p className="text-xs text-muted-foreground">「ファイルの内容を確認」を押すと、このサービスへファイルを送信します。確認画面には、Firefoxのバージョンなど必要な情報だけを表示します。</p>
            {fileReady ? <p role="status">ファイルを選択しました。「ファイルの内容を確認」で次へ進めます。</p> : null}
            <button type="submit" className={button} disabled={!canUpload || !fileReady}>ファイルの内容を確認</button>
            {fileReady ? <button type="button" className={button} disabled={busy} onClick={() => { clearFile(); setNotice("ファイルの選択を取り消しました。必要なファイルを選び直せます。"); }}>ファイルの選択を取り消す</button> : null}
          </form>
          {preview ? <section ref={reviewPanel} tabIndex={-1} aria-label="X通知ファイルの登録確認" className="space-y-2 rounded border p-3"><p>登録できる形式です。対象サイト：X（x.com）、Firefox {preview.browserVersion}、ファイル形式 {preview.formatVersion}。</p><p>次のボタンで、通知を受け取るための情報を保存します。その後、監視するアカウントと通知先を設定し、サーバーの接続状態を確認してください。利用枠は監視するアカウントの登録時に確保します。</p><button className={button} disabled={!canUpload} onClick={() => void save()}>この受信情報を登録</button></section> : null}
        </li>
      </ol>
      {loading ? <p role="status" className="text-sm">受付状態と登録一覧を読み込み中…</p> : null}{busy ? <p role="status" className="text-sm">処理中です…</p> : null}
      {error ? <p ref={errorMessage} tabIndex={-1} role="alert" className="text-sm text-destructive">{error}</p> : null}{notice ? <p ref={noticeMessage} tabIndex={-1} role="status" className="text-sm">{notice}</p> : null}
      <button className={button} disabled={!active || busy || loading} onClick={() => { clearFile(); setDeleting(null); void load(); }}>受付状態・登録一覧を更新</button>
      <section aria-label="登録済みのX通知受信情報" className="space-y-3"><h4 className="font-medium">登録済みの受信情報</h4><p className="text-sm text-muted-foreground">「保存済み」は、通知を受け取るための情報をサーバーに保管した状態です。実際の接続状況は、各項目の「サーバー接続」で確認できます。監視するアカウントと通知先は、通知一覧で設定します。</p><p className="text-sm">登録後は、専用Firefoxを閉じたままにしてください。サーバーとFirefoxが同時に接続すると、受信が競合する場合があります。「サーバー接続を確認済み」と表示されたら、実際のX通知が通知先に届くことを確認してください。確認後は、PCの電源を切って使えます。</p><a href="/dashboard/automation" className="inline-block text-sm text-primary underline">通知一覧で監視するアカウントと受信情報を設定</a>
        {status?.subscriptions.map((item, index) => <article key={item.id} aria-label={`受信情報${index + 1}`} className="space-y-2 rounded border p-3 text-sm"><h5 className="font-medium">受信情報 {index + 1}：保存済み</h5><dl className="grid gap-2 sm:grid-cols-2"><div><dt>Firefox</dt><dd>{item.browserVersion}</dd></div><div><dt>登録日時（日本時間）</dt><dd>{date(item.createdAtMs)}</dd></div><div><dt>更新日時（日本時間）</dt><dd>{date(item.updatedAtMs)}</dd></div></dl>
          <p className="font-medium">{xReceiverLabel(item.receiverState)}</p><p>{xReceiverDescription(item.receiverState)}</p><p>この受信情報を使う監視：{item.boundMonitorCount}件</p>
          <p>サーバーが最後に通知データを受け取った日時（日本時間）：{item.lastReceivedAtMs === null ? "最初の受信を待っています" : date(item.lastReceivedAtMs)}。この日時はデータの受信記録です。通知内容の読み取りや通知先への配信結果は、別に確認します。</p>
          {item.receiptCounts ? <section aria-label="受信データの処理状況" className="space-y-2 rounded border p-3">
            <h6 className="font-medium">受信データの処理状況</h6>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div><dt>処理待ち</dt><dd>{item.receiptCounts.received}件</dd></div>
              <div><dt>振り分け処理済み</dt><dd>{item.receiptCounts.routed}件</dd></div>
              <div><dt>形式の確認が必要</dt><dd>{item.receiptCounts.unsupported}件</dd></div>
              <div><dt>内容の読み取りに失敗</dt><dd>{item.receiptCounts.decryptionFailed}件</dd></div>
              {item.receiptCounts.unmatched !== undefined ? <div><dt>監視対象との一致を確認できない受信データ</dt><dd>{item.receiptCounts.unmatched}件</dd></div> : null}
            </dl>
            {item.receiptCounts.unsupported > 0 ? <p role="status">Xからの通知データは届いています。形式の確認が必要な通知が{item.receiptCounts.unsupported}件あり、これらは送信処理に進んでいません。通知データは保管されています。管理者による対応が必要なため、確認間隔を待つだけでは送信されません。</p> : null}
            {item.receiptCounts.decryptionFailed > 0 ? <p role="status">内容を読み取れなかった通知が{item.receiptCounts.decryptionFailed}件あり、これらは送信処理に進んでいません。管理者に受信情報の確認を依頼してください。</p> : null}
            {(item.receiptCounts.unmatched ?? 0) > 0 ? <p role="status">監視対象との一致を確認できず、送信していない受信データ：{item.receiptCounts.unmatched}件。通知データは保管されています。監視するアカウントと、この受信情報の割り当てを確認してください。</p> : null}
            <p className="text-xs text-muted-foreground">振り分け処理済みの件数は、通知先への送信成功数とは別です。配信結果は通知履歴で確認できます。</p>
          </section> : null}
          <button className={`${button} text-destructive`} disabled={!active || busy || loading} onClick={() => { clearFile(); setDeleting(item.id); }}>受信情報を削除</button>
          {deleting === item.id ? <section aria-label="受信情報の削除確認" className="space-y-2"><p>この受信情報を削除すると、これを使う{item.boundMonitorCount}件の監視は受信情報の再登録・設定まで停止します。監視するアカウントと利用枠は保持します。X・Firefox側の通知を止める場合は、それぞれの設定で解除してください。</p><button className={`${button} text-destructive`} disabled={!active || busy || loading} onClick={() => void remove(item)}>この受信情報を削除</button><button className={button} disabled={busy} onClick={() => setDeleting(null)}>削除を取り消す</button></section> : null}
        </article>)}
        {status?.subscriptions.length === 0 ? <p className="text-sm">登録した受信情報は、ここに表示されます。</p> : null}
        {status?.nextCursor ? <button className={button} disabled={!active || busy || loading} onClick={() => { clearFile(); void load(status.nextCursor ?? undefined); }}>受信情報をさらに表示</button> : null}
      </section>
    </>}
  </section>;
}
