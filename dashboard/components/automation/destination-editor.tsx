"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

const field = "w-full rounded border bg-background px-3 py-2 text-sm";
const button = "rounded border bg-background px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
type Guild = { guildId: string; name: string };
type Channel = { id: string; name: string; canCreateWebhook: boolean };
type Props = { api: (path: string, method?: string, body?: any) => Promise<any>; draft: any; onChange: (draft: any) => void;
  guildId?: string; scope: string; canEdit: boolean; busy: boolean; open: boolean; onSave: () => void };

// Keep the destination draft in the parent so closing the dialog preserves it.
// Webhook URLs remain in memory only; no draft is written to browser storage.
export function DestinationEditor({ api, draft, onChange, guildId, scope, canEdit, busy, open, onSave }: Props) {
  const [guilds, setGuilds] = useState<Guild[]>([]), [guildLoading, setGuildLoading] = useState(false), [guildError, setGuildError] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]), [channelLoading, setChannelLoading] = useState(false), [channelError, setChannelError] = useState("");
  const [guildRetry, setGuildRetry] = useState(0), [channelRetry, setChannelRetry] = useState(0);
  const channelEpoch = useRef(0);
  const editing = Boolean(draft.id), nonDm = draft.kind !== "dm";
  const selectedGuild = draft.guildId || guildId || "";
  const chooseGuild = nonDm && !editing && !guildId;
  useEffect(() => {
    if (!open || !chooseGuild) return;
    let alive = true; const controller = new AbortController();
    setGuildLoading(true); setGuildError("");
    void (async () => {
      try {
        const response = await fetch("/api/guilds?purpose=notification-destinations", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Guild choices unavailable");
        const value: unknown = await response.json();
        if (!Array.isArray(value) || value.some(item => !item || typeof item.guildId !== "string" || !/^\d{16,22}$/u.test(item.guildId) || typeof item.name !== "string")) throw new Error("Invalid guild choices");
        if (alive) setGuilds(value.map(item => ({ guildId: item.guildId, name: item.name })));
      } catch { if (alive) { setGuilds([]); setGuildError("サーバー一覧を取得できませんでした。再読み込みすると、もう一度確認できます。"); } }
      finally { if (alive) setGuildLoading(false); }
    })();
    return () => { alive = false; controller.abort(); };
  }, [open, chooseGuild, guildRetry]);
  useEffect(() => {
    const epoch = ++channelEpoch.current;
    setChannels([]); setChannelError(""); setChannelLoading(false);
    if (!open || editing || draft.kind !== "channel" || !selectedGuild) return;
    setChannelLoading(true);
    // Only read candidates here. Creating a Discord webhook requires the
    // explicit save operation after the user selects its channel.
    const path = guildId === selectedGuild ? "channels" : `channels?guildId=${encodeURIComponent(selectedGuild)}`;
    void api(path).then(value => {
      if (epoch !== channelEpoch.current) return;
      if (!Array.isArray(value.items)) throw new Error("Invalid channel choices");
      setChannels(value.items);
    }).catch(() => { if (epoch === channelEpoch.current) setChannelError("チャンネル一覧を取得できませんでした。再読み込みして、Botとご自身の権限を確認してください。"); })
      .finally(() => { if (epoch === channelEpoch.current) setChannelLoading(false); });
    return () => { channelEpoch.current++; };
  }, [api, open, editing, draft.kind, selectedGuild, guildId, channelRetry]);
  const validGuild = Boolean(selectedGuild && (!chooseGuild || !guildLoading && !guildError && guilds.some(item => item.guildId === selectedGuild)));
  const valid = draft.name.trim().length > 0 && (!nonDm || editing || validGuild && (draft.kind === "webhook" ? Boolean(draft.webhookUrl.trim()) : !channelLoading && !channelError && channels.some(item => item.id === draft.channelId && item.canCreateWebhook)));
  return <fieldset disabled={busy}><form aria-label="通知先の登録設定" className="space-y-3" onSubmit={event => { event.preventDefault(); if (valid && !busy) onSave(); }}>
    <label className="block text-sm">通知先の名前<input required maxLength={120} className={field} value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })} /></label>
    <label className="block text-sm">通知先の種類<select disabled={editing} className={field} value={draft.kind} onChange={event => { channelEpoch.current++; setChannels([]); onChange({ ...draft, kind: event.target.value, channelId: "", scope: event.target.value === "dm" ? "private" : guildId ? scope : "private" }); }}><option value="dm">自分のDM</option><option value="channel">チャンネルを選択してBotがWebhookを作成</option><option value="webhook">{editing && draft.createdByBot ? "Botが作成したチャンネル通知先" : "既存Webhook URL"}</option></select></label>
    {chooseGuild ? <div className="space-y-2"><label className="block text-sm">通知先のサーバー<select required disabled={guildLoading} className={field} value={selectedGuild} onChange={event => { channelEpoch.current++; setChannels([]); onChange({ ...draft, guildId: event.target.value, channelId: "" }); }}><option value="">{guildLoading ? "サーバーを読み込み中…" : "サーバーを選択"}</option>{guilds.map(item => <option key={item.guildId} value={item.guildId}>{item.name}</option>)}</select></label>
      {guildError ? <p role="alert" className="text-sm">{guildError}</p> : !guildLoading && guilds.length === 0 ? <p role="status" className="text-sm">Botとご自身が参加しているサーバーが表示されます。通知したいサーバーにBotを追加してから、一覧を再読み込みしてください。</p> : null}
      <button type="button" className={button} disabled={busy || guildLoading} onClick={() => setGuildRetry(value => value + 1)}>サーバーを再読み込み</button></div> : null}
    {nonDm && <label className="block text-sm">編集できる人<select disabled={editing || !guildId} className={field} value={draft.scope} onChange={event => onChange({ ...draft, scope: event.target.value })}><option value="private">自分のみ</option>{guildId && canEdit && <option value="guild">サーバーの編集権限を持つ人</option>}</select></label>}
    {draft.kind === "webhook" && !editing && <label className="block text-sm">DiscordのWebhook URL<input type="password" required autoComplete="off" className={field} value={draft.webhookUrl} onChange={event => onChange({ ...draft, webhookUrl: event.target.value })} /></label>}
    {draft.kind === "channel" && !editing && <div className="space-y-2"><label className="block text-sm">Webhookを作成するチャンネル<select required disabled={!selectedGuild || channelLoading} className={field} value={draft.channelId} onChange={event => onChange({ ...draft, channelId: event.target.value })}><option value="">{channelLoading ? "チャンネルを読み込み中…" : "チャンネルを選択"}</option>{channels.map(item => <option disabled={!item.canCreateWebhook} key={item.id} value={item.id}>#{item.name}{item.canCreateWebhook ? "" : "（Webhook管理権限を確認してください）"}</option>)}</select></label>
      {channelError ? <p role="alert" className="text-sm">{channelError}</p> : selectedGuild && !channelLoading && channels.length === 0 ? <p role="status" className="text-sm">チャンネルの閲覧・送信権限をご確認ください。Webhookの作成には、ご自身とBotのWebhook管理権限も必要です。</p> : null}
      <button type="button" className={button} disabled={busy || !selectedGuild || channelLoading} onClick={() => setChannelRetry(value => value + 1)}>チャンネルを再読み込み</button>
      <p className="text-sm text-muted-foreground">保存すると、Botが選択したチャンネルに通知用Webhookを作成します。Botが以前作成した通知用Webhookがある場合は、そのWebhookを利用します。</p></div>}
    {editing && nonDm ? <p className="text-sm text-muted-foreground">名前と有効状態を変更できます。通知先を変更するときは、新しい通知先を追加し、監視の編集画面で選択してください。</p> : null}
    {nonDm && <p className="automation-critical-note"><Info size={16} aria-hidden="true" />通知はチャンネルを見られる人に届きます。</p>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => onChange({ ...draft, enabled: event.target.checked })} />通知先を有効にする</label>
    <div className="flex gap-2"><button className={button} type="submit" disabled={busy || !valid}>通知先を保存</button></div>
  </form></fieldset>;
}
