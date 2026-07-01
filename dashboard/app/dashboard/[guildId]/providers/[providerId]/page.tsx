import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ProviderSettingsForm } from "@/components/settings/provider-settings-form";
import { getGuildAccess } from "@/lib/discord";
import { getProviderCatalog } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string; providerId: string }> };

export default async function ProviderDetailPage({ params }: Params) {
  const { guildId, providerId } = await params;
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <div className="p-6">権限が不足しているか、Botが導入されていません。</div>;
  const provider = getProviderCatalog(providerId);
  if (!provider) return <div className="p-6">Unknown provider: {providerId}</div>;
  const settings = await getProviderSettingsState(providerId, guildId);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{provider.label}</h1>
          <p className="text-sm text-muted-foreground">provider_id: {provider.providerId} / default {provider.enabledByDefault ? "enabled" : "disabled"}</p>
        </header>
        <ProviderSettingsForm guildId={guildId} providerId={providerId} providerLabel={provider.label} canEdit={access.canEdit} settings={settings} />
      </div>
    </DashboardShell>
  );
}
