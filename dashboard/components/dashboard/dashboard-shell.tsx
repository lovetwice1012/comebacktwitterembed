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
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <Server size={18} />
            comebacktwitterembed
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <GuildSwitcher selectedGuildIds={[guildId]} guilds={[{ guildId, name: guildName }]} locale={locale} />
            <Badge tone={canEdit ? "success" : "muted"}>{canEdit ? t("shell.badge.canEdit") : t("shell.badge.viewOnly")}</Badge>
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
