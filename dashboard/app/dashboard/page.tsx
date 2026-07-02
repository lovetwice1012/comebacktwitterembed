import { redirect } from "next/navigation";
import { GuildList } from "@/components/dashboard/guild-list";
import { GuildSwitcher } from "@/components/dashboard/guild-switcher";
import { DashboardWorkspace } from "@/components/dashboard/dashboard-workspace";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { LanguageSwitcher } from "@/components/dashboard/language-switcher";
import { listVisibleGuilds } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

type Props = { searchParams: Promise<{ mode?: string }> };

export default async function DashboardPage({ searchParams }: Props) {
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const mode = (await searchParams).mode;
  if (session.user.isAdmin && mode !== "user") redirect("/admin");
  const guilds = await listVisibleGuilds(session);

  return (
    <main className="mx-auto min-h-screen max-w-7xl space-y-5 px-3 py-4 sm:space-y-6 sm:px-4 sm:py-6">
      <header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{t("dashboard.guilds.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("dashboard.guilds.selectHelp")}</p>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
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
