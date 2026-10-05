import { AccessDenied } from "@/components/dashboard/access-denied";
import Link from "next/link";
import { AutomationWorkspace } from "@/components/automation/automation-workspace";
import { getGuildAccess } from "@/lib/discord";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

export default async function AutomationPage({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const session = await requireDashboardSession(), locale = await getDashboardLocale();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  return <main className="mx-auto max-w-[1600px] space-y-4 px-3 py-4 sm:px-5"><header className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 text-sm"><div className="flex items-center gap-3"><Link href="/dashboard" className="underline">サーバー一覧</Link><span className="font-medium">{access.name}</span>{!access.canEdit && <span className="text-muted-foreground">共有設定は閲覧のみ</span>}</div><Link href="/dashboard/automation" className="underline">自分の通知</Link></header><AutomationWorkspace key={`${session.user.id}:${guildId}`} viewerId={session.user.id} guildId={guildId} canEdit={access.canEdit} /></main>;
}
