import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listAuditLogs } from "@/lib/audit-log";
import { getGuildAccess } from "@/lib/discord";
import { formatDateTime } from "@/lib/format";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

export async function AuditLogsPage({ guildId }: { guildId: string }) {
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  if (!access.canManageGuild) return <div className="p-6">{t("accessDenied.logs")}</div>;
  const logs = await listAuditLogs(guildId, {});

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{t("logs.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("logs.description")}</p>
        </header>
        <div className="space-y-3">
          {logs.map((log) => (
            <Card key={log.auditLogId}>
              <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle>{String(log.action)}</CardTitle>
                    <CardDescription>{formatDateTime(log.createdAt, locale)} · {String(log.actorUsernameSnapshot || log.actorUserId)}</CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {log.providerId ? <Badge>{String(log.providerId)}</Badge> : null}
                    {log.settingKey ? <Badge tone="muted">{String(log.settingKey)}</Badge> : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid gap-3 lg:grid-cols-2">
                <pre className="max-h-64 min-w-0 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(log.before, null, 2)}</pre>
                <pre className="max-h-64 min-w-0 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(log.after, null, 2)}</pre>
              </CardContent>
            </Card>
          ))}
          {!logs.length ? <Card><CardContent className="pt-4 text-sm text-muted-foreground">{t("logs.empty")}</CardContent></Card> : null}
        </div>
      </div>
    </DashboardShell>
  );
}
