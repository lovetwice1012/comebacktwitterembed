import Link from "next/link";
import { Activity, ClipboardList, FileClock, Gauge, Layers3, Search, Server, Video } from "lucide-react";
import { SignOutButton } from "@/components/dashboard/auth-buttons";
import { LanguageSwitcher } from "@/components/dashboard/language-switcher";
import { Badge } from "@/components/ui/badge";
import { createTranslator, type DashboardLocale, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "", labelKey: "shell.nav.overview", icon: Gauge },
  { href: "providers", labelKey: "shell.nav.providers", icon: Layers3 },
  { href: "settings", labelKey: "shell.nav.settings", icon: Search },
  { href: "preview", labelKey: "shell.nav.preview", icon: ClipboardList },
  { href: "diagnostics", labelKey: "shell.nav.diagnostics", icon: Activity },
  { href: "media", labelKey: "shell.nav.media", icon: Video },
  { href: "logs", labelKey: "shell.nav.logs", icon: FileClock },
] satisfies Array<{ href: string; labelKey: TranslationKey; icon: typeof Gauge }>;

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
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-muted-foreground md:inline">{guildName}</span>
            <Badge tone={canEdit ? "success" : "muted"}>{canEdit ? t("shell.badge.canEdit") : t("shell.badge.viewOnly")}</Badge>
            <LanguageSwitcher locale={locale} />
            <SignOutButton locale={locale} />
          </div>
        </div>
      </header>
      <div className="dashboard-grid mx-auto max-w-7xl gap-5 px-4 py-5">
        <aside className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const href = item.href ? `/dashboard/${guildId}/${item.href}` : `/dashboard/${guildId}`;
            return (
              <Link
                key={item.href || "overview"}
                href={href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon size={16} />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
