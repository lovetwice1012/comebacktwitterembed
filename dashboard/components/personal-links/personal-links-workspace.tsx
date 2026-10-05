"use client";

import { Bookmark, Bell, PackageCheck, ExternalLink, Plus, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PersonalItem, PersonalKind, PersonalList, StockOption } from "@/lib/personal-links-types";

const tabs = [
  { kind: "saved", ja: "あとで見る", en: "Saved links", icon: Bookmark },
  { kind: "reminder", ja: "見返す通知", en: "Reminders", icon: Bell },
  { kind: "restock", ja: "再入荷通知", en: "Restock alerts", icon: PackageCheck },
] as const;
const statuses: Record<string, [string, string]> = {
  watching: ["監視中", "Watching"], pending: ["通知待ち", "Pending"], preparing: ["送信準備中", "Preparing"], sending: ["送信中", "Sending"],
  sent: ["送信済み", "Sent"], cancelled: ["解除済み", "Cancelled"], failed: ["送信失敗", "Failed"], unknown: ["送信結果不明", "Delivery uncertain"], quarantined: ["復旧に伴い停止", "Stopped after recovery"],
};
const stockStates: Record<string, string> = { sold_out: "売り切れ", available: "購入可能", unavailable: "販売期間外など", unknown: "未確認" };
type Form = { url: string; title: string; tags: string; note: string; when: string; timeZone: string; variationId: string };
function localTime(ms: number, zone: string) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch { return ""; }
}
const emptyForm = (): Form => ({ url: "", title: "", tags: "", note: "", when: "", timeZone: "Asia/Tokyo", variationId: "*" });
async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/personal-links/${path}`, { method, credentials: "same-origin", cache: "no-store", signal,
    headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data as T;
}

export function PersonalLinksWorkspace({ locale = "ja", displayName }: { locale?: string; displayName: string }) {
  const ja = locale === "ja", say = (a: string, b: string) => ja ? a : b;
  const [kind, setKind] = useState<PersonalKind>("saved");
  const [form, setForm] = useState<Form>(emptyForm);
  const [editing, setEditing] = useState<PersonalItem | null>(null);
  const [items, setItems] = useState<PersonalItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1), [version, setVersion] = useState(0);
  const [query, setQuery] = useState(""), [tag, setTag] = useState("");
  const [filter, setFilter] = useState({ query: "", tag: "" });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [stock, setStock] = useState<StockOption[]>([]), [stockBusy, setStockBusy] = useState(false);
  const [stockReady, setStockReady] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const requestId = useRef<string | null>(null), stockRequest = useRef<AbortController | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError(null); setItems([]);
    const params = new URLSearchParams({ page: String(page), ...(kind === "saved" ? filter : {}) });
    request<PersonalList>(`${kind}?${params}`, "GET", undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) { setItems(data.items); setHasMore(data.hasMore); } })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, page, version, filter]);
  useEffect(() => () => stockRequest.current?.abort(), []);

  function reset() { setEditing(null); setForm(emptyForm()); setStock([]); setStockReady(false); setConfirming(null); requestId.current = null; stockRequest.current?.abort(); setStockBusy(false); }
  function change(key: keyof Form, value: string) {
    setForm(current => ({ ...current, [key]: value, ...(key === "url" ? { variationId: "*" } : {}) }));
    requestId.current = null;
    if (key === "url") { stockRequest.current?.abort(); setStock([]); setStockReady(false); setStockBusy(false); }
  }
  function edit(item: PersonalItem) {
    reset(); setEditing(item); setError(null); setNotice(null);
    setForm({ url: item.url, title: item.title, tags: (item.tags || []).join(", "), note: item.note || "",
      timeZone: item.timeZone || "Asia/Tokyo", when: item.dueAt ? localTime(item.dueAt, item.timeZone || "Asia/Tokyo") : "", variationId: item.variationId || "*" });
    if (item.kind === "restock") { setStock([{ id: item.variationId || "*", name: item.variationName || (item.variationId === "*" ? say("商品全体", "Any variation") : item.variationId || ""), state: "unknown" }]); setStockReady(true); }
    firstField.current?.focus();
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    requestId.current ||= crypto.randomUUID();
    const body = kind === "saved" ? {
      ...(editing ? { revision: editing.updatedAt } : { url: form.url }), title: form.title,
      tags: [...new Set(form.tags.split(/[,、\n]/).map(t => t.trim()).filter(Boolean))], note: form.note,
    } : { url: form.url, title: form.title, ...(editing ? { revision: editing.updatedAt } : { requestId: requestId.current }),
      ...(kind === "reminder" ? { when: form.when, timeZone: form.timeZone } : { variationId: form.variationId, variationName: stock.find(o => o.id === form.variationId)?.name || "" }) };
    try {
      const result = await request<{ already?: boolean }>(`${kind}${editing ? `/${editing.id}` : ""}`, editing ? "PATCH" : "POST", body);
      setNotice(result.already ? say("すでに保存されているリンクです。", "This link is already saved.") : editing ? say("変更を保存しました。", "Changes saved.") : say("登録しました。Discordからも同じ内容を確認できます。", "Added. You can also find it in Discord."));
      reset(); setPage(1); setVersion(v => v + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : say("保存に失敗しました。", "Could not save.")); }
    finally { setBusy(false); }
  }
  async function remove(item: PersonalItem) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await request(`${kind}/${item.id}`, "DELETE", {}); setConfirming(null);
      if (editing?.id === item.id) reset();
      setNotice(say(kind === "saved" ? "保存したリンクを削除しました。" : "通知を解除しました。", kind === "saved" ? "Saved link removed." : "Notification cancelled."));
      if (items.length === 1 && page > 1) setPage(p => p - 1); else setVersion(v => v + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Request failed"); }
    finally { setBusy(false); }
  }
  async function loadStock() {
    stockRequest.current?.abort(); const controller = new AbortController(); stockRequest.current = controller;
    setStockBusy(true); setError(null);
    try {
      const data = await request<{ options: StockOption[] }>("restock/options", "POST", { url: form.url }, controller.signal);
      if (!controller.signal.aborted) {
        setStock(data.options); setStockReady(true);
        setForm(current => ({ ...current, variationId: data.options.some(option => option.id === current.variationId) ? current.variationId : data.options[0]?.id || "" }));
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Request failed"); }
    finally { if (!controller.signal.aborted) setStockBusy(false); }
  }
  const field = "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
  const variants = stock;

  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="mb-1 text-sm font-medium text-primary">{say("自分のリンクを、必要なときに。", "Your links, when you need them.")}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{say("あとで見る・通知", "Saved links & notifications")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{say("Discordで保存したリンクや通知も、ここから管理できます。通知は自分のDMに届きます。", "Manage links and notifications from Discord here. Notifications arrive in your DMs.")}</p></div>
      <span className="max-w-full break-words rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">{displayName} · {say("本人のみ", "Private")}</span>
    </header>
    <div className="flex gap-1 overflow-x-auto border-b" role="tablist" aria-label={say("管理する内容", "Manage")}>
      {tabs.map(tab => <button type="button" role="tab" aria-selected={kind === tab.kind} key={tab.kind} disabled={busy}
        className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-3 text-xs font-medium sm:gap-2 sm:px-4 sm:text-sm ${kind === tab.kind ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        onClick={() => { reset(); setKind(tab.kind); setPage(1); setError(null); setNotice(null); }}><tab.icon size={17} />{ja ? tab.ja : tab.en}</button>)}
    </div>
    {notice && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
    {error && <p role="alert" className="break-words rounded-md border border-destructive/30 bg-card p-3 text-sm text-destructive">{error}</p>}
    <div className="grid items-start gap-6 lg:grid-cols-[350px_minmax(0,1fr)]">
      <form onSubmit={submit} className="min-w-0 space-y-4 rounded-xl border bg-card p-5 shadow-sm" aria-label={say("登録・編集フォーム", "Entry form")}>
        <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{editing ? say("内容を編集", "Edit entry") : say("新しく登録", "Add an entry")}</h2>
          {editing && <Button type="button" variant="ghost" disabled={busy} onClick={reset}>{say("編集をやめる", "Cancel edit")}</Button>}</div>
        <fieldset disabled={busy} className="space-y-4">
          <label className="block space-y-1 text-sm"><span>{kind === "restock" ? say("BOOTHの商品URL", "BOOTH item URL") : "URL"}</span>
            <input ref={firstField} className={field} type="url" required maxLength={2048} value={form.url} readOnly={kind === "saved" && !!editing} onChange={e => change("url", e.target.value)} placeholder={kind === "restock" ? "https://booth.pm/ja/items/…" : "https://…"} /></label>
          <label className="block space-y-1 text-sm"><span>{say("タイトル（任意）", "Title (optional)")}</span><Input maxLength={512} value={form.title} onChange={e => change("title", e.target.value)} /></label>
          {kind === "saved" ? <>
            <label className="block space-y-1 text-sm"><span>{say("タグ（カンマ区切り・10個まで）", "Tags (comma-separated, up to 10)")}</span><Input maxLength={410} value={form.tags} onChange={e => change("tags", e.target.value)} placeholder={say("作品, 買い物, 動画", "Art, shopping, videos")} /></label>
            <label className="block space-y-1 text-sm"><span>{say("メモ", "Note")}</span><textarea rows={4} maxLength={1000} className={field} value={form.note} onChange={e => change("note", e.target.value)} /></label>
            <p className="text-right text-xs text-muted-foreground">{form.note.length} / 1000</p>
          </> : kind === "reminder" ? <>
            <label className="block space-y-1 text-sm"><span>{say("通知する日時", "Reminder date and time")}</span><input type="datetime-local" required className={field} value={form.when} onChange={e => change("when", e.target.value)} /></label>
            <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => change("when", localTime(Date.now() + 3600000, form.timeZone))}>{say("1時間後", "In 1 hour")}</Button><Button type="button" variant="outline" onClick={() => change("when", localTime(Date.now() + 86400000, form.timeZone))}>{say("24時間後", "In 24 hours")}</Button></div>
            <label className="block space-y-1 text-sm"><span>{say("タイムゾーン", "Time zone")}</span><Input list="personal-timezones" required value={form.timeZone} maxLength={64} onChange={e => change("timeZone", e.target.value)} /></label>
            <datalist id="personal-timezones">{["Asia/Tokyo", "UTC", "America/New_York", "America/Los_Angeles", "Europe/London"].map(zone => <option key={zone} value={zone} />)}</datalist>
            <p className="text-xs leading-relaxed text-muted-foreground">{say("1分後〜366日後で指定できます。Discordの状況によって通知が遅れる場合があります。", "Choose a time from one minute to 366 days ahead. Delivery may be delayed by Discord.")}</p>
          </> : <>
            <Button type="button" variant="outline" className="w-full" disabled={stockBusy || !form.url} onClick={() => void loadStock()}>{stockBusy ? say("商品情報を取得中…", "Loading item…") : say("バリエーションを取得", "Load variations")}</Button>
            {stockReady && variants.length ? <label className="block space-y-1 text-sm"><span>{say("再入荷を待つ対象", "Watch target")}</span><select className={field} value={form.variationId} onChange={e => change("variationId", e.target.value)}>{variants.map(v => <option key={v.id} value={v.id}>{v.name}{v.state ? ` · ${ja ? stockStates[v.state] || "未確認" : v.state}` : ""}</option>)}</select></label> : <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">{stockReady ? say("現在、再入荷待ちにできる売り切れの対象はありません。", "There are no sold-out targets available to watch right now.") : say("商品情報を取得すると、売り切れの対象だけを選べます。", "Load item details to choose a sold-out target.")}</p>}
            <p className="text-xs leading-relaxed text-muted-foreground">{say("初回確認を基準に、売り切れから購入可能に変わったら1回DMします。確認は通常30分間隔です。", "After the initial baseline, a sold-out to available change sends one DM. Checks normally run every 30 minutes.")}</p>
          </>}
          <Button className="w-full gap-2" type="submit" disabled={stockBusy || kind === "restock" && (!stockReady || !variants.length)}><Plus size={16} />{busy ? say("保存中…", "Saving…") : editing ? say("変更を保存", "Save changes") : kind === "saved" ? say("あとで見るに保存", "Save for later") : say("通知を登録", "Register notification")}</Button>
        </fieldset>
      </form>
      <section className="min-w-0 space-y-3" aria-label={say("登録済みの一覧", "Your entries")}>
        <div className="flex items-center justify-between"><h2 className="font-semibold">{say("登録済み", "Your entries")}</h2><Button type="button" variant="ghost" disabled={busy || loading} onClick={() => setVersion(v => v + 1)} className="gap-2"><RefreshCw size={15} />{say("一覧を更新", "Refresh")}</Button></div>
        {kind === "saved" && <form className="flex flex-wrap gap-2" aria-label={say("保存を検索", "Search saved links")} onSubmit={e => { e.preventDefault(); setPage(1); setFilter({ query, tag }); }}>
          <Input className="min-w-[160px] flex-1" aria-label={say("タイトル・URL・メモを検索", "Search title, URL or note")} placeholder={say("タイトル・URL・メモを検索", "Search title, URL or note")} value={query} maxLength={100} onChange={e => setQuery(e.target.value)} />
          <Input className="w-36" aria-label={say("タグで絞り込み", "Filter by tag")} placeholder={say("タグで絞り込み", "Filter by tag")} value={tag} maxLength={40} onChange={e => setTag(e.target.value)} /><Button type="submit" variant="outline" disabled={busy}>{say("検索", "Search")}</Button>
        </form>}
        {loading ? <p role="status" className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">{say("読み込み中…", "Loading…")}</p> : loadError ? <div role="alert" className="space-y-3 rounded-xl border bg-card p-6"><p className="text-sm text-destructive">{loadError}</p><Button variant="outline" onClick={() => setVersion(v => v + 1)}>{say("再読み込み", "Retry")}</Button></div> : !items.length ?
          <div className="rounded-xl border border-dashed p-10 text-center"><Bookmark className="mx-auto mb-3 text-muted-foreground" size={26} /><p className="font-medium">{kind === "saved" && (filter.query || filter.tag) ? say("条件に一致する保存はありません", "No saved links match this search") : say("まだ登録はありません", "No entries yet")}</p><p className="mt-2 text-sm text-muted-foreground">{kind === "saved" && (filter.query || filter.tag) ? say("検索語やタグを変更してみてください。", "Try a different search or tag.") : say("フォームから登録するか、Discordの展開カードのボタンを使ってみてください。", "Add an entry here or use the buttons on a Discord card.")}</p></div> : items.map(item => <article key={item.id} className="min-w-0 space-y-3 rounded-xl border bg-card p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3"><a href={item.url} target="_blank" rel="noreferrer" className="min-w-0 break-words font-medium hover:text-primary">{item.title || item.url}<ExternalLink className="ml-2 inline-block shrink-0" size={13} /></a>
              {item.status && <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${["failed", "unknown"].includes(item.status) ? "bg-red-50 text-red-800" : "bg-muted text-muted-foreground"}`}>{statuses[item.status]?.[ja ? 0 : 1] || say("状態を確認", "Check status")}</span>}</div>
            <p className="truncate text-xs text-muted-foreground">{item.url}</p>
            {!!item.tags?.length && <div className="flex flex-wrap gap-1">{item.tags.map(t => <span key={t} className="break-all rounded bg-primary/5 px-2 py-1 text-xs text-primary">{t}</span>)}</div>}
            {item.note && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{item.note}</p>}
            {item.kind === "reminder" && !!item.dueAt && <p className="text-sm"><Bell className="mr-1 inline" size={14} />{localTime(item.dueAt, item.timeZone || "Asia/Tokyo").replace("T", " ")} · {item.timeZone}</p>}
            {item.kind === "restock" && <p className="text-sm text-muted-foreground">{item.variationId === "*" ? say("商品全体", "Any variation") : item.variationName || item.variationId}</p>}
            {item.status === "unknown" && <p className="text-xs text-muted-foreground">{say("重複を避けるため、自動では再送しません。", "Will not resend automatically to avoid duplicates.")}</p>}
            {item.lastError === "DM_REJECTED" && <p className="text-xs text-destructive">{say("DiscordでDMの受信設定を確認してください。", "Check your Discord DM privacy settings.")}</p>}
            <div className="flex flex-wrap gap-2">{item.editable && <Button variant="outline" disabled={busy} onClick={() => edit(item)} className="gap-1"><Pencil size={14} />{say("編集", "Edit")}</Button>}
              {item.cancellable && confirming !== item.id && <Button variant="ghost" disabled={busy} onClick={() => setConfirming(item.id)} className="gap-1 text-destructive"><Trash2 size={14} />{item.kind === "saved" ? say("削除", "Delete") : say("通知を解除", "Cancel notification")}</Button>}
              {confirming === item.id && <div className="flex flex-wrap items-center gap-2"><span className="text-xs">{item.kind === "saved" ? say("この保存を削除しますか？", "Remove this saved link?") : say("この通知を解除しますか？", "Cancel this notification?")}</span><Button variant="destructive" disabled={busy} onClick={() => void remove(item)}>{say("確定", "Confirm")}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>{say("戻る", "Back")}</Button></div>}
            </div>
          </article>)}
        {!loading && !loadError && <div className="flex items-center justify-between pt-2"><Button variant="outline" disabled={page <= 1 || busy} onClick={() => setPage(p => p - 1)}>{say("前へ", "Previous")}</Button><span className="text-xs text-muted-foreground">{page} {say("ページ", "page")}</span><Button variant="outline" disabled={!hasMore || busy} onClick={() => setPage(p => p + 1)}>{say("次へ", "Next")}</Button></div>}
      </section>
    </div>
  </div>;
}
