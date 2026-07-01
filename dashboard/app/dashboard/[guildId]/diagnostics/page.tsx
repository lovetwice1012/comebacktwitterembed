import Link from "next/link";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getGuildAccess } from "@/lib/discord";
import { diagnoseProvider } from "@/lib/diagnostics";
import { getBotProviders, providerLabel } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function DiagnosticsPage({ params }: Params) {
  const { guildId } = await params;
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <div className="p-6">権限が不足しているか、Botが導入されていません。</div>;
  const groups = await Promise.all(getBotProviders().map(async (provider) => ({
    provider,
    issues: diagnoseProvider(provider.id, await getProviderSettingsState(provider.id, guildId)),
  })));

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">設定診断</h1>
          <p className="text-sm text-muted-foreground">情報、注意、警告、危険に分類して表示します。</p>
        </header>
        {groups.map(({ provider, issues }) => (
          <Card key={provider.id}>
            <CardHeader>
              <CardTitle>{providerLabel(provider)}</CardTitle>
              <CardDescription>{issues.length ? `${issues.length}件の診断項目` : "問題は見つかりませんでした。"}</CardDescription>
            </CardHeader>
            {issues.length ? (
              <CardContent className="space-y-2">
                {issues.map((issue) => (
                  <Link key={`${provider.id}:${issue.title}:${issue.settingKey}`} href={`/dashboard/${guildId}/providers/${provider.id}`} className="block rounded-md border p-3 hover:border-primary">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium">{issue.title}</div>
                      <Badge tone={issue.level === "danger" ? "danger" : issue.level === "warning" ? "warning" : "muted"}>{issue.level}</Badge>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">{issue.detail}</div>
                  </Link>
                ))}
              </CardContent>
            ) : null}
          </Card>
        ))}
      </div>
    </DashboardShell>
  );
}
