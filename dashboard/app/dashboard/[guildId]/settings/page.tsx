import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { CrossSettingsView } from "@/components/settings/cross-settings-view";
import { getGuildAccess } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { getBotProviders, providerLabel } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function CrossSettingsPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const providers = getBotProviders();
  const items = (
    await Promise.all(providers.map(async (provider) => {
      const settings = await getProviderSettingsState(provider.id, guildId, locale);
      return settings.map((setting) => ({ providerId: provider.id, providerLabel: providerLabel(provider), setting }));
    }))
  ).flat();

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{t("settingsCross.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("settingsCross.description")}</p>
        </header>
        <CrossSettingsView guildId={guildId} items={items} canManage={access.canManageGuild} locale={locale} />
      </div>
    </DashboardShell>
  );
}
