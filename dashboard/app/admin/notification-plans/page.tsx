import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDashboardSession } from "@/lib/server-session";
import { NotificationPlanManager } from "@/components/admin/notification-plan-manager";
import { DonationPolicyManager } from "@/components/admin/donation-policy-manager";

export default async function NotificationPlansPage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();
  return <main className="mx-auto max-w-6xl space-y-5 p-6">
    <nav aria-label="通知プラン管理の関連画面" className="flex flex-wrap gap-4 text-sm text-primary"><Link href="/admin" className="underline">管理画面へ戻る</Link><Link href="/admin/donors" className="underline">支援者管理</Link></nav>
    <div><h1 className="text-2xl font-semibold">通知プラン・送信上限</h1><p className="mt-2 text-sm text-muted-foreground">無料枠・支援者枠・有償プランの登録枠、送信上限、優先度とSquare連携を管理します。</p></div>
    <NotificationPlanManager />
    <DonationPolicyManager />
  </main>;
}
