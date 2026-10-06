import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDashboardSession } from "@/lib/server-session";
import { AutoWatchIntervalForm } from "@/components/admin/auto-watch-interval-form";

export default async function AutoWatchIntervalsPage() {
  const session = await requireDashboardSession();
  if (!session.user.isAdmin) notFound();
  return <main className="mx-auto max-w-3xl space-y-5 p-6">
    <Link href="/admin" className="text-sm text-primary underline">管理画面へ戻る</Link>
    <h1 className="text-xl font-semibold">利用者ごとの新着自動展開間隔</h1>
    <AutoWatchIntervalForm />
  </main>;
}
