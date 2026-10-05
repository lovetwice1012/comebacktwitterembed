import Link from "next/link";
import { requireDashboardSession } from "@/lib/server-session";
import { getDashboardLocale } from "@/lib/server-locale";
import { PersonalLinksWorkspace } from "@/components/personal-links/personal-links-workspace";
export default async function PersonalLinksPage() {
  const session = await requireDashboardSession();
  const locale = await getDashboardLocale();
  return <main className="mx-auto min-h-screen max-w-7xl space-y-6 px-4 py-6 sm:px-6">
    <Link href={session.user.isAdmin ? "/admin" : "/dashboard"} className="text-sm text-muted-foreground hover:underline">← {locale === "ja" ? "ダッシュボードへ" : "Dashboard"}</Link>
    <PersonalLinksWorkspace key={session.user.id} displayName={session.user.globalName || session.user.username} locale={locale} />
  </main>;
}
