import Link from "next/link";
import { AlertTriangle, Layers3, Settings, Wand2 } from "lucide-react";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getGuildAccess } from "@/lib/discord";
import { diagnoseProvider } from "@/lib/diagnostics";
import { getMediaCacheStatus } from "@/lib/media-cache";
import { getProvidersOverview, getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function GuildOverviewPage({ params }: Params) {
  const { guildId } = await params;
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <div className="p-6">権限が不足しているか、Botが導入されていません。</div>;

  const providers = await getProvidersOverview(guildId);
  const enabled = providers.filter((provider) => provider.enabled);
  const changed = providers.filter((provider) => provider.changedFromDefault);
  const diagnosticCount = (
    await Promise.all(providers.map(async (provider) => diagnoseProvider(provider.providerId, await getProviderSettingsState(provider.providerId, guildId))))
  ).flat().length;
  const media = await getMediaCacheStatus().catch(() => null);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit}>
      <div className="space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{access.name}</h1>
            <p className="text-sm text-muted-foreground">guild_id: {guildId}</p>
          </div>
          <Button asChild>
            <Link href={`/dashboard/${guildId}/providers`}>
              <Layers3 size={16} />
              Providersを設定
            </Link>
          </Button>
        </header>

        <div className="grid gap-3 md:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle>{enabled.length}</CardTitle>
              <CardDescription>有効provider</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{providers.length - enabled.length}</CardTitle>
              <CardDescription>無効provider</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{changed.length}</CardTitle>
              <CardDescription>デフォルト変更あり</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{diagnosticCount}</CardTitle>
              <CardDescription>診断項目</CardDescription>
            </CardHeader>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wand2 size={18} />
                まずここを設定
              </CardTitle>
              <CardDescription>よく使う設定から安全に始められます。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href={`/dashboard/${guildId}/settings`}>横断検索</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/dashboard/${guildId}/preview`}>出力プレビュー</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href={`/dashboard/${guildId}/diagnostics`}>設定診断</Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings size={18} />
                出力モード概要
              </CardTitle>
              <CardDescription>provider横断の現在値です。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {providers.slice(0, 6).map((provider) => (
                <div key={provider.providerId} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-2">
                  <span>{provider.label}</span>
                  <span className="text-muted-foreground">
                    {String(provider.displayDensity)} / {String(provider.mediaDisplayMode)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle size={18} />
              注意状態
            </CardTitle>
            <CardDescription>危険設定、依存関係、メディア配信状態をまとめます。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge tone={diagnosticCount ? "warning" : "success"}>{diagnosticCount ? `${diagnosticCount} diagnostics` : "診断OK"}</Badge>
            <Badge tone={media?.expiredCount ? "warning" : "muted"}>expired media: {media?.expiredCount ?? "-"}</Badge>
            <Badge tone="muted">cache items: {media?.totalCacheCount ?? "-"}</Badge>
          </CardContent>
        </Card>
      </div>
    </DashboardShell>
  );
}
