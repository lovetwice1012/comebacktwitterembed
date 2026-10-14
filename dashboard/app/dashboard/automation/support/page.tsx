import { requireDashboardSession } from "@/lib/server-session";
import { SquareDonationManager } from "@/components/automation/square-donation-manager";
import { AutomationPageFrame } from "@/components/automation/automation-page-frame";
import { NotificationUsageOverview } from "@/components/automation/notification-usage-overview";
import { getDashboardLocale } from "@/lib/server-locale";
import { usesNewDashboardUI } from "@/lib/ui-rollout";

export default async function AutomationSupportPage() {
  const session = await requireDashboardSession();
  const locale = await getDashboardLocale();
  return <AutomationPageFrame locale={locale} isAdmin={session.user.isAdmin} newUI={await usesNewDashboardUI(session)} section="support" title="運営を支援する">
    <nav className="notification-billing-navigation" aria-label="プランと支援"><a href="/dashboard/automation/plans">月額プラン・お支払い</a><a href="/dashboard/automation/support" aria-current="page">運営への支援・履歴</a></nav>
    <NotificationUsageOverview key={`usage:${session.user.id}`} />
    <SquareDonationManager key={session.user.id} />
  </AutomationPageFrame>;
}
