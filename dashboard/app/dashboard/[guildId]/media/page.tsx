import { Copy, ExternalLink } from "lucide-react";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { CleanupExpiredButton, DeleteProviderCacheButton, DeleteTokenCacheButton } from "@/components/media/media-actions";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatDateTime } from "@/lib/format";
import { getGuildAccess } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getMediaCacheStatus } from "@/lib/media-cache";
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
  const status = await getMediaCacheStatus();

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <div className="space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
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
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{provider.providerId}</CardTitle>
                  <CardDescription>{provider.rootDir}</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={provider.downloadButtonEnabled ? "success" : "muted"}>{t("media.downloadButton", { state: provider.downloadButtonEnabled ? t("media.on") : t("media.off") })}</Badge>
                  <Badge tone={provider.expiredCount ? "warning" : "muted"}>{t("media.expired", { count: provider.expiredCount })}</Badge>
                  <DeleteProviderCacheButton guildId={guildId} providerId={provider.providerId} locale={locale} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 text-sm md:grid-cols-2">
                <div className="rounded-md bg-muted p-2">{t("media.legacyRoute", { value: `${provider.routePrefix}/:token/:filename` })}</div>
                <div className="rounded-md bg-muted p-2">{t("media.unifiedRoute", { value: `${provider.unifiedRoutePrefix}/:token/:filename` })}</div>
                <div className="rounded-md bg-muted p-2">{t("media.publicBase", { value: provider.publicBaseUrl })}</div>
                <div className="rounded-md bg-muted p-2">{t("media.ttl", { value: Math.round(provider.ttlMs / 1000) })}</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2">{t("media.table.token")}</th>
                      <th>{t("media.table.filename")}</th>
                      <th>{t("media.table.size")}</th>
                      <th>{t("media.table.expires")}</th>
                      <th>{t("media.table.url")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {provider.items.map((item) => (
                      <tr key={item.token} className="border-b">
                        <td className="py-2 font-mono text-xs">{item.token}</td>
                        <td>{item.filename}</td>
                        <td>{formatBytes(item.sizeBytes)}</td>
                        <td>{formatDateTime(item.expiresAtMs, locale)}</td>
                        <td className="flex gap-2 py-2">
                          <Button asChild size="icon" variant="ghost" title={t("media.openPublicUrl")}>
                            <a href={item.publicUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>
                          </Button>
                          <Button asChild size="icon" variant="ghost" title={t("media.copyPublicUrl")}>
                            <a href={`data:text/plain,${encodeURIComponent(item.publicUrl)}`} download={`${item.token}.txt`}><Copy size={15} /></a>
                          </Button>
                          <DeleteTokenCacheButton guildId={guildId} providerId={provider.providerId} token={item.token} locale={locale} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </DashboardShell>
  );
}
