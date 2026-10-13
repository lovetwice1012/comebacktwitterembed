import { requireDashboardSession } from "@/lib/server-session";
import { SubscriptionManager } from "@/components/automation/subscription-manager";

export default async function NotificationSubscriptionsPage() {
  const session = await requireDashboardSession();
  return <main className="mx-auto max-w-4xl space-y-5 p-6">
    <a href="/dashboard/automation" className="text-sm text-primary underline">自動通知へ戻る</a>
    <div><h1 className="text-2xl font-semibold">プラン・お支払い</h1><p className="mt-2 text-sm text-muted-foreground">通知プランの契約と継続課金の状態を確認します。</p></div>
    <a href="/dashboard/automation/support" className="inline-block text-sm text-primary underline">支援・寄付（今回1回のみ）</a>
    <SubscriptionManager key={session.user.id} />
  </main>;
}
