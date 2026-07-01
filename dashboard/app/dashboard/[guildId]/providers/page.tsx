import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { ProviderList } from "@/components/providers/provider-list";
import { getGuildAccess } from "@/lib/discord";
import { getProvidersOverview } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function ProvidersPage({ params }: Params) {
  const { guildId } = await params;
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <div className="p-6">権限が不足しているか、Botが導入されていません。</div>;
  const providers = await getProvidersOverview(guildId);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">Provider一覧</h1>
          <p className="text-sm text-muted-foreground">有効状態、変更数、出力制御を横断して確認します。</p>
        </header>
        <ProviderList guildId={guildId} providers={providers} />
      </div>
    </DashboardShell>
  );
}
