import { requireDashboardSession } from "@/lib/server-session";
import { SquareDonationManager } from "@/components/automation/square-donation-manager";

export default async function AutomationSupportPage() {
  const session = await requireDashboardSession();
  return <main className="mx-auto max-w-4xl space-y-5 p-6">
    <a href="/dashboard/automation" className="text-sm text-primary underline">自動通知へ戻る</a>
    <div><h1 className="text-2xl font-semibold">支援・寄付</h1><p className="mt-2 text-sm text-muted-foreground">サービスへの1回ごとの寄付と、支払い履歴・支援者枠の適用状態を確認します。</p></div>
    <a href="/dashboard/automation/plans" className="inline-block text-sm text-primary underline">有償プラン・サブスクリプション</a>
    <SquareDonationManager key={session.user.id} />
  </main>;
}
