import Link from "next/link";
import { Bot, CircleUserRound, LockKeyhole } from "lucide-react";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { GuildSwitcher } from "@/components/dashboard/guild-switcher";
import { DashboardWorkspace } from "@/components/dashboard/dashboard-workspace";
import { LanguageSwitcher } from "@/components/dashboard/language-switcher";
import type { GuildOption } from "@/components/dashboard/guild-options";
import type { DashboardLocale } from "@/lib/i18n";

export function DashboardShell({ guildId, guildName, canEdit, locale, children, guilds, selectedGuildIds, isAdmin = false, documentNavigation = false }: {
  guildId?: string;
  guildName?: string;
  canEdit?: boolean;
  locale: DashboardLocale;
  children: React.ReactNode;
  guilds?: GuildOption[];
  selectedGuildIds?: string[];
  isAdmin?: boolean;
  documentNavigation?: boolean;
}) {
  const ja = locale === "ja";
  const NavigationLink = documentNavigation ? "a" : Link;
  const selected = selectedGuildIds ?? (guildId ? [guildId] : []);
  const options = guilds ?? (guildId ? [{ guildId, name: guildName || guildId }] : []);
  return <div className="dashboard-app">
    <a href="#dashboard-content" className="dashboard-skip-link">{ja ? "本文へ移動" : "Skip to content"}</a>
    <header data-dashboard-header className="dashboard-app-header">
      <div className="dashboard-app-header-inner">
        <NavigationLink href="/dashboard?mode=user" className="dashboard-brand"><span className="dashboard-brand-icon"><Bot size={21} aria-hidden /></span><span><strong>comebacktwitterembed</strong><small>{ja ? "ダッシュボード" : "Dashboard"}</small></span></NavigationLink>
        <div className="dashboard-header-context">
          {options.length || selected.length ? <GuildSwitcher selectedGuildIds={selected} guilds={options} locale={locale} /> : <span className="dashboard-scope-label"><CircleUserRound size={16} aria-hidden />{ja ? "自分のスペース" : "My space"}</span>}
          {guildId && canEdit === false ? <span className="dashboard-readonly"><LockKeyhole size={14} aria-hidden />{ja ? "閲覧のみ" : "View only"}</span> : null}
        </div>
        <details className="dashboard-account"><summary aria-label={ja ? "アカウント" : "Account"}><CircleUserRound size={19} aria-hidden /><span>{ja ? "アカウント" : "Account"}</span></summary><div className="dashboard-account-panel"><LanguageSwitcher locale={locale} /><SignOutButton locale={locale} /></div></details>
      </div>
    </header>
    <DashboardWorkspace initialGuildIds={selected} defaultGuildId={guildId} guildName={guildName} locale={locale} defaultLayout={guildId ? "server" : "plain"} isAdmin={isAdmin} documentNavigation={documentNavigation}>{children}</DashboardWorkspace>
  </div>;
}
