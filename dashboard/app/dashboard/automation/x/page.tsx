import Link from "next/link";
import { requireDashboardSession } from "@/lib/server-session";
import { XNotificationSetupScreen } from "@/components/automation/x-notification-setup-screen";

export default async function XNotificationSetupPage() {
  const session = await requireDashboardSession();
  return <main className="mx-auto max-w-3xl space-y-4 px-3 py-4 sm:p-5">
    <Link href="/dashboard/automation" className="text-sm text-muted-foreground hover:underline">自動通知・監視対象の設定に戻る</Link>
    <header className="space-y-2"><h1 className="text-xl font-semibold">X通知のセットアップ</h1><p className="text-sm text-muted-foreground">X通知をサーバーで受け取るための準備を、順番に進められます。専用Firefoxで通知を設定し、保存したファイルをこの画面にアップロードしてください。設定はご自身のアカウントに保存されます。</p></header>
    <XNotificationSetupScreen key={session.user.id} />
  </main>;
}
