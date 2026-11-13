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
    <NotificationUsageOverview key={`usage:${session.user.id}`} />
    <SubscriptionManager key={session.user.id} />
  </AutomationPageFrame>;
}
