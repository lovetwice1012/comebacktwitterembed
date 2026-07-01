import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { CrossSettingsView } from "@/components/settings/cross-settings-view";
import { getGuildAccess } from "@/lib/discord";
import { getBotProviders, providerLabel } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function CrossSettingsPage({ params }: Params) {
  const { guildId } = await params;
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <div className="p-6">権限が不足しているか、Botが導入されていません。</div>;
  const providers = getBotProviders();
  const items = (
    await Promise.all(providers.map(async (provider) => {
      const settings = await getProviderSettingsState(provider.id, guildId);
      return settings.map((setting) => ({ providerId: provider.id, providerLabel: providerLabel(provider), setting }));
    }))
  ).flat();

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">provider横断検索</h1>
          <p className="text-sm text-muted-foreground">設定キー、ラベル、説明文、DBカラム名で検索できます。</p>
        </header>
        <CrossSettingsView guildId={guildId} items={items} canManage={access.canManageGuild} />
      </div>
    </DashboardShell>
  );
}
