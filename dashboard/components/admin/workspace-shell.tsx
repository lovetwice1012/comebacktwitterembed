"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dateRange, navigateAdmin, parseMessageLink, updateAdminLocation, useAdminLocation, type AdminSection } from "@/lib/admin-workspace";
import { Activity, Search, Settings, BarChart3, Wrench, ShieldCheck } from "lucide-react";

const sections = [
  ["home", "概要", Activity], ["investigation", "調査", Search], ["servers", "サーバー・設定", Settings],
  ["analytics", "分析", BarChart3], ["operations", "運用・復旧", Wrench], ["administration", "管理設定", ShieldCheck],
] as const;
export function AdminSidebar() {
  const state = useAdminLocation();
  return <nav aria-label="管理画面" className="flex gap-1 overflow-x-auto lg:sticky lg:top-24 lg:flex-col">{sections.map(([key, label, Icon]) => <button key={key} type="button" aria-current={state.section === key ? "page" : undefined} onClick={() => navigateAdmin(key as AdminSection)} className={`flex shrink-0 items-center gap-3 rounded-lg px-4 py-3 text-left text-sm font-medium transition ${state.section === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon size={18} />{label}</button>)}<Link href="/dashboard/personal-links" className="shrink-0 rounded-lg px-4 py-3 text-sm text-muted-foreground hover:bg-muted">あとで見る・通知</Link></nav>;
}
type Entry = { id: string; name: string; type?: number };
export function AdminContextBar() {
  const state = useAdminLocation();
  const [guilds, setGuilds] = useState<Entry[]>([]), [channels, setChannels] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null), [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false), [link, setLink] = useState("");
  async function loadGuilds(after?: string) {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/admin/directory${after ? `?after=${encodeURIComponent(after)}` : ""}`);
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setGuilds(previous => after ? [...previous, ...data.items] : data.items); setNext(data.nextCursor); setLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : "候補の取得に失敗しました"); }
    finally { setLoading(false); }
  }
  const globalSearch = ["incidents", "notifications"].includes(state.source) && ["search", "incidents"].includes(state.tab);
  const showChannel = !globalSearch && state.section === "investigation" && state.tab !== "incidents";
  useEffect(() => {
    setChannels([]);
    if (!showChannel || !/^\d{1,20}$/.test(state.guildId)) return;
    const controller = new AbortController();
    fetch(`/api/admin/directory?guildId=${encodeURIComponent(state.guildId)}`, { signal: controller.signal }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); setChannels(data.items); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [state.guildId, showChannel]);
  if (state.section === "analytics" && state.report === "overview") return <p className="rounded-md bg-muted px-4 py-2 text-sm">サービス全体の保存規模を表示します。サーバーや期間の条件は適用しません。</p>;
  const scoped = ["investigation", "servers", "analytics"].includes(state.section) && !globalSearch;
  if (!scoped) return globalSearch ? <p className="rounded-md bg-muted px-4 py-2 text-sm">障害・通知はサービス全体の記録です。サーバーや期間の条件は適用しません。</p> : null;
  return <section aria-label="調査対象" className="space-y-3 rounded-lg border bg-card p-4">
    {state.section === "investigation" ? <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); const parsed = parseMessageLink(link); if (!parsed) { setError("Discordのサーバー内の投稿リンクを貼り付けてください"); return; } setError(""); updateAdminLocation({ ...parsed, section: "investigation", tab: "search", source: "runs", outcome: "", selected: "" }); }}><label className="min-w-48 flex-1 text-sm"><span className="mb-1 block">Discordの投稿から調べる</span><Input aria-label="Discordの投稿リンク" placeholder="https://discord.com/channels/…" value={link} onChange={e => setLink(e.target.value)} /></label><Button className="self-end" type="submit">対象を指定</Button></form> : null}
    <div className={`grid gap-3 ${showChannel ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-2"}`}>
      <label className="text-sm"><span className="mb-1 block">サーバー名・ID</span><Input list="admin-guild-options" value={state.guildId} placeholder="候補から選択、またはIDを貼り付け" onFocus={() => { if (!loaded && !loading) void loadGuilds(); }} onChange={e => updateAdminLocation({ guildId: e.target.value, channelId: "", messageId: "", selected: "" }, true)} /><datalist id="admin-guild-options">{guilds.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist>{guilds.find(item => item.id === state.guildId) ? <span className="mt-1 block text-muted-foreground">{guilds.find(item => item.id === state.guildId)?.name}</span> : null}</label>
      {showChannel ? <><label className="text-sm"><span className="mb-1 block">チャンネル名・ID</span><Input list="admin-channel-options" value={state.channelId} placeholder="すべてのチャンネル" onChange={e => updateAdminLocation({ channelId: e.target.value, messageId: "", selected: "" }, true)} /><datalist id="admin-channel-options">{channels.filter(item => item.type !== 4).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist></label><label className="text-sm"><span className="mb-1 block">対象ユーザーID</span><Input value={state.userId} placeholder="すべてのユーザー" onChange={e => updateAdminLocation({ userId: e.target.value, selected: "" }, true)} /></label>{state.tab === "search" ? <label className="text-sm"><span className="mb-1 block">元投稿ID</span><Input value={state.messageId} placeholder="すべての投稿" onChange={e => updateAdminLocation({ messageId: e.target.value, selected: "" }, true)} /></label> : null}</> : null}
    </div>
    {next ? <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadGuilds(next)}>サーバー候補をさらに取得</Button> : null}
    {state.section === "analytics" || (state.section === "investigation" && state.tab === "search") ? <div className="flex flex-wrap items-end gap-2"><label className="text-sm"><span className="mb-1 block">開始（JST）</span><Input type="datetime-local" value={state.from} onChange={e => updateAdminLocation({ from: e.target.value, selected: "" }, true)} /></label><label className="text-sm"><span className="mb-1 block">終了（JST・含まない）</span><Input type="datetime-local" value={state.to} onChange={e => updateAdminLocation({ to: e.target.value, selected: "" }, true)} /></label>{[1, 24, 168].map(hours => <Button size="sm" key={hours} variant="outline" onClick={() => updateAdminLocation({ ...dateRange(hours), selected: "" })}>{hours === 168 ? "7日" : `${hours}時間`}</Button>)}<span className="text-xs text-muted-foreground">{state.section === "analytics" ? "日時は日本時間（JST）" : state.source === "actions" ? "未指定時は全期間" : "未指定時は直近24時間"}</span></div> : null}
    {error ? <p role="status" className="text-sm text-destructive">{error}</p> : null}
  </section>;
}
