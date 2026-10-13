import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/guild-provider-settings";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
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
  if (!await usesNewDashboardUI(session)) return <LegacyPage params={params} />;
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const provider = getProviderCatalog(providerId);
  if (!provider) return <div className="p-6">{t("providers.unknown", { providerId })}</div>;
  const settings = await getProviderSettingsState(providerId, guildId, locale);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale} isAdmin={session.user.isAdmin}>
      <div className="space-y-4">
        <header>
          <Link className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground" href={`/dashboard/${guildId}/providers`}><ChevronLeft size={16} aria-hidden="true" />{locale === "ja" ? "サービスを選び直す" : "Choose another service"}</Link>
          <h1 className="text-2xl font-semibold">{provider.label}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{providerDomain(provider.providerId)}</p>
        </header>
        <ProviderSettingsForm guildId={guildId} providerId={providerId} providerLabel={provider.label} scopeLabel={access.name} canEdit={access.canEdit} canReset={access.canManageGuild} settings={settings} locale={locale} viewerId={session.user.id} />
      </div>
    </DashboardShell>
  );
}
