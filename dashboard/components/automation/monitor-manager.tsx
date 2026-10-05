"use client";

import { useEffect, useState } from "react";
import { valueLabels } from "./rule-labels";
import { AutomationDialog } from "./automation-dialog";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
type Props = { api: (path: string, method?: string, body?: any) => Promise<any>; guildId?: string; canEdit: boolean; scope: string; destinations: any[]; rules: any[]; refresh: () => Promise<void> };
const newMonitor = (kind: string) => ({ kind, name: "", providerId: kind === "auto" ? "youtube" : "amazon", source: "", locale: "ja", destinationId: "", enabled: true, mode: "change", maxPriceAmount: "", minDiscountPercent: "", workflowId: "" });
function sourceProvider(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const domains: Record<string, string[]> = { youtube: ["youtube.com", "youtu.be"], github: ["github.com"], twitch: ["twitch.tv"], spotify: ["open.spotify.com"], pixiv: ["pixiv.net"], booth: ["booth.pm"], steam: ["store.steampowered.com"], amazon: ["amazon.co.jp", "amazon.com", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.ca", "amazon.it", "amazon.es", "amazon.com.au"] };
    return Object.entries(domains).find(([, names]) => names.some(name => host === name || host.endsWith(`.${name}`)))?.[0];
  } catch { return undefined; }
}
function receiveSummary(row: any) {
  if (row.kind === "auto") return "新しい投稿を通知";
  if (row.mode === "change") return "価格が変わるたびに増減額を通知";
  return [row.maxPriceAmount != null && `価格が${row.maxPriceAmount}以下`, row.minDiscountPercent != null && `割引率が${row.minDiscountPercent}%以上`].filter(Boolean).join(" または ");
}

export function MonitorManager({ api, guildId, canEdit, scope, destinations, rules, refresh }: Props) {
  const [kind, setKind] = useState("auto"), [items, setItems] = useState<any[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<any>(null), [monitor, setMonitor] = useState<any>(null), [dest, setDest] = useState<any>(null), [channels, setChannels] = useState<any[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const editable = (row: any) => row?.scope !== "guild" || canEdit;
  const autoRegistrationAllowed = catalog?.autoRegistration?.eligible === true;
  function begin() {
    const destination = destinations.find(d => d.enabled && (scope !== "guild" || d.scope === "guild"));
    setMonitor({ ...newMonitor(kind), destinationId: destination?.id || "" });
  }
  function changeSource(source: string) {
    const providerId = sourceProvider(source);
    const nextKind = providerId ? ["amazon", "steam"].includes(providerId) ? "price" : "auto" : kind;
    if (monitor.id && nextKind !== kind) { setMonitor({ ...monitor, source }); setError("新着と価格の種類は変更できません。別の通知として追加してください。"); return; }
    setKind(nextKind);
    setMonitor({ ...monitor, source, kind: nextKind, providerId: providerId || monitor.providerId });
  }
  const task = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  async function load(selectedKind = kind, afterId?: string) {
    const result = await api(`monitors/${selectedKind}${afterId ? `?afterId=${encodeURIComponent(afterId)}` : ""}`);
    setItems(old => afterId ? [...old, ...result.items] : result.items); setCursor(result.nextCursor);
  }
  useEffect(() => { let alive = true; Promise.all([api("providers"), api(`monitors/${kind}`)]).then(([providers, result]) => {
    if (alive) { setCatalog(providers); setItems(result.items); setCursor(result.nextCursor); }
  }).catch(e => alive && setError(e.message)); return () => { alive = false; }; }, [api, kind]);
  async function saveMonitor() {
    const input = { ...monitor, name: monitor.name.trim() || monitor.source.trim().slice(0, 120), scope: monitor.scope || scope, expectedRevision: monitor.revision,
      maxPriceAmount: monitor.maxPriceAmount === "" ? null : monitor.maxPriceAmount,
      minDiscountPercent: monitor.minDiscountPercent === "" ? null : monitor.minDiscountPercent };
    const result = await api(`monitors/${kind}${monitor.id ? `/${monitor.id}` : ""}`, monitor.id ? "PATCH" : "POST", input);
    // The target is persisted first. If the optional rule assignment fails, show
    // its saved ID and let the user retry the assignment, not duplicate creation.
    const saved = { ...monitor, id: result.id, revision: result.revision, scope: input.scope };
    setMonitor(saved);
    await load();
    if (monitor.workflowId) await api(`workflows/${monitor.workflowId}/attach`, "POST", { targetKind: kind, targetId: result.id });
    else if (monitor.id) await api(`monitors/${kind}/${result.id}`, "POST", { action: "detach", expectedRevision: result.revision });
    await load(); setMonitor(null); setNotice("通知を保存しました。初回は基準を記録し、過去の投稿は送りません。");
  }
  return <div className="space-y-5">
    {error && !monitor && !dest && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error}</p>}{notice && <p role="status" className="rounded border p-3 text-sm">{notice}</p>}
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex gap-1" aria-label="通知の種類">{[["auto", "新着"], ["price", "価格"]].map(([id, label]) => <button key={id} className={button} aria-pressed={kind === id} disabled={busy || !!monitor} onClick={() => setKind(id)}>{label}</button>)}</div><div className="flex gap-2"><button className="rounded border bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40" disabled={busy || !!monitor || scope === "guild" && !canEdit || kind === "auto" && !autoRegistrationAllowed} onClick={begin}>通知を追加</button><button className={button} disabled={busy} onClick={() => void task(() => load())}>更新</button></div></div>
      {kind === "auto" && catalog && !autoRegistrationAllowed && <p role="status" className="text-sm text-muted-foreground">新着自動展開の登録・再開・対象や通知先の変更は、寄付者のみ利用できます。既存の監視は一覧・停止・削除できます。</p>}
      <div className="grid gap-3 lg:grid-cols-2">{items.map(row => <article key={row.id} className="automation-library-card space-y-3"><div className="flex justify-between gap-3"><h3 className="font-medium break-all">{row.name}</h3><span className="whitespace-nowrap text-xs">{row.enabled ? "監視中" : "停止中"}</span></div>
        <p className="text-sm">{receiveSummary({ ...row, kind })}</p><p className="break-all text-xs text-muted-foreground">{valueLabels[row.providerId] || row.providerId} · {row.scope === "guild" ? "共有" : "個人"} · {row.source}</p>
        <p className="text-xs">通知先: {destinations.find(d => d.id === row.destinationId)?.name || (row.destinationType === "dm" ? "本人のDM（既存設定）" : "既存Webhook（URL非表示）")} · ルール: {rules.find(r => r.id === row.workflowId)?.name || (row.workflowId ? "割り当てあり" : "なし")}</p>
        <p className="text-xs">前回確認: {row.lastCheckedAtMs ? new Date(row.lastCheckedAtMs).toLocaleString() : "未取得"} / 次回予定: {row.nextCheckAtMs ? new Date(row.nextCheckAtMs).toLocaleString() : "調整中"}</p>
        {row.errorCode && <p className="text-xs text-destructive">取得エラー: {row.errorCode}</p>}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !editable(row)} onClick={() => setMonitor({ ...row, maxPriceAmount: row.maxPriceAmount ?? "", minDiscountPercent: row.minDiscountPercent ?? "", destinationId: row.destinationId || "", workflowId: row.workflowId || "" })}>編集</button>
          <button className={button} disabled={busy || !editable(row) || kind === "auto" && !row.enabled && !autoRegistrationAllowed} onClick={() => void task(async () => { await api(`monitors/${kind}/${row.id}`, "PATCH", { expectedRevision: row.revision, enabled: !row.enabled }); await load(); })}>{row.enabled ? "停止" : "再開"}</button>
          <button className={`${button} text-destructive`} disabled={busy || !editable(row)} onClick={() => { if (confirm(`「${row.name}」の監視を削除し、未送信の通知を取り消しますか？共有通知先や他の監視は残ります。`)) void task(async () => { await api(`monitors/${kind}/${row.id}`, "DELETE", { expectedRevision: row.revision }); if (monitor?.id === row.id) setMonitor(null); await load(); }); }}>削除</button></div>
      </article>)}</div>{items.length === 0 && <p className="text-sm text-muted-foreground">監視対象はまだありません。</p>}{cursor && <button className={button} disabled={busy} onClick={() => void task(() => load(kind, cursor))}>続きを読み込む</button>}
      {monitor && <AutomationDialog title={monitor.id ? "通知を編集" : "新しい通知"} busy={busy} error={dest ? undefined : error} onCancel={() => { setMonitor(null); setError(""); }}><fieldset disabled={busy}><form className="space-y-4" onSubmit={e => { e.preventDefault(); void task(saveMonitor); }}>
        <label className="block text-sm">{kind === "auto" ? "アカウントURL / ID" : "商品URL"}<input autoFocus required maxLength={2000} className={field} value={monitor.source} onChange={e => changeSource(e.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">サービス<select className={field} value={monitor.providerId} onChange={e => setMonitor({ ...monitor, providerId: e.target.value })}>{catalog?.[kind]?.map((p: any) => <option key={p.id} value={p.id}>{valueLabels[p.id] || p.id}</option>)}</select></label><label className="block text-sm">名前（省略可）<input maxLength={120} className={field} value={monitor.name} onChange={e => setMonitor({ ...monitor, name: e.target.value })} /></label></div>
        <label className="block text-sm">言語・価格地域<select className={field} value={monitor.locale} onChange={e => setMonitor({ ...monitor, locale: e.target.value })}>{["ja", "en-US", "en-GB", "de", "fr", "ko", "zh-CN", "zh-TW"].map(l => <option key={l}>{l}</option>)}</select></label>
        <label className="block text-sm">通知先<select required className={field} value={monitor.destinationId} onChange={e => setMonitor({ ...monitor, destinationId: e.target.value })}><option value="">通知先を選んでください</option>{destinations.filter(d => d.enabled && ((monitor.scope || scope) !== "guild" || d.scope === "guild")).map(d => <option key={d.id} value={d.id}>{d.name} / {d.kind === "dm" ? "DM" : "Webhook"}</option>)}</select></label>
        <button type="button" className={button} onClick={() => setDest({ name: "", kind: (monitor.scope || scope) === "guild" ? "channel" : "dm", scope: monitor.scope || scope, webhookUrl: "", channelId: "", enabled: true })}>新しい通知先を追加</button>
        {kind === "price" && <><label className="block text-sm">検知方法<select className={field} value={monitor.mode} onChange={e => setMonitor({ ...monitor, mode: e.target.value })}><option value="change">値段が変わるたびに増減額を通知</option><option value="threshold">価格以下 または 割引率以上で通知</option></select></label>{monitor.mode === "threshold" && <div className="grid gap-2 sm:grid-cols-2"><label className="text-sm">指定価格以下（商品表示通貨）<input type="number" min="0" step="0.0001" className={field} value={monitor.maxPriceAmount} onChange={e => setMonitor({ ...monitor, maxPriceAmount: e.target.value })} /></label><label className="text-sm">割引率以上（%）<input type="number" min="0.01" max="100" step="0.01" className={field} value={monitor.minDiscountPercent} onChange={e => setMonitor({ ...monitor, minDiscountPercent: e.target.value })} /></label><p className="text-xs text-muted-foreground sm:col-span-2">どちらか一方以上を指定します。条件が成立した時に通知し、いったん外れて再び成立すれば再通知します。</p></div>}</>}
        <label className="block text-sm">詳細ルール<select className={field} value={monitor.workflowId} onChange={e => setMonitor({ ...monitor, workflowId: e.target.value })}><option value="">なし（通常の通知）</option>{rules.filter(r => r.scope === (monitor.scope || scope)).map(r => <option key={r.id} value={r.id}>{r.name} {r.enabled ? "" : "（未適用・停止中）"}</option>)}</select></label>
        <p className="text-xs text-muted-foreground">変更はこれから取得する通知に使います。編集前の未送信通知はキャンセルされます。既に送信処理が始まった通知は取り消せない場合があります。</p>
        <p className="text-xs text-muted-foreground">保存前に、内容・権利・通知先を自分の責任で確認してください。機械チェックは適法性や安全性を保証しません。この確認で運営の責務が免除されることはありません。</p><div className="flex gap-2"><button type="submit" className={button} disabled={busy || kind === "auto" && !monitor.id && !autoRegistrationAllowed}>確認して通知を保存</button></div>
      </form></fieldset></AutomationDialog>}
    </section>
    <details className="space-y-3 rounded border bg-card p-4"><summary className="font-semibold">通知先の管理</summary><p className="text-sm text-muted-foreground">DMは本人だけに送ります。Webhookはサーバー画面で登録します。登録・削除だけではテスト通知を送信しません。</p>
      <button className={button} disabled={busy} onClick={() => setDest({ name: "", kind: "dm", scope: "private", webhookUrl: "", channelId: "", enabled: true })}>通知先を追加</button>
      <div className="grid gap-2 md:grid-cols-2">{destinations.map(d => <div key={d.id} className="rounded border p-3"><p className="text-sm">{d.name} · {d.kind === "dm" ? "DM" : d.createdByBot ? "Bot作成Webhook" : "既存Webhook"} · {d.enabled ? "有効" : "停止中"}</p><div className="mt-2 flex gap-2"><button className={button} disabled={busy || !editable(d)} onClick={() => setDest({ ...d, webhookUrl: "" })}>名前・状態を編集</button><button className={button} disabled={busy || !editable(d)} onClick={() => { if (confirm("この通知先を削除しますか？割り当てられた未送信通知は送信できなくなります。Discord上のWebhook自体は削除しません。")) void task(async () => { await api(`destinations/${d.id}`, "DELETE", { expectedRevision: d.revision }); await refresh(); }); }}>削除</button></div></div>)}</div>
    </details>
      {dest && <AutomationDialog title={dest.id ? "通知先を編集" : "通知先を追加"} busy={busy} error={error} onCancel={() => { setDest(null); setError(""); }}><fieldset disabled={busy}><form className="space-y-3" onSubmit={e => { e.preventDefault(); void task(async () => { const saved = await api(`destinations${dest.id ? `/${dest.id}` : ""}`, dest.id ? "PATCH" : "POST", { ...dest, expectedRevision: dest.revision }); if (monitor && !dest.id) setMonitor({ ...monitor, destinationId: saved.id }); setDest(null); await refresh(); setNotice("通知先を保存しました。Webhookの秘密URLは再表示しません。"); }); }}>
        <label className="block text-sm">通知先の名前<input required maxLength={120} className={field} value={dest.name} onChange={e => setDest({ ...dest, name: e.target.value })} /></label>
        <label className="block text-sm">通知先の種類<select disabled={!!dest.id} className={field} value={dest.kind} onChange={e => setDest({ ...dest, kind: e.target.value, scope: e.target.value === "dm" ? "private" : scope })}><option value="dm">自分のDM</option>{guildId && <><option value="webhook">既存Webhook URL</option><option value="channel">チャンネルを選んでBotがWebhook作成</option></>}</select></label>
        {dest.kind !== "dm" && <label className="block text-sm">管理する範囲<select disabled={!!dest.id} className={field} value={dest.scope} onChange={e => setDest({ ...dest, scope: e.target.value })}><option value="private">自分だけ</option>{canEdit && <option value="guild">このサーバーで共有</option>}</select></label>}
        {dest.kind === "webhook" && !dest.id && <label className="block text-sm">Webhook URL<input type="password" required autoComplete="off" className={field} value={dest.webhookUrl} onChange={e => setDest({ ...dest, webhookUrl: e.target.value })} /><span className="text-xs text-muted-foreground">Discordの公式URLのみ。サーバー所属とチャンネル権限を検証します。</span></label>}
        {dest.kind === "channel" && <><button type="button" className={button} disabled={busy} onClick={() => void task(async () => setChannels((await api("channels")).items))}>作成できるチャンネルを取得</button><select required aria-label="Webhookを作成するチャンネル" className={field} value={dest.channelId} onChange={e => setDest({ ...dest, channelId: e.target.value })}><option value="">チャンネルを選択</option>{channels.map(c => <option disabled={!c.canCreateWebhook} key={c.id} value={c.id}>#{c.name}{c.canCreateWebhook ? "" : "（Webhook管理権限なし）"}</option>)}</select><p className="text-xs">保存するとBot専用Webhookを作成します。同じBotの専用Webhookがあれば再利用します。</p></>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={dest.enabled} onChange={e => setDest({ ...dest, enabled: e.target.checked })} />通知先を有効にする</label>
        <div className="flex gap-2"><button className={button} type="submit" disabled={busy}>通知先を保存</button></div>
      </form></fieldset></AutomationDialog>}
  </div>;
}
