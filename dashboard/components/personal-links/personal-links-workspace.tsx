"use client";

import { Bookmark, Bell, PackageCheck, ExternalLink, Plus, RefreshCw, Pencil, Trash2, Clock3, LockKeyhole, AlertCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
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
const stockStates: Record<string, [string, string]> = { sold_out: ["売り切れ", "Sold out"], available: ["購入可能", "Available"], unavailable: ["販売期間外", "Unavailable"], unknown: ["未確認", "Not checked"] };
type Form = { url: string; title: string; tags: string; note: string; when: string; timeZone: string; variationId: string };
type Draft = { form: Form; editing: PersonalItem | null; stock: StockOption[]; stockReady: boolean; requestId: string | null };
type Drafts = Partial<Record<PersonalKind, Draft>>;
function localTime(ms: number, zone: string) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch { return ""; }
}
const emptyForm = (): Form => ({ url: "", title: "", tags: "", note: "", when: "", timeZone: "Asia/Tokyo", variationId: "*" });
function itemForm(item: PersonalItem): Form {
  return { url: item.url, title: item.title, tags: (item.tags || []).join(", "), note: item.note || "", timeZone: item.timeZone || "Asia/Tokyo",
    when: item.dueAt ? localTime(item.dueAt, item.timeZone || "Asia/Tokyo") : "", variationId: item.variationId || "*" };
}
function changed(draft: Draft) {
  const initial = draft.editing ? itemForm(draft.editing) : emptyForm();
  return (Object.keys(initial) as (keyof Form)[]).some(key => draft.form[key] !== initial[key]);
}
function readDrafts(raw: string | null): { kind: PersonalKind; drafts: Drafts } | null {
  if (!raw || raw.length > 30000) return null;
  const value = JSON.parse(raw), saved: Drafts = {};
  if (value.version !== 1 || !tabs.some(tab => tab.kind === value.kind) || !value.drafts) return null;
  for (const { kind } of tabs) {
    const draft = value.drafts[kind];
    if (!draft) continue;
    const limits = { url: 2048, title: 512, tags: 410, note: 1000, when: 64, timeZone: 64, variationId: 20 };
    if (!draft.form || !Object.entries(limits).every(([key, limit]) => typeof draft.form[key] === "string" && draft.form[key].length <= limit)) continue;
    const editing = draft.editing;
    if (editing && (editing.kind !== kind || typeof editing.id !== "string" || typeof editing.url !== "string" || typeof editing.title !== "string" || !Number.isFinite(editing.updatedAt))) continue;
    saved[kind] = { form: draft.form, editing: editing || null, stock: [], stockReady: false,
      requestId: typeof draft.requestId === "string" && /^[0-9a-f-]{36}$/i.test(draft.requestId) ? draft.requestId : null };
  }
  return { kind: value.kind, drafts: saved };
}
async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/personal-links/${path}`, { method, credentials: "same-origin", cache: "no-store", signal,
    headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data as T;
}

export function PersonalLinksWorkspace({ locale = "ja", displayName, viewerId }: { locale?: string; displayName: string; viewerId?: string }) {
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
  const [formOpen, setFormOpen] = useState(false), [storageWarning, setStorageWarning] = useState(false);
  const storageKey = viewerId ? `cbte:personal:drafts:${viewerId}` : "";
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const requestId = useRef<string | null>(null), stockRequest = useRef<AbortController | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null), returnFocus = useRef<HTMLElement | null>(null), listScroll = useRef(0);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const drafts = useRef<Drafts>({});
  const currentDraft: Draft = { form, editing, stock, stockReady, requestId: requestId.current };
  const dirty = changed(currentDraft);

  useEffect(() => {
    let restored: ReturnType<typeof readDrafts> = null;
    setStorageWarning(false);
    try { if (storageKey) restored = readDrafts(window.sessionStorage.getItem(storageKey)); } catch { setStorageWarning(true); }
    drafts.current = restored?.drafts || {};
    const restoredKind = restored?.kind || "saved", draft = drafts.current[restoredKind];
    setKind(restoredKind); setForm(draft?.form || emptyForm()); setEditing(draft?.editing || null);
    setStock([]); setStockReady(false); requestId.current = draft?.requestId || null;
    setFormOpen(false); setReadyKey(storageKey);
    if (draft) setNotice(say("未保存の入力を復元しました。", "Unsaved input restored."));
    // Locale changes must not reinitialize edits; ownership is the storage boundary.
  }, [storageKey]);

  function persist(kindToSave: PersonalKind, draft: Draft | null) {
    if (draft && (changed(draft) || draft.editing)) drafts.current[kindToSave] = draft;
    else delete drafts.current[kindToSave];
    if (!storageKey || readyKey !== storageKey) return;
    try {
      if (Object.keys(drafts.current).length) window.sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, kind: kindToSave, drafts: drafts.current }));
      else window.sessionStorage.removeItem(storageKey);
    } catch { setStorageWarning(true); }
  }
  useEffect(() => {
    if (readyKey !== storageKey) return;
    persist(kind, { form, editing, stock, stockReady, requestId: requestId.current });
  }, [kind, form, editing, stock, stockReady, readyKey, storageKey]);
  useEffect(() => {
    if (!dirty && !Object.values(drafts.current).some(draft => draft && changed(draft))) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, kind, form]);
  useEffect(() => {
    if (formOpen) firstField.current?.focus();
  }, [formOpen, editing?.id]);
  function openForm(event?: ReactMouseEvent<HTMLElement>, origin?: HTMLElement) {
    returnFocus.current = origin || event?.currentTarget || document.activeElement as HTMLElement; listScroll.current = window.scrollY;
    setFormOpen(true);
    if (formOpen || window.matchMedia?.("(min-width: 1024px)").matches) firstField.current?.focus();
  }
  function closeForm() {
    setFormOpen(false);
    requestAnimationFrame(() => {
      const origin = returnFocus.current;
      const usable = origin?.isConnected && origin !== document.body && origin !== document.documentElement && !origin.closest('form[aria-label="リンク・通知を登録"],form[aria-label="Save a link or schedule a notification"],[hidden]');
      (usable ? origin : listHeading.current)?.focus();
    });
    if (typeof window.scrollTo === "function" && window.matchMedia?.("(max-width: 1023px)").matches) window.scrollTo({ top: listScroll.current });
  }
  function discard() {
    if (dirty && !window.confirm(say("未保存の入力を破棄しますか？", "Discard unsaved input?"))) return;
    reset(); closeForm(); setNotice(null); setError(null);
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); chooseKind(tabs[next].kind); tabButtons.current[next]?.focus();
  }

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

  function reset() { persist(kind, null); setEditing(null); setForm(emptyForm()); setStock([]); setStockReady(false); setConfirming(null); requestId.current = null; stockRequest.current?.abort(); setStockBusy(false); }
  function chooseKind(next: PersonalKind) {
    if (next === kind) return;
    persist(kind, { form, editing, stock, stockReady, requestId: requestId.current });
    stockRequest.current?.abort(); setStockBusy(false); setConfirming(null);
    const previous = drafts.current[next];
    setForm(previous?.form || emptyForm()); setEditing(previous?.editing || null); setStock(previous?.stock || []);
    setStockReady(previous?.stockReady || false); requestId.current = previous?.requestId || null;
    setKind(next); setPage(1); setFormOpen(false); setError(null); setNotice(previous ? say("下書きに戻りました。未保存です。", "Draft restored. Not saved yet.") : null);
  }
  function change(key: keyof Form, value: string) {
    setForm(current => ({ ...current, [key]: value, ...(key === "url" ? { variationId: "*" } : {}) }));
    requestId.current = null;
    if (key === "url") { stockRequest.current?.abort(); setStock([]); setStockReady(false); setStockBusy(false); }
  }
  function edit(item: PersonalItem, origin?: HTMLElement) {
    if (dirty && !window.confirm(say("未保存の入力を破棄して、この項目を編集しますか？", "Discard unsaved input and edit this entry?"))) return;
    reset(); setEditing(item); setError(null); setNotice(null);
    setForm(itemForm(item));
    if (item.kind === "restock") { setStock([{ id: item.variationId || "*", name: item.variationName || (item.variationId === "*" ? say("商品全体", "Any variation") : item.variationId || ""), state: "unknown" }]); setStockReady(true); }
    openForm(undefined, origin);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    requestId.current ||= crypto.randomUUID();
    persist(kind, { form, editing, stock, stockReady, requestId: requestId.current });
    const body = kind === "saved" ? {
      ...(editing ? { revision: editing.updatedAt } : { url: form.url }), title: form.title,
      tags: [...new Set(form.tags.split(/[,、\n]/).map(t => t.trim()).filter(Boolean))], note: form.note,
    } : { url: form.url, title: form.title, ...(editing ? { revision: editing.updatedAt } : { requestId: requestId.current }),
      ...(kind === "reminder" ? { when: form.when, timeZone: form.timeZone } : { variationId: form.variationId, variationName: stock.find(o => o.id === form.variationId)?.name || "" }) };
    try {
      const result = await request<{ already?: boolean }>(`${kind}${editing ? `/${editing.id}` : ""}`, editing ? "PATCH" : "POST", body);
      setNotice(result.already ? say("保存済みのリンクです。", "Link already saved.") : editing ? say("変更を保存しました。", "Changes saved.") : kind === "saved" ? say("リンクを保存しました。", "Link saved.") : say("通知を登録しました。", "Notification scheduled."));
      reset(); closeForm(); setPage(1); setVersion(v => v + 1);
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
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{say("あとで見る・通知", "Saved links & notifications")}</h1>
      <span className="flex max-w-full items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground"><LockKeyhole size={13} aria-hidden="true" /><span className="break-words">{displayName}</span><span>{say("自分だけ", "Private")}</span></span>
    </header>
    <div className="flex gap-1 overflow-x-auto border-b" role="tablist" aria-label={say("リンクと通知", "Links and notifications")}>
      {tabs.map((tab, index) => <button type="button" role="tab" id={`personal-tab-${tab.kind}`} aria-controls="personal-workspace-panel" tabIndex={kind === tab.kind ? 0 : -1} aria-selected={kind === tab.kind} key={tab.kind} disabled={busy} ref={element => { tabButtons.current[index] = element; }} onKeyDown={event => tabKey(event, index)}
        className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-3 text-xs font-medium sm:gap-2 sm:px-4 sm:text-sm ${kind === tab.kind ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        onClick={() => chooseKind(tab.kind)}><tab.icon size={17} />{ja ? tab.ja : tab.en}</button>)}
    </div>
    {notice && <p role="status" className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm">{notice}</p>}
    {error && <p role="alert" className="break-words rounded-md border border-destructive/30 bg-card p-3 text-sm text-destructive">{error}</p>}
    {storageWarning && <p role="status" className="flex items-start gap-2 rounded-md border bg-accent p-3 text-sm text-accent-foreground"><AlertCircle size={16} className="shrink-0" aria-hidden />{say("下書きを保持できません。閉じる前に保存してください。", "Drafts cannot be retained. Save before closing.")}</p>}
    <div id="personal-workspace-panel" role="tabpanel" aria-labelledby={`personal-tab-${kind}`} className={`grid items-start gap-6 ${formOpen ? "lg:grid-cols-[350px_minmax(0,1fr)]" : ""}`}>
      <form onSubmit={submit} className={`${formOpen ? "block" : "hidden"} min-w-0 space-y-4 rounded-xl border bg-card p-5 shadow-sm`} aria-label={say("リンク・通知を登録", "Save a link or schedule a notification")}>
        <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{editing ? kind === "saved" ? say("保存したリンクを編集", "Edit saved link") : say("通知を編集", "Edit notification") : kind === "saved" ? say("リンクを保存", "Save a link") : kind === "reminder" ? say("見返す日時を選ぶ", "Schedule a reminder") : say("再入荷を待つ商品", "Watch for a restock")}</h2>
          <Button type="button" variant="ghost" disabled={busy} className="shrink-0" onClick={closeForm}>{say("一覧に戻る", "Back to list")}</Button></div>
        {(dirty || editing) && <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{dirty ? say("未保存", "Unsaved") : say("編集中", "Editing")}</span><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={discard}>{say("入力を破棄", "Discard input")}</Button></div>}
        {kind !== "saved" && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Bell size={14} aria-hidden="true" />{say("通知は自分のDiscord DMに届きます。", "Notifications go to your Discord DMs.")}</p>}
        <fieldset disabled={busy} className="space-y-4">
          <label className="block space-y-1 text-sm"><span>{kind === "restock" ? say("BOOTHの商品URL", "BOOTH item URL") : "URL"}</span>
            <input ref={firstField} className={field} type="url" required maxLength={2048} value={form.url} readOnly={kind === "saved" && !!editing} onChange={e => change("url", e.target.value)} placeholder={kind === "restock" ? "https://booth.pm/ja/items/…" : "https://…"} /></label>
          {kind === "saved" ? <details className="rounded-lg border bg-muted/20 p-3" open={!!editing || !!form.title || !!form.tags || !!form.note}><summary className="cursor-pointer text-sm font-medium">{say("タイトル・タグ・メモ", "Title, tags and note")}</summary><div className="mt-4 space-y-4">
            <label className="block space-y-1 text-sm"><span>{say("タイトル（任意）", "Title (optional)")}</span><Input maxLength={512} value={form.title} onChange={e => change("title", e.target.value)} /></label>
            <label className="block space-y-1 text-sm"><span>{say("タグ（カンマ区切り・10個まで）", "Tags (comma-separated, up to 10)")}</span><Input maxLength={410} value={form.tags} onChange={e => change("tags", e.target.value)} placeholder={say("作品, 買い物, 動画", "Art, shopping, videos")} /></label>
            <label className="block space-y-1 text-sm"><span>{say("メモ", "Note")}</span><textarea rows={4} maxLength={1000} className={field} value={form.note} onChange={e => change("note", e.target.value)} /></label>
            <p className="text-right text-xs text-muted-foreground">{form.note.length} / 1000</p>
          </div></details> : <label className="block space-y-1 text-sm"><span>{say("タイトル（任意）", "Title (optional)")}</span><Input maxLength={512} value={form.title} onChange={e => change("title", e.target.value)} /></label>}
          {kind === "reminder" ? <>
            <label className="block space-y-1 text-sm"><span>{say("通知する日時", "Reminder date and time")}</span><input type="datetime-local" required className={field} value={form.when} onChange={e => change("when", e.target.value)} /></label>
            <div className="flex gap-2"><Button type="button" variant="outline" onClick={() => change("when", localTime(Date.now() + 3600000, form.timeZone))}>{say("1時間後", "In 1 hour")}</Button><Button type="button" variant="outline" onClick={() => change("when", localTime(Date.now() + 86400000, form.timeZone))}>{say("24時間後", "In 24 hours")}</Button></div>
            <label className="block space-y-1 text-sm"><span>{say("タイムゾーン", "Time zone")}</span><Input list="personal-timezones" required value={form.timeZone} maxLength={64} onChange={e => change("timeZone", e.target.value)} /></label>
            <datalist id="personal-timezones">{["Asia/Tokyo", "UTC", "America/New_York", "America/Los_Angeles", "Europe/London"].map(zone => <option key={zone} value={zone} />)}</datalist>
            <div className="space-y-1 text-xs text-muted-foreground"><p className="flex items-center gap-2"><Clock3 size={14} aria-hidden="true" />{say("1分後〜366日後", "1 minute to 366 days ahead")}</p><p className="flex items-center gap-2"><AlertCircle size={14} aria-hidden="true" />{say("Discordの状況により通知が遅れる場合があります。", "Discord may delay delivery.")}</p></div>
          </> : kind === "restock" ? <>
            <Button type="button" variant="outline" className="w-full" disabled={stockBusy || !form.url} onClick={() => void loadStock()}>{stockBusy ? say("在庫を確認中…", "Checking availability…") : say("在庫を確認", "Check availability")}</Button>
            {stockReady && variants.length ? <label className="block space-y-1 text-sm"><span>{say("再入荷を待つ対象", "Watch target")}</span><select className={field} value={form.variationId} onChange={e => change("variationId", e.target.value)}>{variants.map(v => <option key={v.id} value={v.id}>{v.name}{v.state ? ` · ${(stockStates[v.state] || stockStates.unknown)[ja ? 0 : 1]}` : ""}</option>)}</select></label> : stockReady ? <p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground"><AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{say("売り切れの商品・バリエーションのみ登録できます。", "Only sold-out items or variations can be watched.")}</p> : null}
            <div className="space-y-1 text-xs text-muted-foreground"><p className="flex items-center gap-2"><Bell size={14} aria-hidden="true" />{say("再入荷したら1回通知", "One notification when back in stock")}</p><p className="flex items-center gap-2"><Clock3 size={14} aria-hidden="true" />{say("通常30分ごとに確認", "Usually checked every 30 minutes")}</p></div>
          </> : null}
          <Button className="w-full gap-2" type="submit" disabled={stockBusy || kind === "restock" && (!stockReady || !variants.length)}><Plus size={16} />{busy ? say("保存中…", "Saving…") : editing ? say("変更を保存", "Save changes") : kind === "saved" ? say("あとで見るに保存", "Save for later") : kind === "reminder" ? say("見返す通知を予約", "Schedule reminder") : say("再入荷通知を登録", "Watch for restock")}</Button>
        </fieldset>
      </form>
      <section className={`${formOpen ? "hidden lg:block" : "block"} min-w-0 space-y-3`} aria-label={say("登録済みの一覧", "Your entries")}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 ref={listHeading} tabIndex={-1} className="font-semibold">{kind === "saved" ? say("保存したリンク", "Saved links") : say("登録した通知", "Scheduled notifications")}</h2><div className="flex flex-wrap gap-1"><Button type="button" variant="outline" disabled={busy} onClick={openForm} className="gap-1"><Plus size={15} />{dirty || editing ? say("編集を続ける", "Resume editing") : kind === "saved" ? say("リンクを追加", "Add a link") : kind === "reminder" ? say("見返す通知を追加", "Add a reminder") : say("再入荷通知を追加", "Add a restock alert")}</Button><Button type="button" variant="ghost" disabled={busy || loading} onClick={() => setVersion(v => v + 1)} className="gap-2"><RefreshCw size={15} />{say("一覧を更新", "Refresh list")}</Button></div></div>
        {kind === "saved" && <form className="flex flex-wrap gap-2" aria-label={say("保存を検索", "Search saved links")} onSubmit={e => { e.preventDefault(); setPage(1); setFilter({ query: query.trim(), tag: tag.trim() }); }}>
          <Input type="search" className="min-w-[160px] flex-1" aria-label={say("タイトル・URL・メモを検索", "Search title, URL or note")} placeholder={say("タイトル・URL・メモを検索", "Search title, URL or note")} value={query} maxLength={100} onChange={e => setQuery(e.target.value)} />
          <Input className="w-36" aria-label={say("タグで絞り込み", "Filter by tag")} placeholder={say("タグで絞り込み", "Filter by tag")} value={tag} maxLength={40} onChange={e => setTag(e.target.value)} /><Button type="submit" variant="outline" disabled={busy}>{say("検索", "Search")}</Button>
        </form>}
        {kind === "saved" && (filter.query || filter.tag) && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/40 px-3 py-2"><span className="text-xs text-muted-foreground">{[filter.query, filter.tag && say(`タグ ${filter.tag}`, `Tag ${filter.tag}`)].filter(Boolean).join("　")}</span><Button type="button" variant="ghost" size="sm" disabled={busy} className="ml-auto" onClick={() => { setQuery(""); setTag(""); setFilter({ query: "", tag: "" }); setPage(1); }}>{say("検索条件をクリア", "Clear filters")}</Button></div>}
        {loading ? <p role="status" className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">{say("読み込み中…", "Loading…")}</p> : loadError ? <div role="alert" className="space-y-3 rounded-xl border bg-card p-6"><p className="text-sm text-destructive">{loadError}</p><Button variant="outline" onClick={() => setVersion(v => v + 1)}>{say("再読み込み", "Retry")}</Button></div> : !items.length ?
          <div role="status" className="space-y-3 rounded-xl border border-dashed p-8 text-center">{(() => { const Icon = tabs.find(tab => tab.kind === kind)!.icon; return <Icon className="mx-auto text-muted-foreground" size={26} aria-hidden="true" />; })()}{kind === "saved" && (filter.query || filter.tag) ? <p className="text-sm text-muted-foreground">{say("検索結果は0件です", "No matching links")}</p> : <Button type="button" disabled={busy} onClick={openForm}><Plus size={15} />{dirty || editing ? say("編集を続ける", "Resume editing") : kind === "saved" ? say("リンクを追加", "Add a link") : kind === "reminder" ? say("見返す通知を追加", "Add a reminder") : say("再入荷通知を追加", "Add a restock alert")}</Button>}</div> : items.map(item => <article key={item.id} className="min-w-0 space-y-3 rounded-xl border bg-card p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3"><a href={item.url} target="_blank" rel="noreferrer" className="min-w-0 break-words font-medium hover:text-primary">{item.title || item.url}<ExternalLink className="ml-2 inline-block shrink-0" size={13} /></a>
              {item.status && <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${["failed", "unknown"].includes(item.status) ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{statuses[item.status]?.[ja ? 0 : 1] || say("状態を確認", "Check status")}</span>}</div>
            {item.title && item.title !== item.url && <p className="truncate text-xs text-muted-foreground" title={item.url}>{item.url}</p>}
            {!!item.tags?.length && <div className="flex flex-wrap gap-1">{item.tags.map(t => <button type="button" key={t} disabled={busy} aria-label={say(`タグ「${t}」で絞り込む`, `Filter by tag ${t}`)} className="break-all rounded border border-transparent bg-primary/5 px-2 py-1 text-xs text-primary hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setTag(t); setPage(1); setFilter(current => ({ ...current, tag: t })); }}>{t}</button>)}</div>}
            {item.note && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{item.note}</p>}
            {item.kind === "reminder" && !!item.dueAt && <p className="text-sm"><Bell className="mr-1 inline" size={14} />{localTime(item.dueAt, item.timeZone || "Asia/Tokyo").replace("T", " ")} · {item.timeZone}</p>}
            {item.kind === "restock" && <p className="text-sm text-muted-foreground">{item.variationId === "*" ? say("商品全体", "Any variation") : item.variationName || item.variationId}</p>}
            {item.status === "unknown" && <p className="text-xs text-muted-foreground">{say("重複を避けるため、自動では再送しません。", "Will not resend automatically to avoid duplicates.")}</p>}
            {item.lastError === "DM_REJECTED" && <p className="text-xs text-destructive">{say("DiscordでDMの受信設定を確認してください。", "Check your Discord DM privacy settings.")}</p>}
            <div className="flex flex-wrap gap-2">{item.editable && <Button variant="outline" disabled={busy} onClick={event => edit(item, event.currentTarget)} className="gap-1"><Pencil size={14} />{item.kind === "saved" ? say("リンクを編集", "Edit link") : say("通知を編集", "Edit notification")}</Button>}
              {item.cancellable && confirming !== item.id && <Button variant="ghost" disabled={busy} onClick={() => setConfirming(item.id)} className="gap-1 text-destructive"><Trash2 size={14} />{item.kind === "saved" ? say("リンクを削除", "Delete link") : say("通知を解除", "Cancel notification")}</Button>}
              {confirming === item.id && <div className="flex flex-wrap items-center gap-2"><span className="text-xs">{item.kind === "saved" ? say("削除すると元に戻せません。", "Deletion cannot be undone.") : say("この通知は今後届かなくなります。", "This notification will no longer be delivered.")}</span><Button variant="destructive" disabled={busy} onClick={() => void remove(item)}>{item.kind === "saved" ? say("リンクを削除", "Delete link") : say("通知を解除", "Cancel notification")}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>{item.kind === "saved" ? say("削除しない", "Keep link") : say("通知を続ける", "Keep notification")}</Button></div>}
            </div>
          </article>)}
        {!loading && !loadError && (page > 1 || hasMore) && <div className="flex items-center justify-between pt-2"><Button variant="outline" disabled={page <= 1 || busy} onClick={() => setPage(p => p - 1)}>{say("前へ", "Previous")}</Button><span className="text-xs text-muted-foreground">{page} {say("ページ", "page")}</span><Button variant="outline" disabled={!hasMore || busy} onClick={() => setPage(p => p + 1)}>{say("次へ", "Next")}</Button></div>}
      </section>
    </div>
  </div>;
}
