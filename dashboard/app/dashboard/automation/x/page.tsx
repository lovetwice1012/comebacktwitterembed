import { requireDashboardSession } from "@/lib/server-session";
import { XNotificationSetupScreen } from "@/components/automation/x-notification-setup-screen";
import { AutomationPageFrame } from "@/components/automation/automation-page-frame";
import { getDashboardLocale } from "@/lib/server-locale";
import { usesNewDashboardUI } from "@/lib/ui-rollout";

export default async function XNotificationSetupPage() {
  const session = await requireDashboardSession();
  const locale = await getDashboardLocale();
  return <AutomationPageFrame locale={locale} isAdmin={session.user.isAdmin} newUI={await usesNewDashboardUI(session)} section="x" title="Xの接続">
    <XNotificationSetupScreen key={session.user.id} />
  </AutomationPageFrame>;
}
