import Link from "next/link";
import { Server } from "lucide-react";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { GuildSwitcher } from "@/components/dashboard/guild-switcher";
import { DashboardWorkspace } from "@/components/dashboard/dashboard-workspace";
import { LanguageSwitcher } from "@/components/dashboard/language-switcher";
import { Badge } from "@/components/ui/badge";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

export function DashboardShell({
  guildId,
  guildName,
  canEdit,
  locale,
  children,
}: {
  guildId: string;
  guildName: string;
  canEdit: boolean;
  locale: DashboardLocale;
  children: React.ReactNode;
}) {
  const t = createTranslator(locale);
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col items-stretch gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4">
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2 font-semibold">
            <Server size={18} />
            <span className="truncate">comebacktwitterembed</span>
          </Link>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <GuildSwitcher selectedGuildIds={[guildId]} guilds={[{ guildId, name: guildName }]} locale={locale} />
            <Badge className="shrink-0" tone={canEdit ? "success" : "muted"}>{canEdit ? t("shell.badge.canEdit") : t("shell.badge.viewOnly")}</Badge>
            <LanguageSwitcher locale={locale} />
            <SignOutButton locale={locale} />
          </div>
        </div>
      </header>
      <DashboardWorkspace initialGuildIds={[guildId]} locale={locale} defaultLayout="server" defaultGuildId={guildId}>
        {children}
      </DashboardWorkspace>
    </div>
  );
}
