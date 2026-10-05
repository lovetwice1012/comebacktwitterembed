import Link from "next/link";
import { requireDashboardSession } from "@/lib/server-session";
import { AutomationWorkspace } from "@/components/automation/automation-workspace";

export default async function PersonalAutomationPage() {
  const session = await requireDashboardSession();
  return <main className="mx-auto max-w-[1600px] space-y-4 p-5"><Link href="/dashboard" className="text-sm underline">サーバー一覧へ</Link><AutomationWorkspace key={session.user.id} viewerId={session.user.id} /></main>;
}
