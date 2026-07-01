import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { OutputPreviewCard } from "@/components/preview/output-preview-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getGuildAccess } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { buildPreview } from "@/lib/settings-preview";
import { getBotProviders, providerLabel } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function PreviewPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const previews = await Promise.all(getBotProviders().map(async (provider) => ({
    provider,
    preview: buildPreview(provider.id, await getProviderSettingsState(provider.id, guildId, locale), locale),
  })));

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{t("preview.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("preview.description")}</p>
        </header>
        <div className="grid gap-4 xl:grid-cols-2">
          {previews.map(({ provider, preview }) => (
            <Card key={provider.id}>
              <CardHeader>
                <CardTitle>{providerLabel(provider)}</CardTitle>
                <CardDescription>{preview.sourceUrl}</CardDescription>
              </CardHeader>
              <CardContent>
                <OutputPreviewCard preview={preview} locale={locale} />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardShell>
  );
}
