import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/dashboard";
import { GuildList } from "@/components/dashboard/guild-list";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { listVisibleGuilds } from "@/lib/discord";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";
import { getVisibleGuildProviderSummaries } from "@/lib/guild-provider-summary";

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const locale = await getDashboardLocale();
  const session = await requireDashboardSession();
  if (!await usesNewDashboardUI(session)) return <LegacyPage searchParams={searchParams} />;
  const visibleGuilds = await listVisibleGuilds(session, { loadProviderSummary: false });
  const summaries = await getVisibleGuildProviderSummaries(visibleGuilds.map(guild => guild.guildId)).catch(() => null);
  const guilds = visibleGuilds.map(guild => ({ ...guild, providerSummary: summaries?.get(guild.guildId) ?? null }));
  return <DashboardShell locale={locale} isAdmin={session.user.isAdmin} guilds={guilds.map(guild => ({ guildId: guild.guildId, name: guild.name, canEdit: guild.canEdit, canManageGuild: guild.canManageGuild }))}>
    <section id="servers" className="space-y-5">
      <header className="dashboard-page-heading"><div><span className="dashboard-eyebrow">{locale === "ja" ? "リンク展開の設定" : "Link expansion settings"}</span><h1>{locale === "ja" ? "サーバー一覧" : "Servers"}</h1></div><span className="dashboard-count">{guilds.length}</span></header>
      <GuildList guilds={guilds} locale={locale} />
    </section>
  </DashboardShell>;
}
