import Link from "next/link";
import { AlertTriangle, Layers3, Settings, Wand2 } from "lucide-react";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getGuildAccess } from "@/lib/discord";
import { diagnoseProvider } from "@/lib/diagnostics";
import { createTranslator } from "@/lib/i18n";
import { getMediaCacheStatus } from "@/lib/media-cache";
import { getDashboardLocale } from "@/lib/server-locale";
import { getBotProviders, providerLabel } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function GuildOverviewPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;

  const providers = await Promise.all(getBotProviders().map(async (provider) => {
    const states = await getProviderSettingsState(provider.id, guildId, locale);
    return { provider, states };
  }));
  const providerOverview = providers.map(({ provider, states }) => {
    const enabled = states.find((state) => state.key === "enabled")?.value === true;
    const customizedSettingCount = states.filter((state) => state.changedFromDefault).length;
    const warnings = states.flatMap((state) => state.warnings.map((warning) => `${state.key}: ${warning}`));
    return {
      providerId: provider.id,
      label: providerLabel(provider),
      enabled,
      changedFromDefault: customizedSettingCount > 0,
      displayDensity: states.find((state) => state.key === "display_density")?.value,
      mediaDisplayMode: states.find((state) => state.key === "media_display_mode")?.value,
      warnings,
    };
  });
  const enabled = providerOverview.filter((provider) => provider.enabled);
  const changed = providerOverview.filter((provider) => provider.changedFromDefault);
  const diagnosticCount = providers.flatMap(({ provider, states }) => diagnoseProvider(provider.id, states, locale)).length;
  const media = await getMediaCacheStatus().catch(() => null);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <div className="space-y-5">
        <header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{access.name}</h1>
            <p className="break-words text-sm text-muted-foreground">guild_id: {guildId}</p>
          </div>
          <Button asChild className="w-full sm:w-auto">
            <Link href={`/dashboard/${guildId}/providers`}>
              <Layers3 size={16} />
              {t("overview.configureProviders")}
            </Link>
          </Button>
        </header>

        <div className="grid gap-3 md:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle>{enabled.length}</CardTitle>
              <CardDescription>{t("overview.enabledProviders")}</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{providerOverview.length - enabled.length}</CardTitle>
              <CardDescription>{t("overview.disabledProviders")}</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{changed.length}</CardTitle>
              <CardDescription>{t("overview.changedFromDefault")}</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{diagnosticCount}</CardTitle>
              <CardDescription>{t("overview.diagnostics")}</CardDescription>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wand2 size={18} />
                {t("overview.firstSettingsTitle")}
              </CardTitle>
              <CardDescription>{t("overview.firstSettingsDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button asChild className="w-full sm:w-auto" variant="outline">
                <Link href={`/dashboard/${guildId}/settings`}>{t("overview.crossSearch")}</Link>
              </Button>
              <Button asChild className="w-full sm:w-auto" variant="outline">
                <Link href={`/dashboard/${guildId}/preview`}>{t("overview.outputPreview")}</Link>
              </Button>
              <Button asChild className="w-full sm:w-auto" variant="outline">
                <Link href={`/dashboard/${guildId}/diagnostics`}>{t("overview.settingsDiagnostics")}</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings size={18} />
                {t("overview.outputModeTitle")}
              </CardTitle>
              <CardDescription>{t("overview.outputModeDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {providerOverview.slice(0, 6).map((provider) => (
                <div key={provider.providerId} className="flex flex-col gap-1 rounded-md bg-muted p-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <span className="min-w-0 break-words">{provider.label}</span>
                  <span className="min-w-0 break-words text-muted-foreground">
                    {String(provider.displayDensity)} / {String(provider.mediaDisplayMode)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle size={18} />
              {t("overview.warningStateTitle")}
            </CardTitle>
            <CardDescription>{t("overview.warningStateDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge tone={diagnosticCount ? "warning" : "success"}>{diagnosticCount ? `${diagnosticCount} diagnostics` : t("overview.diagnosticsOk")}</Badge>
            <Badge tone={media?.expiredCount ? "warning" : "muted"}>{t("overview.expiredMedia", { count: media?.expiredCount ?? "-" })}</Badge>
            <Badge tone="muted">{t("overview.cacheItems", { count: media?.totalCacheCount ?? "-" })}</Badge>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
