"use client";

import { AlertTriangle, ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";
import "@/components/settings/settings-workspace.css";

type ProviderOverview = {
  providerId: string;
  label: string;
  domain?: string;
  enabled: boolean;
  enabledByDefault: boolean;
  changedFromDefault: boolean;
  settingCount: number;
  customizedSettingCount: number;
  warnings: string[];
};

export function ProviderList({ guildId, providers, locale }: { guildId: string; providers: ProviderOverview[]; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled" | "changed">("all");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter((provider) => {
      const matchesQuery = !q || [provider.providerId, provider.label, provider.domain].filter(Boolean).join(" ").toLowerCase().includes(q);
      const matchesFilter =
        filter === "all" ||
        (filter === "enabled" && provider.enabled) ||
        (filter === "disabled" && !provider.enabled) ||
        (filter === "changed" && provider.changedFromDefault);
      return matchesQuery && matchesFilter;
    });
  }, [providers, query, filter]);
  const filters = [
    { value: "all", label: t("providers.filter.all"), count: providers.length },
    { value: "enabled", label: t("providers.filter.enabled"), count: providers.filter(provider => provider.enabled).length },
    { value: "disabled", label: t("providers.filter.disabled"), count: providers.filter(provider => !provider.enabled).length },
    { value: "changed", label: t("providers.filter.changed"), count: providers.filter(provider => provider.changedFromDefault).length },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="relative min-w-0 flex-1 basis-full sm:min-w-64 sm:basis-auto">
          <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
          <Input aria-label={t("providers.searchPlaceholder")} className="pl-9" placeholder={t("providers.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="settings-categories" role="group" aria-label={locale === "ja" ? "サービスを絞り込む" : "Filter services"}>
          {filters.map(item => <Button key={item.value} variant={filter === item.value ? "default" : "outline"} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}<span className="text-xs opacity-75">{item.count}</span></Button>)}
        </div>
      </div>

      {!filtered.length && (query || filter !== "all") ? <div className="space-y-3 rounded-md border bg-card p-5"><p className="text-sm text-muted-foreground">{locale === "ja" ? "条件に一致するサービスがありません" : "No matching services"}</p><Button variant="outline" onClick={() => { setQuery(""); setFilter("all"); }}>{locale === "ja" ? "検索条件をクリア" : "Clear filters"}</Button></div> : null}

      <p role="status" className="text-xs text-muted-foreground">{locale === "ja" ? `${filtered.length}サービス` : `${filtered.length} services`}</p>
      <div className="service-directory">
        {filtered.map((provider) => (
          <Link key={provider.providerId} href={`/dashboard/${guildId}/providers/${provider.providerId}`}>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{provider.label}</span><Badge tone={provider.enabled ? "success" : "muted"}>{provider.enabled ? t("providers.enabled") : t("providers.disabled")}</Badge>{provider.customizedSettingCount ? <span className="text-xs text-muted-foreground">{t("providers.changedCount", { count: provider.customizedSettingCount })}</span> : null}</div>
              <div className="break-words text-xs text-muted-foreground">{provider.domain || provider.providerId}</div>
                {provider.warnings.length ? (
                  <div className="flex items-start gap-2 text-sm text-amber-800">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {provider.warnings[0]}
                  </div>
                ) : null}
            </div>
            <span className="flex items-center gap-2 text-sm font-medium"><span className="hidden sm:inline">{locale === "ja" ? "表示を調整" : "Adjust display"}</span><ChevronRight size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" /></span>
          </Link>
        ))}
      </div>
    </div>
  );
}
