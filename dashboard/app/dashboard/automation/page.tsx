import { requireDashboardSession } from "@/lib/server-session";
import { AutomationWorkspace } from "@/components/automation/automation-workspace";
import { AutomationPageFrame } from "@/components/automation/automation-page-frame";
import { getDashboardLocale } from "@/lib/server-locale";
import { usesNewDashboardUI } from "@/lib/ui-rollout";

export default async function PersonalAutomationPage() {
  const session = await requireDashboardSession();
  const locale = await getDashboardLocale();
  return <AutomationPageFrame locale={locale} isAdmin={session.user.isAdmin} newUI={await usesNewDashboardUI(session)} section="notifications" title="自動通知"><AutomationWorkspace key={session.user.id} viewerId={session.user.id} presentation="embedded" /></AutomationPageFrame>;
}
