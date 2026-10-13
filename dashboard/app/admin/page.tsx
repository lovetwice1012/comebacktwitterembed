import { usesNewDashboardUI } from "@/lib/ui-rollout";
import Link from "next/link";
import LegacyPage from "@/legacy/pages/admin";
import { notFound } from "next/navigation";
import { AdminConsoleLoader } from "@/components/admin/admin-console-loader";
import { requireDashboardSession } from "@/lib/server-session";

export default async function AdminPage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();
  if (!await usesNewDashboardUI(session)) return <><nav aria-label="支援と通知の管理" className="mx-auto flex max-w-6xl flex-wrap gap-4 px-6 pt-6 text-sm text-primary"><Link href="/admin/donors" className="underline">支援者管理</Link><Link href="/admin/notification-plans" className="underline">通知プラン・送信上限</Link></nav><LegacyPage /></>;

  return <AdminConsoleLoader user={session.user} />;
}
