import { AccessDenied } from "@/legacy/components/dashboard/access-denied";
import { AccessManagement } from "@/legacy/components/dashboard/access-management";
import { DashboardShell } from "@/legacy/components/dashboard/dashboard-shell";
import { getGuildAccess } from "@/lib/discord";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function AccessManagementPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access || !access.canManageGuild) return <AccessDenied locale={locale} />;

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <AccessManagement guildId={guildId} />
    </DashboardShell>
  );
}
