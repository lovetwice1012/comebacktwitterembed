import { requireDashboardSession } from "@/lib/server-session";
import { SubscriptionManager } from "@/components/automation/subscription-manager";
import { AutomationPageFrame } from "@/components/automation/automation-page-frame";
import { NotificationUsageOverview } from "@/components/automation/notification-usage-overview";
import { getDashboardLocale } from "@/lib/server-locale";
import { usesNewDashboardUI } from "@/lib/ui-rollout";

export default async function NotificationSubscriptionsPage() {
  const session = await requireDashboardSession();
  const locale = await getDashboardLocale();
  return <AutomationPageFrame locale={locale} isAdmin={session.user.isAdmin} newUI={await usesNewDashboardUI(session)} section="plans" title="利用状況とプラン">
    <nav className="notification-billing-navigation" aria-label="プランと支援"><a href="/dashboard/automation/plans" aria-current="page">月額プラン・お支払い</a><a href="/dashboard/automation/support">運営への支援・履歴</a></nav>
    <NotificationUsageOverview key={`usage:${session.user.id}`} />
    <SubscriptionManager key={session.user.id} />
  </AutomationPageFrame>;
}
