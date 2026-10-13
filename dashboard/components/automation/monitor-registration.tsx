"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info, Mail, Users } from "lucide-react";
import { sourceGuidance, sourceProvider } from "../../../src/automation/monitor-input";
import { valueLabels } from "./rule-labels";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
type Props = { api: (path: string, method?: string, body?: any) => Promise<any>; monitor: any; kind: string; scope: string;
  guildId?: string; destinations: any[]; rules: any[]; catalog: any; busy: boolean;
  onChange: (value: any) => void; onSourceChange: (source: string) => void; onSave: (value: any) => Promise<void>;
  run: (work: () => Promise<void>) => Promise<void>; refresh: () => Promise<void> };
const languages = [["ja", "日本語 / 日本"], ["en-US", "English / US"], ["en-GB", "English / UK"], ["de", "Deutsch"], ["fr", "Français"], ["ko", "한국어"], ["zh-CN", "简体中文"], ["zh-TW", "繁體中文"]];
const sourceHints: Record<string, string> = { youtube: "チャンネルURL・@ハンドル・UCから始まるID", github: "プロフィールURL・ユーザー名", twitch: "配信チャンネルURL・チャンネル名", spotify: "アーティストURL・ID", pixiv: "作者のプロフィールURL・ユーザーID", booth: "ショップURL・ショップ名", amazon: "短縮URLは商品ページを開いてコピー", steam: "ゲーム・パッケージ・バンドルのURL" };

