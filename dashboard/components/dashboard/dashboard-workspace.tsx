"use client";

import Link from "next/link";
import { Activity, ClipboardList, FileClock, Gauge, Layers3, Search, Server, ShieldCheck, Video } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  type GuildOption,
  loadGuildOptions,
  pushGuildSelection,
  uniqueGuildIds,
} from "@/components/dashboard/guild-options";
import { CrossSettingsView } from "@/components/settings/cross-settings-view";
import { MultiGuildBulkSettingsView } from "@/components/settings/multi-guild-bulk-settings-view";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createTranslator, type DashboardLocale, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { SettingState } from "@/lib/types";

type WorkspaceMode = "plain" | "server";

type CrossSettingsItem = {
  providerId: string;
  providerLabel: string;
  setting: SettingState;
};

type CrossSettingsPayload = {
  guildId: string;
  guildName: string;
  canManageGuild: boolean;
  items: CrossSettingsItem[];
};

const navItems = [
  { href: "", labelKey: "shell.nav.overview", icon: Gauge },
  { href: "providers", labelKey: "shell.nav.providers", icon: Layers3 },
  { href: "settings", labelKey: "shell.nav.settings", icon: Search },
  { href: "preview", labelKey: "shell.nav.preview", icon: ClipboardList },
  { href: "diagnostics", labelKey: "shell.nav.diagnostics", icon: Activity },
  { href: "media", labelKey: "shell.nav.media", icon: Video },
  { href: "logs", labelKey: "shell.nav.logs", icon: FileClock },
  { href: "access", labelKey: "shell.nav.access", icon: ShieldCheck },
] satisfies Array<{ href: string; labelKey: TranslationKey; icon: typeof Gauge }>;

