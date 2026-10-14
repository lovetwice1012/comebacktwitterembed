import { ArrowLeft, Bell, Cable, CreditCard } from "lucide-react";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { TaskNavigation } from "@/components/dashboard/task-navigation";
import type { DashboardLocale } from "@/lib/i18n";
import "./notification-workspace.css";

export function AutomationPageFrame({ locale, isAdmin = false, section, title, description, children, newUI = true }: {
  locale: DashboardLocale; isAdmin?: boolean; section: "notifications" | "x" | "plans" | "support";
  title: string; description?: string; children: React.ReactNode;
  newUI?: boolean;
}) {
  const ja = locale === "ja", active = section === "support" ? "plans" : section;
  const pages = [
    { id: "notifications", href: "/dashboard/automation", icon: Bell, label: ja ? "通知を管理" : "Notifications" },
    { id: "x", href: "/dashboard/automation/x", icon: Cable, label: ja ? "Xの接続" : "Connect X" },
    { id: "plans", href: "/dashboard/automation/plans", icon: CreditCard, label: ja ? "利用状況とプラン" : "Usage and plans" },
  ];
  const content = <div className="notification-workspace">
      <header className="notification-page-heading"><h1>{title}</h1>{description ? <div className="notification-page-description">{description}</div> : null}</header>
      <nav className="notification-section-navigation" aria-label={ja ? "通知の設定" : "Notification settings"}>
        {pages.map(({ icon: Icon, ...page }) => <a key={page.id} href={page.href} aria-current={active === page.id ? "page" : undefined}>
          <Icon size={19} aria-hidden /><strong>{page.label}</strong>
        </a>)}
      </nav>
      <div className="notification-page-content">{children}</div>
    </div>;
  if (!newUI) return <main className="mx-auto max-w-[1600px] space-y-4 px-3 py-4 sm:p-5"><a href="/dashboard" className="inline-flex items-center gap-1 text-sm text-muted-foreground"><ArrowLeft size={15} aria-hidden />{ja ? "ダッシュボード" : "Dashboard"}</a><TaskNavigation locale={locale} documentNavigation />{content}</main>;
  return <DashboardShell locale={locale} isAdmin={isAdmin} documentNavigation={section === "plans" || section === "support"}>{content}</DashboardShell>;
}
