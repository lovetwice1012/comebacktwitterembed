import { Copy, ExternalLink } from "lucide-react";
import { CleanupExpiredButton, DeleteProviderCacheButton, DeleteTokenCacheButton } from "@/components/media/media-actions";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatDateTime } from "@/lib/format";
import { getGuildAccess } from "@/lib/discord";
import { getMediaCacheStatus } from "@/lib/media-cache";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function MediaPage({ params }: Params) {
  const { guildId } = await params;
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <div className="p-6">権限が不足しているか、Botが導入されていません。</div>;
  const status = await getMediaCacheStatus();

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit}>
      <div className="space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Media delivery</h1>
            <p className="text-sm text-muted-foreground">YouTube/Niconico download cache と配信URLを確認します。</p>
          </div>
          <CleanupExpiredButton guildId={guildId} />
        </header>

        <div className="grid gap-3 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>{status.running ? "Running" : "Stopped"}</CardTitle>
              <CardDescription>配信サーバー状態</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{status.totalCacheCount}</CardTitle>
              <CardDescription>cache items</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{formatBytes(status.totalSizeBytes)}</CardTitle>
              <CardDescription>total size</CardDescription>
            </CardHeader>
          </Card>
        </div>

        {status.providers.map((provider) => (
          <Card key={provider.providerId}>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>{provider.providerId}</CardTitle>
                  <CardDescription>{provider.rootDir}</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={provider.downloadButtonEnabled ? "success" : "muted"}>download button {provider.downloadButtonEnabled ? "on" : "off"}</Badge>
                  <Badge tone={provider.expiredCount ? "warning" : "muted"}>{provider.expiredCount} expired</Badge>
                  <DeleteProviderCacheButton guildId={guildId} providerId={provider.providerId} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 text-sm md:grid-cols-2">
                <div className="rounded-md bg-muted p-2">legacy route: {provider.routePrefix}/:token/:filename</div>
                <div className="rounded-md bg-muted p-2">unified route: {provider.unifiedRoutePrefix}/:token/:filename</div>
                <div className="rounded-md bg-muted p-2">public base: {provider.publicBaseUrl}</div>
                <div className="rounded-md bg-muted p-2">TTL: {Math.round(provider.ttlMs / 1000)}s</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2">token</th>
                      <th>filename</th>
                      <th>size</th>
                      <th>expires</th>
                      <th>url</th>
                    </tr>
                  </thead>
                  <tbody>
                    {provider.items.map((item) => (
                      <tr key={item.token} className="border-b">
                        <td className="py-2 font-mono text-xs">{item.token}</td>
                        <td>{item.filename}</td>
                        <td>{formatBytes(item.sizeBytes)}</td>
                        <td>{formatDateTime(item.expiresAtMs)}</td>
                        <td className="flex gap-2 py-2">
                          <Button asChild size="icon" variant="ghost" title="Open public URL">
                            <a href={item.publicUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>
                          </Button>
                          <Button asChild size="icon" variant="ghost" title="Copy public URL">
                            <a href={`data:text/plain,${encodeURIComponent(item.publicUrl)}`} download={`${item.token}.txt`}><Copy size={15} /></a>
                          </Button>
                          <DeleteTokenCacheButton guildId={guildId} providerId={provider.providerId} token={item.token} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </DashboardShell>
  );
}
