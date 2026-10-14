import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDashboardSession } from "@/lib/server-session";
import { DonorManager } from "@/components/admin/donor-manager";

export default async function DonorsPage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();
  return <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
    <nav aria-label="支援者管理の関連画面" className="flex flex-wrap gap-4 text-sm text-primary"><Link href="/admin" className="underline">管理画面へ戻る</Link><Link href="/admin/notification-plans" className="underline">通知プラン・送信上限</Link></nav>
    <div><h1 className="text-2xl font-semibold">支援者管理</h1><p className="mt-2 text-sm text-muted-foreground">手動の支援者優先枠・追加通知枠と、支援回数・購入口数の記録を管理します。</p></div>
    <DonorManager />
  </main>;
}
