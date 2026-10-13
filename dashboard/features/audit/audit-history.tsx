"use client";

import Link from "next/link";
import { Search, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DashboardLocale } from "@/lib/i18n";
import type { AuditHistoryEntry } from "./audit-history-model";

function AuditRecordDetails({ value, locale }: { value: unknown; locale: DashboardLocale }) {
  const [open, setOpen] = useState(false), ja = locale === "ja";
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="rounded-md border p-3"><summary className="cursor-pointer text-xs text-muted-foreground">{ja ? "記録の詳細" : "Record details"}</summary>{open ? <><p className="mt-3 text-xs text-muted-foreground">{ja ? "認証情報は非表示" : "Credentials hidden"}</p><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(value, null, 2)}</pre></> : null}</details>;
}

export function AuditHistory({ entries, guildId, locale }: { entries: AuditHistoryEntry[]; guildId: string; locale: DashboardLocale }) {
  const ja = locale === "ja", [query, setQuery] = useState(""), [provider, setProvider] = useState("all"), [action, setAction] = useState("all");
  const providers = useMemo(() => [...new Map(entries.filter(entry => entry.providerId).map(entry => [entry.providerId, entry.providerLabel])).entries()], [entries]);
  const actions = useMemo(() => [...new Set(entries.map(entry => entry.actionLabel))], [entries]);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return entries.filter(entry => (provider === "all" || entry.providerId === provider) && (action === "all" || entry.actionLabel === action) && (!q || [entry.actor, entry.actorId, entry.actionLabel, entry.providerLabel, ...entry.changes.map(change => change.label), ...entry.facts.map(fact => fact.value)].join(" ").toLocaleLowerCase().includes(q)));
  }, [entries, query, provider, action]);
  return <div className="space-y-4">
    {entries.length ? <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_200px_200px]"><label className="relative"><span className="sr-only">{ja ? "変更履歴を検索" : "Search change history"}</span><Search size={16} aria-hidden="true" className="absolute left-3 top-3 text-muted-foreground" /><Input type="search" className="pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder={ja ? "設定名・操作した人を検索" : "Search settings or people"} /></label><label className="text-sm"><span className="sr-only">{ja ? "サービスで絞り込む" : "Filter by service"}</span><select className="h-10 w-full rounded-md border bg-card px-3" value={provider} onChange={event => setProvider(event.target.value)}><option value="all">{ja ? "すべてのサービス" : "All services"}</option>{providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="text-sm"><span className="sr-only">{ja ? "操作で絞り込む" : "Filter by action"}</span><select className="h-10 w-full rounded-md border bg-card px-3" value={action} onChange={event => setAction(event.target.value)}><option value="all">{ja ? "すべての操作" : "All actions"}</option>{actions.map(label => <option key={label} value={label}>{label}</option>)}</select></label></div> : null}
    {entries.length ? <p role="status" className="text-xs text-muted-foreground">{ja ? `最新${entries.length}件から ${filtered.length}件` : `${filtered.length} of the latest ${entries.length} entries`} <span>JST</span></p> : null}
    <ol className="space-y-3">{filtered.map(entry => <li key={entry.id} className="min-w-0 rounded-xl border bg-card p-4 sm:p-5"><article className="space-y-4"><header className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{entry.actionLabel}</h2><p className="mt-1 text-xs text-muted-foreground">{entry.time} <span className="ml-3">{entry.actor}</span></p></div>{entry.providerLabel ? <span className="rounded bg-muted px-2 py-1 text-xs">{entry.providerLabel}</span> : null}</header>
      {entry.changes.length ? <dl className="divide-y rounded-lg border">{entry.changes.map(change => <div key={change.key} className="grid gap-3 p-3 md:grid-cols-[minmax(130px,.7fr)_minmax(0,1fr)_minmax(0,1fr)]"><dt className="break-words text-sm font-medium">{change.label}</dt><dd className="min-w-0"><span className="block text-xs text-muted-foreground">{ja ? "変更前" : "Before"}</span><p className="mt-1 whitespace-pre-wrap break-words text-sm">{change.before}</p></dd><dd className="min-w-0"><span className="block text-xs text-muted-foreground">{ja ? "変更後" : "After"}</span><p className="mt-1 whitespace-pre-wrap break-words text-sm font-medium">{change.after}</p></dd></div>)}</dl> : null}
      {entry.facts.length ? <dl className="grid gap-2 text-sm sm:grid-cols-2">{entry.facts.map(fact => <div key={fact.label}><dt className="text-xs text-muted-foreground">{fact.label}</dt><dd className="mt-1 break-all">{fact.value}</dd></div>)}</dl> : null}
      <AuditRecordDetails value={entry.details} locale={locale} />
    </article></li>)}</ol>
    {!filtered.length ? <div className="space-y-3 rounded-xl border bg-card p-5"><p className="text-sm text-muted-foreground">{entries.length ? ja ? "一致する変更履歴なし" : "No matching changes" : ja ? "変更履歴 0件" : "0 changes"}</p>{entries.length ? <Button variant="outline" onClick={() => { setQuery(""); setProvider("all"); setAction("all"); }}>{ja ? "検索条件をクリア" : "Clear filters"}</Button> : <Button variant="outline" asChild><Link href={`/dashboard/${guildId}/providers`}><Settings2 size={16} aria-hidden="true" />{ja ? "サーバーの設定を開く" : "Open server settings"}</Link></Button>}</div> : null}
  </div>;
}
