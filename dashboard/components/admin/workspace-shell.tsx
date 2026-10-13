"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dateRange, navigateAdmin, parseMessageLink, updateAdminLocation, useAdminLocation, type AdminSection } from "@/lib/admin-workspace";
import { Activity, Search, Settings, BarChart3, Wrench, ShieldCheck, ArrowUpRight, SlidersHorizontal } from "lucide-react";

const sections = [
  ["home", "サービスの状態", Activity], ["investigation", "投稿を調べる", Search], ["servers", "サーバー設定", Settings],
  ["analytics", "利用状況", BarChart3], ["operations", "Bot操作・復旧", Wrench], ["administration", "管理設定", ShieldCheck],
] as const;
export function AdminSidebar() {
  const state = useAdminLocation();
  const renderSection = ([key, label, Icon]: typeof sections[number]) => <button key={key} type="button" aria-current={state.section === key ? "page" : undefined} onClick={() => navigateAdmin(key as AdminSection)} className={`flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${state.section === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon size={18} aria-hidden="true" />{label}</button>;
  return <nav aria-label="管理画面" className="space-y-4 lg:sticky lg:top-24">
    <div className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-1">{sections.slice(0, 4).map(renderSection)}</div>
    <details open={["operations", "administration"].includes(state.section)} className="border-t pt-3">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">詳細な管理</summary>
      <div className="mt-2 grid gap-1 sm:grid-cols-3 lg:grid-cols-1">{sections.slice(4).map(renderSection)}<Link href="/admin/notification-plans" className="rounded-lg px-3 py-3 text-sm text-muted-foreground hover:bg-muted">通知プラン・送信上限</Link><Link href="/admin/auto-watch-intervals" className="rounded-lg px-3 py-3 text-sm text-muted-foreground hover:bg-muted">利用者の自動展開間隔</Link></div>
    </details>
    <Link href="/dashboard/personal-links" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted">あとで見る・通知<ArrowUpRight size={14} aria-hidden="true" /></Link>
  </nav>;
}
export function AdminTaskLauncher() {
  const tasks = [
    { label: "投稿リンクを調べる", icon: Search, open: () => navigateAdmin("investigation", "search") },
    { label: "サーバー設定を変更", icon: Settings, open: () => navigateAdmin("servers") },
    { label: "直近の失敗を確認", icon: Activity, open: () => updateAdminLocation({ section: "investigation", tab: "search", source: "runs", outcome: "D,P,E,U,X", ...dateRange(24), selected: "", channelId: "", userId: "", messageId: "" }) },
    { label: "利用状況を確認", icon: BarChart3, open: () => navigateAdmin("analytics") },
  ];
  return <section aria-label="よく使う作業" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{tasks.map(({ label, icon: Icon, open }) => <button type="button" key={label} onClick={open} className="flex items-center gap-3 rounded-lg border bg-card p-4 text-left text-sm font-medium transition hover:border-primary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Icon size={20} className="shrink-0 text-primary" aria-hidden="true" /><span>{label}</span></button>)}</section>;
}
type Entry = { id: string; name: string; type?: number };
export function AdminContextBar() {
  const state = useAdminLocation();
  const [guilds, setGuilds] = useState<Entry[]>([]), [channels, setChannels] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null), [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false), [link, setLink] = useState("");
  const [guildQuery, setGuildQuery] = useState<{ value: string; scope: string } | null>(null), [showGuilds, setShowGuilds] = useState(false);
  const guildInput = useRef<HTMLInputElement>(null);
  const [expandedFilters, setExpandedFilters] = useState(true);
  useEffect(() => {
    const compact = window.matchMedia?.("(max-width: 639px)");
    if (!compact) return;
    const update = () => setExpandedFilters(!compact.matches);
    update(); compact.addEventListener("change", update);
    return () => compact.removeEventListener("change", update);
  }, []);
  async function loadGuilds(after?: string) {
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/admin/directory${after ? `?after=${encodeURIComponent(after)}` : ""}`);
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setGuilds(previous => [...new Map((after ? [...previous, ...data.items] : data.items).map((item: Entry) => [item.id, item])).values()] as Entry[]); setNext(data.nextCursor); setLoaded(true);
    } catch { setError("サーバー候補を取得できません。IDを入力するか、再取得してください。"); }
    finally { setLoading(false); }
  }
  const globalSearch = ["incidents", "notifications"].includes(state.source) && ["search", "incidents"].includes(state.tab);
  const showChannel = !globalSearch && state.section === "investigation" && state.tab !== "incidents";
  useEffect(() => {
    setChannels([]);
    if (!showChannel || !/^\d{1,20}$/.test(state.guildId)) return;
    const controller = new AbortController();
    fetch(`/api/admin/directory?guildId=${encodeURIComponent(state.guildId)}`, { signal: controller.signal }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); setChannels(data.items); }).catch(() => { if (!controller.signal.aborted) setError("チャンネル候補を取得できません。チャンネルIDを入力してください。"); });
    return () => controller.abort();
  }, [state.guildId, showChannel]);
  if (state.section === "analytics" && state.report === "overview") return <p className="rounded-md bg-muted px-4 py-2 text-sm">サービス全体の保存規模</p>;
  const scoped = ["investigation", "servers", "analytics"].includes(state.section) && !globalSearch;
  if (!scoped) return globalSearch ? <p className="rounded-md bg-muted px-4 py-2 text-sm">サービス全体の障害・通知</p> : null;
  const selectedGuild = guilds.find(item => item.id === state.guildId);
  const activeQuery = guildQuery?.scope === state.guildId ? guildQuery.value : null;
  const visibleGuilds = guilds.filter(item => !activeQuery || `${item.name} ${item.id}`.toLocaleLowerCase().includes(activeQuery.toLocaleLowerCase()));
  const hasFilters = Boolean(state.guildId || state.channelId || state.userId || state.messageId || state.from || state.to || state.outcome || state.actionStatus);
  return <section aria-label="調査対象" className="space-y-3 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-medium"><SlidersHorizontal size={16} aria-hidden="true" />対象・期間</h3>{hasFilters ? <Button size="sm" variant="ghost" onClick={() => { setGuildQuery(null); setLink(""); setError(""); updateAdminLocation({ guildId: "", channelId: "", userId: "", messageId: "", from: "", to: "", outcome: "", actionStatus: "", selected: "" }); }}>絞り込みを解除</Button> : null}</div>
    {state.section === "investigation" && state.tab === "search" ? <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); const parsed = parseMessageLink(link); if (!parsed) { setError("Discordのサーバー内の投稿リンクを貼り付けてください"); return; } setError(""); setGuildQuery(null); updateAdminLocation({ ...parsed, section: "investigation", tab: "search", source: "runs", outcome: "", userId: "", from: "", to: "", selected: "" }); }}><label className="min-w-48 flex-1 text-sm"><span className="mb-1 block">Discordの投稿リンク</span><Input aria-label="Discordの投稿リンク" placeholder="https://discord.com/channels/…" value={link} onChange={e => setLink(e.target.value)} /></label><Button className="self-end" type="submit">この投稿を調べる</Button></form> : null}
    <div className="max-w-xl">
      <div className="text-sm"><label><span className="mb-1 block">サーバー名・ID</span><input ref={guildInput} className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-ring" role="combobox" aria-autocomplete="list" value={activeQuery ?? selectedGuild?.name ?? state.guildId} placeholder="サーバー名で検索、またはIDを入力" aria-expanded={showGuilds} aria-controls="admin-guild-options" onFocus={() => { setShowGuilds(true); if (!loaded && !loading) void loadGuilds(); }} onBlur={e => { if (!e.currentTarget.parentElement?.parentElement?.contains(e.relatedTarget as Node)) setShowGuilds(false); }} onKeyDown={e => { if (e.key === "Escape") { setShowGuilds(false); setGuildQuery(null); } if (["ArrowDown", "ArrowUp"].includes(e.key) && showGuilds) { e.preventDefault(); const candidates = document.querySelectorAll<HTMLButtonElement>("#admin-guild-options [role=option]"); candidates[e.key === "ArrowDown" ? 0 : candidates.length - 1]?.focus(); } }} onChange={e => { const value = e.target.value; const isId = !value || /^\d{1,20}$/.test(value); setGuildQuery({ value, scope: isId ? value : state.guildId }); setShowGuilds(true); if (isId) updateAdminLocation({ guildId: value, channelId: "", messageId: "", selected: "" }, true); }} /></label>
        {showGuilds ? <div className="mt-1 max-h-52 space-y-1 overflow-auto rounded-md border bg-card p-1"><div id="admin-guild-options" role="listbox" aria-label="サーバー候補">{loading && !loaded ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">サーバーを取得中…</p> : null}{visibleGuilds.map(item => <button type="button" role="option" aria-selected={item.id === state.guildId} key={item.id} className="block w-full rounded px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted" onKeyDown={e => { const candidates = [...e.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>("[role=option]")]; const index = candidates.indexOf(e.currentTarget); if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); const nextIndex = e.key === "Home" ? 0 : e.key === "End" ? candidates.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length; candidates[nextIndex]?.focus(); } if (e.key === "Escape") { e.preventDefault(); setGuildQuery(null); guildInput.current?.focus(); setShowGuilds(false); } }} onClick={() => { setGuildQuery(null); guildInput.current?.focus(); setShowGuilds(false); updateAdminLocation({ guildId: item.id, channelId: "", messageId: "", selected: "" }); }}><span className="block font-medium">{item.name}</span><span className="text-xs text-muted-foreground">{item.id}</span></button>)}{loaded && !visibleGuilds.length ? <p className="px-3 py-2 text-xs text-muted-foreground">候補なし</p> : null}</div>{next ? <Button size="sm" variant="ghost" disabled={loading} onClick={() => void loadGuilds(next)}>ほかのサーバーを読み込む</Button> : null}</div> : null}
        {state.guildId ? <p className="mt-1 text-xs text-muted-foreground">対象 {selectedGuild?.name ?? state.guildId}</p> : null}
      </div>
    </div>
    {showChannel || state.section === "analytics" ? <details open={expandedFilters} onToggle={event => setExpandedFilters(event.currentTarget.open)} className="rounded-md border bg-muted/20 p-3"><summary className="cursor-pointer text-sm font-medium">チャンネル・ユーザー・期間で絞り込む</summary><div className="mt-3 grid gap-3 md:grid-cols-3">
      {showChannel ? <><label className="text-sm"><span className="mb-1 block">チャンネル名・ID</span><Input list="admin-channel-options" value={state.channelId} placeholder="すべてのチャンネル" onChange={e => updateAdminLocation({ channelId: e.target.value, messageId: "", selected: "" }, true)} /><datalist id="admin-channel-options">{channels.filter(item => item.type !== 4).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist></label><label className="text-sm"><span className="mb-1 block">対象ユーザーID</span><Input value={state.userId} placeholder="すべてのユーザー" onChange={e => updateAdminLocation({ userId: e.target.value, selected: "" }, true)} /></label>{state.tab === "search" ? <label className="text-sm"><span className="mb-1 block">元投稿ID</span><Input value={state.messageId} placeholder="すべての投稿" onChange={e => updateAdminLocation({ messageId: e.target.value, selected: "" }, true)} /></label> : null}</> : null}
    </div>
    {state.section === "analytics" || (state.section === "investigation" && state.tab === "search") ? <div className="mt-3 flex flex-wrap items-end gap-2"><label className="text-sm"><span className="mb-1 block">開始（JST）</span><Input type="datetime-local" value={state.from} onChange={e => updateAdminLocation({ from: e.target.value, selected: "" }, true)} /></label><label className="text-sm"><span className="mb-1 block">終了（JST・含まない）</span><Input type="datetime-local" value={state.to} onChange={e => updateAdminLocation({ to: e.target.value, selected: "" }, true)} /></label>{[1, 24, 168].map(hours => <Button size="sm" key={hours} variant="outline" onClick={() => updateAdminLocation({ ...dateRange(hours), selected: "" })}>{hours === 168 ? "7日" : `${hours}時間`}</Button>)}<span className="text-xs text-muted-foreground">{state.section === "analytics" ? "日時は日本時間（JST）" : state.source === "actions" ? "未指定時は全期間" : "未指定時は直近24時間"}</span></div> : null}
    </details> : null}
    {error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive"><p>{error}</p>{error.startsWith("サーバー候補") ? <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadGuilds()}>サーバー候補を再取得</Button> : null}</div> : null}
  </section>;
}
