import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireDashboardSession } from "@/lib/server-session";
import { AutomationWorkspace } from "@/components/automation/automation-workspace";
import { TaskNavigation } from "@/components/dashboard/task-navigation";
import { getDashboardLocale } from "@/lib/server-locale";

export default async function PersonalAutomationPage() {
  const session = await requireDashboardSession();
  const locale = await getDashboardLocale();
  return <main className="mx-auto max-w-[1600px] space-y-4 px-3 py-4 sm:p-5"><Link href="/dashboard" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:underline"><ArrowLeft size={16} aria-hidden />{locale === "ja" ? "ダッシュボード" : "Dashboard"}</Link><TaskNavigation locale={locale} /><AutomationWorkspace key={session.user.id} viewerId={session.user.id} /></main>;
}
