import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/personal-links";
import { requireDashboardSession } from "@/lib/server-session";
import { getDashboardLocale } from "@/lib/server-locale";
import { PersonalLinksWorkspace } from "@/components/personal-links/personal-links-workspace";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default async function PersonalLinksPage() {
  const session = await requireDashboardSession();
  if (!await usesNewDashboardUI(session)) return <LegacyPage  />;
  const locale = await getDashboardLocale();
  return <DashboardShell locale={locale} isAdmin={session.user.isAdmin}>
    <PersonalLinksWorkspace key={session.user.id} viewerId={session.user.id} displayName={session.user.globalName || session.user.username} locale={locale} />
  </DashboardShell>;
}
