import { GuildList } from "@/components/dashboard/guild-list";
import { GuildSwitcher } from "@/components/dashboard/guild-switcher";
import { DashboardWorkspace } from "@/components/dashboard/dashboard-workspace";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { LanguageSwitcher } from "@/components/dashboard/language-switcher";
import { listVisibleGuilds } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

export default async function DashboardPage() {
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const guilds = await listVisibleGuilds(session);

  return (
    <main className="mx-auto min-h-screen max-w-7xl space-y-6 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("dashboard.guilds.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("dashboard.guilds.selectHelp")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GuildSwitcher selectedGuildIds={[]} guilds={guilds.map((guild) => ({ guildId: guild.guildId, name: guild.name }))} locale={locale} />
          <LanguageSwitcher locale={locale} />
          <SignOutButton locale={locale} />
        </div>
      </header>
      <DashboardWorkspace initialGuildIds={[]} locale={locale} defaultLayout="plain">
        <GuildList guilds={guilds} locale={locale} />
      </DashboardWorkspace>
    </main>
  );
}
