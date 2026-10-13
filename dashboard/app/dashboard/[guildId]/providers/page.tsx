import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/guild-providers";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ProviderList } from "@/components/providers/provider-list";
import { getGuildAccess } from "@/lib/discord";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { getProvidersOverview } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function ProvidersPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  if (!await usesNewDashboardUI(session)) return <LegacyPage params={params} />;
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const providers = await getProvidersOverview(guildId, locale);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale} isAdmin={session.user.isAdmin}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{t("providers.title")}</h1>
        </header>
        <ProviderList guildId={guildId} providers={providers} locale={locale} />
      </div>
    </DashboardShell>
  );
}
