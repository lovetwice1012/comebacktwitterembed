import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/guild-preview";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ProviderPreviewBrowser } from "@/components/settings/provider-preview-browser";
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
  if (!await usesNewDashboardUI(session)) return <LegacyPage params={params} />;
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const previews = await Promise.all(getBotProviders().map(async provider => {
    const states = await getProviderSettingsState(provider.id, guildId, locale);
    return { providerId: provider.id, label: providerLabel(provider), enabled: states.find(state => state.key === "enabled")?.value === true, preview: buildPreview(provider.id, states, locale) };
  }));

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale} isAdmin={session.user.isAdmin}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{t("preview.title")}</h1>
        </header>
        <ProviderPreviewBrowser guildId={guildId} items={previews} locale={locale} />
      </div>
    </DashboardShell>
  );
}
