import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { listAuditLogs } from "@/lib/audit-log";
import { getGuildAccess } from "@/lib/discord";
import { getCatalog } from "@/lib/settings-catalog";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";
import { AuditHistory } from "./audit-history";
import { presentAuditEntry } from "./audit-history-model";
import { usesNewDashboardUI } from "@/lib/ui-rollout";
import { AuditLogsPage as LegacyAuditLogsPage } from "@/legacy/features/audit/audit-logs-page";

export async function AuditLogsPage({ guildId }: { guildId: string }) {
  const locale = await getDashboardLocale();
  const session = await requireDashboardSession();
  if (!await usesNewDashboardUI(session)) return <LegacyAuditLogsPage guildId={guildId} />;
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  if (!access.canManageGuild) return <AccessDenied locale={locale} guildId={guildId} required={locale === "ja" ? "サーバーの管理 または 管理者" : "Manage Server or Administrator"} />;
  const logs = await listAuditLogs(guildId, {});
  const catalog = getCatalog();

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale} isAdmin={session.user.isAdmin}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{locale === "ja" ? "変更履歴" : "Change history"}</h1>
        </header>
        <AuditHistory guildId={guildId} locale={locale} entries={logs.map(log => presentAuditEntry(log, catalog, locale))} />
      </div>
    </DashboardShell>
  );
}
