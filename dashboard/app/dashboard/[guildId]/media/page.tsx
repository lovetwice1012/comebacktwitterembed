import { AccessDenied } from "@/components/dashboard/access-denied";
import { CleanupExpiredButton } from "@/components/media/media-actions";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { getGuildAccess } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getMediaDashboardStatus } from "@/lib/media-cache";
import { getDashboardLocale } from "@/lib/server-locale";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function MediaPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const status = await getMediaDashboardStatus();

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <div className="space-y-4">
        <header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{t("media.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("media.description")}</p>
          </div>
          <CleanupExpiredButton guildId={guildId} locale={locale} />
        </header>

        <div className="grid gap-3 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>{status.running ? t("media.running") : t("media.stopped")}</CardTitle>
              <CardDescription>{t("media.serverStatus")}</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{status.totalCacheCount}</CardTitle>
              <CardDescription>{t("media.cacheItems")}</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{formatBytes(status.totalSizeBytes)}</CardTitle>
              <CardDescription>{t("media.totalSize")}</CardDescription>
            </CardHeader>
          </Card>
        </div>

        {status.providers.map((provider) => (
          <Card key={provider.providerId}>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <CardTitle>{provider.label}</CardTitle>
                  <CardDescription>{provider.domain}</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={provider.expiredCount ? "warning" : "muted"}>{t("media.expired", { count: provider.expiredCount })}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 text-sm sm:grid-cols-3">
                <div className="rounded-md bg-muted p-3">
                  <div className="text-muted-foreground">{t("media.cacheItems")}</div>
                  <div className="mt-1 text-lg font-semibold">{provider.cacheCount}</div>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <div className="text-muted-foreground">{t("media.totalSize")}</div>
                  <div className="mt-1 text-lg font-semibold">{formatBytes(provider.totalSizeBytes)}</div>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <div className="text-muted-foreground">{t("media.expiredLabel")}</div>
                  <div className="mt-1 text-lg font-semibold">{provider.expiredCount}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </DashboardShell>
  );
}
