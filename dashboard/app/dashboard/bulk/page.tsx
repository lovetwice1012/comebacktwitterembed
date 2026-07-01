import Link from "next/link";
import { Server } from "lucide-react";
import { GuildSwitcher } from "@/components/dashboard/guild-switcher";
import { DashboardWorkspace } from "@/components/dashboard/dashboard-workspace";
import { LanguageSwitcher } from "@/components/dashboard/language-switcher";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { MultiGuildBulkSettingsView } from "@/components/settings/multi-guild-bulk-settings-view";
import { Badge } from "@/components/ui/badge";
import { listSwitcherGuilds } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

type Props = { searchParams: Promise<{ guildIds?: string }> };

function parseGuildIds(value: string | undefined) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

export default async function MultiGuildBulkPage({ searchParams }: Props) {
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const guilds = await listSwitcherGuilds(session);
  const requestedIds = parseGuildIds((await searchParams).guildIds);
  const selectedGuilds = guilds.filter((guild) => requestedIds.includes(guild.guildId));

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col items-stretch gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4">
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2 font-semibold">
            <Server size={18} />
            <span className="truncate">comebacktwitterembed</span>
          </Link>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <GuildSwitcher selectedGuildIds={selectedGuilds.map((guild) => guild.guildId)} guilds={guilds.map((guild) => ({ guildId: guild.guildId, name: guild.name }))} locale={locale} />
            <Badge className="shrink-0" tone="default">{t("multiBulk.badge", { count: selectedGuilds.length })}</Badge>
            <LanguageSwitcher locale={locale} />
            <SignOutButton locale={locale} />
          </div>
        </div>
      </header>
      <DashboardWorkspace initialGuildIds={selectedGuilds.map((guild) => guild.guildId)} locale={locale} defaultLayout="plain">
        <div className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-4 sm:py-5">
          <header className="min-w-0">
            <h1 className="text-2xl font-semibold">{t("multiBulk.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("multiBulk.description")}</p>
          </header>
          {selectedGuilds.length > 1 ? (
            <MultiGuildBulkSettingsView guilds={selectedGuilds.map((guild) => ({ guildId: guild.guildId, name: guild.name, canManageGuild: guild.canManageGuild }))} locale={locale} />
          ) : (
            <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">{t("dashboard.guilds.selectHelp")}</div>
          )}
        </div>
      </DashboardWorkspace>
    </main>
  );
}
