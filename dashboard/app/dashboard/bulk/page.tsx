import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/bulk";
import { GuildSwitcher } from "@/components/dashboard/guild-switcher";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { MultiGuildBulkSettingsView } from "@/components/settings/multi-guild-bulk-settings-view";
import { listSwitcherGuilds } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

type Props = { searchParams: Promise<{ guildIds?: string }> };
function parseGuildIds(value: string | undefined) { return [...new Set(String(value || "").split(",").map(item => item.trim()).filter(Boolean))]; }

export default async function MultiGuildBulkPage({ searchParams }: Props) {
  const locale = await getDashboardLocale(), t = createTranslator(locale);
  const session = await requireDashboardSession();
  if (!await usesNewDashboardUI(session)) return <LegacyPage searchParams={searchParams} />;
  const guilds = await listSwitcherGuilds(session);
  const requestedIds = parseGuildIds((await searchParams).guildIds);
  const selectedGuilds = guilds.filter(guild => requestedIds.includes(guild.guildId));
  return <DashboardShell locale={locale} isAdmin={session.user.isAdmin} guilds={guilds} selectedGuildIds={selectedGuilds.map(guild => guild.guildId)}>
    <div className="space-y-5"><header className="dashboard-page-heading"><h1>{t("multiBulk.title")}</h1><span className="dashboard-count">{selectedGuilds.length}</span></header>
      {selectedGuilds.length > 1 ? <MultiGuildBulkSettingsView guilds={selectedGuilds.map(guild => ({ guildId: guild.guildId, name: guild.name, canManageGuild: guild.canManageGuild }))} locale={locale} viewerId={session.user.id} /> : <div className="space-y-3 rounded-xl border bg-card p-5"><h2 className="font-medium">{locale === "ja" ? "変更するサーバーを選択" : "Select servers to edit"}</h2><GuildSwitcher selectedGuildIds={selectedGuilds.map(guild => guild.guildId)} guilds={guilds} locale={locale} /></div>}
    </div>
  </DashboardShell>;
}
