import { requireDashboardSession } from "@/lib/server-session";
import { SquareDonationManager } from "@/components/automation/square-donation-manager";
import { AutomationPageFrame } from "@/components/automation/automation-page-frame";
import { getDashboardLocale } from "@/lib/server-locale";
import { usesNewDashboardUI } from "@/lib/ui-rollout";

export default async function AutomationSupportPage() {
  const session = await requireDashboardSession();
  const locale = await getDashboardLocale();
  return <AutomationPageFrame locale={locale} isAdmin={session.user.isAdmin} newUI={await usesNewDashboardUI(session)} section="support" title="運営を支援する">
    <SquareDonationManager key={session.user.id} />
  </AutomationPageFrame>;
}