function equalIds(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

function ServerLayout({ guildId, locale, children }: { guildId: string; locale: DashboardLocale; children: ReactNode }) {
  const t = createTranslator(locale);
  return (
    <div className="dashboard-grid mx-auto max-w-7xl gap-4 px-3 py-4 sm:gap-5 sm:px-4 sm:py-5">
      <aside className="dashboard-sidebar">
        {navItems.map((item) => {
          const Icon = item.icon;
          const href = item.href ? `/dashboard/${guildId}/${item.href}` : `/dashboard/${guildId}`;
          return (
            <Link
              key={item.href || "overview"}
              href={href}
              className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground")}
            >
              <Icon size={16} />
              {t(item.labelKey)}
            </Link>
          );
        })}
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}

function useGuildOptions() {
  const [guilds, setGuilds] = useState<GuildOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadGuildOptions()
      .then((items) => {
        if (active) setGuilds(items);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load servers.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { guilds, loading, error };
}

function GuildChooserPane({ locale }: { locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const { guilds, loading, error } = useGuildOptions();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = q ? guilds.filter((guild) => guild.name.toLowerCase().includes(q) || guild.guildId.includes(q)) : guilds;
    return source.slice(0, 120);
  }, [guilds, query]);

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-4 sm:py-5">
      <header>
        <h1 className="text-2xl font-semibold">{t("dashboard.guilds.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("dashboard.guilds.selectHelp")}</p>
      </header>
      <Input placeholder={t("guildList.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {loading ? <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">{t("shell.guildSwitcher.loading")}</div> : null}
      {error ? <div className="rounded-md border bg-card p-4 text-sm text-destructive">{error}</div> : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((guild) => (
          <button key={guild.guildId} type="button" className="block min-w-0 text-left" onClick={() => pushGuildSelection([guild.guildId])}>
            <Card className="h-full transition hover:border-primary hover:shadow-soft">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                {guild.iconUrl ? (
                  <img src={guild.iconUrl} alt="" className="h-10 w-10 rounded-md" />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                    <Server size={18} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate">{guild.name}</CardTitle>
                  <CardDescription className="truncate">{guild.guildId}</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <Badge tone={guild.canEdit ? "success" : "muted"}>{guild.canEdit ? t("guildList.canEdit") : t("guildList.viewOnly")}</Badge>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>
    </div>
  );
}

function SingleGuildSettingsPane({ guildId, locale }: { guildId: string; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<CrossSettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetch(`/api/guilds/${guildId}/settings`, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(json?.error || "Failed to load settings.");
        return json as CrossSettingsPayload;
      })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [guildId, version]);

  if (loading) {
    return (
      <ServerLayout guildId={guildId} locale={locale}>
        <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">{t("shell.guildSwitcher.loading")}</div>
      </ServerLayout>
    );
  }

  if (error || !data) {
    return (
      <ServerLayout guildId={guildId} locale={locale}>
        <div className="rounded-md border bg-card p-4 text-sm text-destructive">{error || "Failed to load settings."}</div>
      </ServerLayout>
    );
  }

  return (
    <ServerLayout guildId={guildId} locale={locale}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{data.guildName}</h1>
          <p className="text-sm text-muted-foreground">{t("settingsCross.description")}</p>
        </header>
        <CrossSettingsView guildId={guildId} items={data.items} canManage={data.canManageGuild} locale={locale} onSaved={() => setVersion((value) => value + 1)} />
      </div>
    </ServerLayout>
  );
}

function MultiGuildBulkPane({ guildIds, locale }: { guildIds: string[]; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const { guilds, loading, error } = useGuildOptions();
  const selected = useMemo(() => {
    const byId = new Map(guilds.map((guild) => [guild.guildId, guild]));
    return guildIds.map((guildId) => byId.get(guildId)).filter((guild): guild is GuildOption => Boolean(guild));
  }, [guildIds, guilds]);

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-4 sm:py-5">
      <header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{t("multiBulk.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("multiBulk.description")}</p>
        </div>
        <Badge className="shrink-0" tone="default">{t("multiBulk.badge", { count: guildIds.length })}</Badge>
      </header>
      {loading ? <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">{t("shell.guildSwitcher.loading")}</div> : null}
      {error ? <div className="rounded-md border bg-card p-4 text-sm text-destructive">{error}</div> : null}
      {!loading && selected.length > 1 ? (
        <MultiGuildBulkSettingsView guilds={selected.map((guild) => ({ guildId: guild.guildId, name: guild.name, canManageGuild: guild.canManageGuild === true }))} locale={locale} />
      ) : null}
      {!loading && selected.length <= 1 ? (
        <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">{t("dashboard.guilds.selectHelp")}</div>
      ) : null}
    </div>
  );
}

export function DashboardWorkspace({
  initialGuildIds,
  locale,
  defaultLayout,
  defaultGuildId,
  children,
}: {
  initialGuildIds: string[];
  locale: DashboardLocale;
  defaultLayout: WorkspaceMode;
  defaultGuildId?: string;
  children: ReactNode;
}) {
  const initial = useMemo(() => uniqueGuildIds(initialGuildIds), [initialGuildIds]);
  const [overrideGuildIds, setOverrideGuildIds] = useState<string[] | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ guildIds?: string[] }>).detail;
      const guildIds = uniqueGuildIds(detail?.guildIds || []);
      setOverrideGuildIds(equalIds(guildIds, initial) ? null : guildIds);
    };
    window.addEventListener("dashboard:guild-selection-change", handler);
    return () => window.removeEventListener("dashboard:guild-selection-change", handler);
  }, [initial]);

  if (overrideGuildIds) {
    if (overrideGuildIds.length === 0) return <GuildChooserPane locale={locale} />;
    if (overrideGuildIds.length === 1) return <SingleGuildSettingsPane guildId={overrideGuildIds[0]} locale={locale} />;
    return <MultiGuildBulkPane guildIds={overrideGuildIds} locale={locale} />;
  }

  if (defaultLayout === "server" && defaultGuildId) {
    return (
      <ServerLayout guildId={defaultGuildId} locale={locale}>
        {children}
      </ServerLayout>
    );
  }

  return <>{children}</>;
}
