import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/guild-access";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { AccessManagement } from "@/components/dashboard/access-management";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { getGuildAccess } from "@/lib/discord";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function AccessManagementPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const session = await requireDashboardSession();
  if (!await usesNewDashboardUI(session)) return <LegacyPage params={params} />;
  const access = await getGuildAccess(session, guildId);
  if (!access || !access.canManageGuild) return <AccessDenied locale={locale} guildId={access ? guildId : undefined} required={locale === "ja" ? "サーバーの管理 または 管理者" : "Manage Server or Administrator"} />;

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale} isAdmin={session.user.isAdmin}>
      <AccessManagement guildId={guildId} locale={locale} />
    </DashboardShell>
  );
}
