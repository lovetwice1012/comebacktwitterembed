"use client";

import { AlertTriangle, Filter, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ProviderOverview = {
  providerId: string;
  label: string;
  enabled: boolean;
  enabledByDefault: boolean;
  changedFromDefault: boolean;
  settingCount: number;
  customizedSettingCount: number;
  displayDensity?: unknown;
  mediaDisplayMode?: unknown;
  failureDisplayPolicy?: unknown;
  warnings: string[];
};

export function ProviderList({ guildId, providers }: { guildId: string; providers: ProviderOverview[] }) {
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
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
          <Input className="pl-9" placeholder="provider名/IDで検索" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-card px-2">
          <Filter size={15} className="text-muted-foreground" />
          <select className="h-9 bg-transparent text-sm outline-none" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="all">すべて</option>
            <option value="enabled">有効のみ</option>
            <option value="disabled">無効のみ</option>
            <option value="changed">変更あり</option>
          </select>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        {filtered.map((provider) => (
          <Link key={provider.providerId} href={`/dashboard/${guildId}/providers/${provider.providerId}`}>
            <Card className="h-full transition hover:border-primary">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{provider.label}</CardTitle>
                    <CardDescription>{provider.providerId}</CardDescription>
                  </div>
                  <Badge tone={provider.enabled ? "success" : "muted"}>{provider.enabled ? "有効" : "無効"}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge tone={provider.enabledByDefault ? "default" : "muted"}>default {provider.enabledByDefault ? "on" : "off"}</Badge>
                  <Badge tone={provider.changedFromDefault ? "warning" : "muted"}>{provider.customizedSettingCount} changed</Badge>
                  <Badge tone="muted">{provider.settingCount} settings</Badge>
                </div>
                <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-3">
                  <span>density: {String(provider.displayDensity || "standard")}</span>
                  <span>media: {String(provider.mediaDisplayMode || "embed")}</span>
                  <span>failure: {String(provider.failureDisplayPolicy || "silent")}</span>
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
