"use client";

import Link from "next/link";
import { Eye, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { OutputPreviewCard } from "@/components/preview/output-preview-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DashboardLocale } from "@/lib/i18n";
import type { ProviderPreview } from "@/lib/settings-preview";

type PreviewItem = { providerId: string; label: string; enabled: boolean; preview: ProviderPreview };

export function ProviderPreviewBrowser({ guildId, items, locale }: { guildId: string; items: PreviewItem[]; locale: DashboardLocale }) {
  const ja = locale === "ja";
  const [selectedId, setSelectedId] = useState(items.find(item => item.enabled)?.providerId || items[0]?.providerId || "");
  const selected = items.find(item => item.providerId === selectedId) || items[0];
  if (!selected) return null;
  return <section className="space-y-4">
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-end sm:justify-between">
      <label className="min-w-0 space-y-2 text-sm sm:min-w-64"><span className="font-medium">{ja ? "表示を確認するサービス" : "Service to preview"}</span><select className="min-h-11 w-full min-w-0 rounded-md border bg-card px-3" value={selected.providerId} onChange={event => setSelectedId(event.target.value)}>{items.map(item => <option key={item.providerId} value={item.providerId}>{item.label}</option>)}</select></label>
      <Button asChild className="min-h-11"><Link href={`/dashboard/${guildId}/providers/${selected.providerId}?setting=display_density`}><SlidersHorizontal size={16} aria-hidden="true" />{ja ? "このサービスの表示を調整" : "Adjust this service's display"}</Link></Button>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-sm"><Eye size={16} className="text-muted-foreground" aria-hidden="true" /><h2 className="font-semibold">{selected.label}</h2><Badge tone="muted">{ja ? "サンプル投稿" : "Sample post"}</Badge>{!selected.enabled ? <Badge tone="warning">{ja ? "このサーバーでは展開オフ" : "Expansion off in this server"}</Badge> : null}</div>
    <div className="max-w-3xl"><OutputPreviewCard preview={selected.preview} locale={locale} /></div>
  </section>;
}
