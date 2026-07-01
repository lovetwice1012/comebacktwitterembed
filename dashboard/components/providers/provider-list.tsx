"use client";

import { AlertTriangle, Filter, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

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
      const matchesQuery = !q || provider.providerId.includes(q) || provider.label.toLowerCase().includes(q);
      const matchesFilter =
        filter === "all" ||
        (filter === "enabled" && provider.enabled) ||
        (filter === "disabled" && !provider.enabled) ||
        (filter === "changed" && provider.changedFromDefault);
      return matchesQuery && matchesFilter;
    });
  }, [providers, query, filter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-0 flex-1 basis-full sm:min-w-64 sm:basis-auto">
          <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
          <Input className="pl-9" placeholder={t("providers.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="flex w-full items-center gap-2 rounded-md border bg-card px-2 sm:w-auto">
          <Filter size={15} className="text-muted-foreground" />
          <select className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none sm:flex-none" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="all">{t("providers.filter.all")}</option>
            <option value="enabled">{t("providers.filter.enabled")}</option>
            <option value="disabled">{t("providers.filter.disabled")}</option>
            <option value="changed">{t("providers.filter.changed")}</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {filtered.map((provider) => (
          <Link key={provider.providerId} href={`/dashboard/${guildId}/providers/${provider.providerId}`}>
            <Card className="h-full transition hover:border-primary">
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle>{provider.label}</CardTitle>
                    <CardDescription>{provider.domain || provider.providerId}</CardDescription>
                  </div>
                  <Badge className="shrink-0" tone={provider.enabled ? "success" : "muted"}>{provider.enabled ? t("providers.enabled") : t("providers.disabled")}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge tone={provider.enabledByDefault ? "default" : "muted"}>{provider.enabledByDefault ? t("providers.defaultOn") : t("providers.defaultOff")}</Badge>
                  <Badge tone={provider.changedFromDefault ? "warning" : "muted"}>{t("providers.changedCount", { count: provider.customizedSettingCount })}</Badge>
                </div>
                {provider.warnings.length ? (
                  <div className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
                    <AlertTriangle size={16} className="mt-0.5" />
                    {provider.warnings[0]}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
