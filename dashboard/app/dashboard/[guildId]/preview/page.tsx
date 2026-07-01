import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
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
                <CardDescription>{preview.density} / {preview.mediaMode}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-md border-l-4 border-primary bg-muted p-3 text-sm">
                  {preview.lines.map((line) => <div key={line}>{line}</div>)}
                  <div className="mt-2 text-muted-foreground">{preview.media}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {preview.buttons.map((button) => <Badge key={button} tone="muted">{button}</Badge>)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardShell>
  );
}