export function MonitorRegistration({ api, monitor, kind, scope, guildId, destinations, rules, catalog, busy, onChange, onSourceChange, onSave, run, refresh }: Props) {
  const [step, setStep] = useState(0), [preview, setPreview] = useState<any>(null);
  const currentScope = monitor.scope || scope;
  const available = destinations.filter(d => d.enabled && (currentScope !== "guild" || d.scope === "guild"));
  const [destinationMode, setDestinationMode] = useState(monitor.destinationId && available.some(d => d.id === monitor.destinationId) ? "existing" : currentScope === "guild" ? "channel" : "dm");
  const [channelId, setChannelId] = useState(""), [channels, setChannels] = useState<any[]>([]), [channelsLoading, setChannelsLoading] = useState(false), [channelError, setChannelError] = useState("");
  const [channelRetry, setChannelRetry] = useState(0);
  const hintId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (step === 2) formRef.current?.querySelector<HTMLElement>('[aria-label="保存する通知の確認"]')?.focus(); else formRef.current?.querySelector<HTMLElement>('input,select')?.focus(); }, [step]);
  useEffect(() => {
    if (step !== 1 || destinationMode !== "channel") return;
    let active = true; setChannelsLoading(true); setChannelError("");
    api("channels").then(result => { if (active) setChannels(result.items); }).catch(e => { if (active) setChannelError(e.message); })
      .finally(() => { if (active) setChannelsLoading(false); });
    return () => { active = false; };
  }, [api, step, destinationMode, channelRetry]);
  const hint = sourceGuidance(monitor.providerId);
  const destinationLabel = destinationMode === "existing" ? available.find(d => d.id === monitor.destinationId)?.name || "未選択"
    : destinationMode === "dm" ? "自分のDM" : `#${channels.find(c => c.id === channelId)?.name || "未選択"}`;
  const channelDelivery = destinationMode === "channel" || destinationMode === "existing" && available.find(d => d.id === monitor.destinationId)?.kind !== "dm";
  async function advance() {
    if (step === 0) {
      const detected = sourceProvider(monitor.source);
      if (detected && !catalog?.[kind]?.some((p: any) => p.id === detected)) throw new Error(`${valueLabels[detected] || detected}は対象外です。対応サービスのURLを入力してください。`);
      if (kind === "auto" && !monitor.id && catalog?.autoRegistration?.eligible !== true) throw new Error("現在は新着通知を追加できません。利用枠と通知の状態を確認してください。");
      const result = await api(`monitors/${kind}/preview`, "POST", { providerId: monitor.providerId, source: monitor.source, locale: monitor.locale });
      setPreview(result); onChange({ ...monitor, source: result.source }); setStep(1); return;
    }
    if (step === 1) {
      if (destinationMode === "existing" && !available.some(d => d.id === monitor.destinationId)) throw new Error("有効な通知先を選んでください。");
      if (destinationMode === "channel" && !channels.some(c => c.id === channelId && c.canCreateWebhook)) throw new Error("通知できるチャンネルを選んでください。");
      if (kind === "price" && monitor.mode === "threshold" && monitor.maxPriceAmount === "" && monitor.minDiscountPercent === "") throw new Error("価格か割引率の条件を1つ以上入力してください。");
      setStep(2); return;
    }
    let current = monitor;
    if (destinationMode !== "existing") {
      const destination = await api("destinations", "POST", { name: destinationMode === "dm" ? "自分のDM" : destinationLabel,
        kind: destinationMode, scope: destinationMode === "dm" ? "private" : currentScope,
        ...(destinationMode === "channel" ? { channelId } : {}), enabled: true });
      current = { ...monitor, destinationId: destination.id }; onChange(current); setDestinationMode("existing");
      // Retain a successfully created destination if later monitor saving fails.
      // Retrying must use this ID rather than creating another webhook/DM row.
      await refresh();
    }
    await onSave(current);
  }
  const priceCondition = monitor.mode === "change" ? "価格が変わるたびに通知"
    : [monitor.maxPriceAmount !== "" && `価格が${monitor.maxPriceAmount}以下`, monitor.minDiscountPercent !== "" && `割引率が${monitor.minDiscountPercent}%以上`].filter(Boolean).join(" または ");
  return <fieldset disabled={busy}><form ref={formRef} className="monitor-registration space-y-5" onSubmit={event => { event.preventDefault(); void run(advance); }}>
    <ol className="monitor-steps" aria-label="登録の手順">{["対象", "通知先", "確認"].map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {step === 0 && <>
      <label className="block text-sm">{kind === "auto" ? "対象のURL・ID" : "商品URL"}<input autoFocus required maxLength={2000} aria-describedby={hintId} placeholder={hint.placeholder} className={field} value={monitor.source} onChange={e => { setPreview(null); onSourceChange(e.target.value); }} /></label>
      <p id={hintId} className="text-sm text-muted-foreground">{sourceHints[monitor.providerId]}</p>
      <label className="block text-sm">サービス<select className={field} value={monitor.providerId} onChange={e => { setPreview(null); onChange({ ...monitor, providerId: e.target.value }); }}>{catalog?.[kind]?.map((p: any) => <option key={p.id} value={p.id}>{valueLabels[p.id] || p.id}</option>)}</select></label>
      <label className="block text-sm">名前（省略可）<input maxLength={120} className={field} value={monitor.name} onChange={e => onChange({ ...monitor, name: e.target.value })} /></label>
      {kind === "price" && <label className="block text-sm">価格の地域<select className={field} value={monitor.locale} onChange={e => onChange({ ...monitor, locale: e.target.value })}>{languages.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}
    </>}
    {step === 1 && <>
      <div className="monitor-confirm"><strong>{valueLabels[preview.providerId] || preview.providerId}</strong><p className="break-all">{preview.source}</p><small>URL形式を確認済み</small></div>
      <label className="block text-sm">通知先の種類<select className={field} value={destinationMode} onChange={e => setDestinationMode(e.target.value)}>{available.length > 0 && <option value="existing">登録済みの通知先</option>}{currentScope !== "guild" && <option value="dm">自分のDM</option>}{guildId && <option value="channel">サーバーのチャンネル</option>}</select></label>
      {destinationMode === "existing" && <label className="block text-sm">通知先<select required className={field} value={monitor.destinationId} onChange={e => onChange({ ...monitor, destinationId: e.target.value })}><option value="">選んでください</option>{available.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      {destinationMode === "dm" && <p className="automation-critical-note"><Mail size={16} aria-hidden="true" />BotからのDMを受信できる設定が必要です。</p>}
      {destinationMode === "channel" && <><label className="block text-sm">チャンネル<select required disabled={channelsLoading} className={field} value={channelId} onChange={e => setChannelId(e.target.value)}><option value="">{channelsLoading ? "チャンネルを読み込み中…" : "チャンネルを選択"}</option>{channels.map(c => <option key={c.id} disabled={!c.canCreateWebhook} value={c.id}>#{c.name}{c.canCreateWebhook ? "" : "（Webhook管理権限なし）"}</option>)}</select></label>{channelError && <p role="alert">{channelError}</p>}{!channelsLoading && !channelError && channels.length === 0 && <p role="status">選択できるチャンネルがありません。サーバーの権限を確認してください。</p>}<button type="button" className={button} disabled={busy || channelsLoading} onClick={() => setChannelRetry(value => value + 1)}>チャンネルを再読み込み</button></>}
      {kind === "price" && <><label className="block text-sm">通知する条件<select className={field} value={monitor.mode} onChange={e => onChange({ ...monitor, mode: e.target.value })}><option value="change">価格が変わるたび</option><option value="threshold">価格または割引率を指定</option></select></label>{monitor.mode === "threshold" && <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">指定価格以下（商品表示通貨）<input type="number" min="0" step="0.0001" className={field} value={monitor.maxPriceAmount} onChange={e => onChange({ ...monitor, maxPriceAmount: e.target.value })} /></label><label className="text-sm">割引率以上（%）<input type="number" min="0.01" max="100" step="0.01" className={field} value={monitor.minDiscountPercent} onChange={e => onChange({ ...monitor, minDiscountPercent: e.target.value })} /></label><p className="automation-critical-note sm:col-span-2"><Info size={16} aria-hidden="true" />どちらかの条件を満たすと通知します。</p></div>}</>}
      <details className="rounded border p-3"><summary>詳細ルール{kind === "auto" ? "と言語" : ""}</summary><div className="mt-3 space-y-3"><label className="block text-sm">詳細ルール<select className={field} value={monitor.workflowId} onChange={e => onChange({ ...monitor, workflowId: e.target.value })}><option value="">なし（通常の通知）</option>{rules.filter(r => r.scope === currentScope).map(r => <option key={r.id} value={r.id}>{r.name}{r.enabled ? "" : "（未適用・停止中）"}</option>)}</select></label>{kind === "auto" && <label className="block text-sm">通知の言語<select className={field} value={monitor.locale} onChange={e => onChange({ ...monitor, locale: e.target.value })}>{languages.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}</div></details>
    </>}
    {step === 2 && <section tabIndex={-1} className="monitor-review" aria-label="保存する通知の確認"><h3>{monitor.name || "通知を追加"}</h3><dl><dt>対象</dt><dd className="break-all">{preview.source}</dd><dt>通知先</dt><dd>{destinationLabel}</dd><dt>通知する内容</dt><dd>{kind === "auto" ? "新しい投稿" : priceCondition}</dd><dt>確認間隔の目安</dt><dd>約{preview.intervalMinutes}分</dd><dt>編集できる人</dt><dd>{currentScope === "guild" ? "サーバーの編集権限を持つ人" : "自分のみ"}</dd></dl>{channelDelivery && <p className="automation-critical-note automation-critical-note-warning"><Users size={16} aria-hidden="true" />通知はチャンネルを見られる人に届きます。</p>}{!monitor.id && <p className="automation-critical-note"><Info size={16} aria-hidden="true" />{kind === "auto" ? "初回確認より前の投稿は通知しません。" : "初回の価格を基準に通知します。"}</p>}{monitor.id && <p className="automation-critical-note automation-critical-note-warning"><Info size={16} aria-hidden="true" />未送信の通知を取り消します。送信開始後は取り消せない場合があります。</p>}</section>}
    <div className="monitor-form-actions">{step > 0 && <button type="button" className={button} onClick={() => setStep(step - 1)}>戻る</button>}<button type="submit" className={button + " bg-primary text-primary-foreground hover:bg-primary/90"} disabled={busy || step === 1 && destinationMode === "channel" && (channelsLoading || !!channelError)}>{busy ? "処理中…" : step === 0 ? "対象を確認" : step === 1 ? "通知内容を確認" : "通知を保存"}</button></div>
  </form></fieldset>;
}
