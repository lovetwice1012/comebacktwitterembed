import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ProviderSettingsForm } from "@/components/settings/provider-settings-form";
import { getGuildAccess } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { getProviderCatalog, providerDomain } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string; providerId: string }> };

export default async function ProviderDetailPage({ params }: Params) {
  const { guildId, providerId } = await params;
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const provider = getProviderCatalog(providerId);
  if (!provider) return <div className="p-6">{t("providers.unknown", { providerId })}</div>;
  const settings = await getProviderSettingsState(providerId, guildId, locale);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{provider.label}</h1>
          <p className="text-sm text-muted-foreground">
            {providerDomain(provider.providerId)} / {t("providers.detail.default", { value: provider.enabledByDefault ? t("providers.detail.defaultEnabled") : t("providers.detail.defaultDisabled") })}
          </p>
        </header>
        <ProviderSettingsForm guildId={guildId} providerId={providerId} providerLabel={provider.label} canEdit={access.canEdit} settings={settings} locale={locale} />
      </div>
    </DashboardShell>
  );
}
