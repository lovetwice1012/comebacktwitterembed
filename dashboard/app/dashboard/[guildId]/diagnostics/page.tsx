import Link from "next/link";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getGuildAccess } from "@/lib/discord";
import { diagnoseProvider } from "@/lib/diagnostics";
import { createTranslator, levelLabel } from "@/lib/i18n";
import { getDashboardLocale } from "@/lib/server-locale";
import { getBotProviders, providerLabel } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";

type Params = { params: Promise<{ guildId: string }> };

export default async function DiagnosticsPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const t = createTranslator(locale);
  const session = await requireDashboardSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const groups = await Promise.all(getBotProviders().map(async (provider) => ({
    provider,
    issues: diagnoseProvider(provider.id, await getProviderSettingsState(provider.id, guildId, locale), locale),
  })));

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale}>
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{t("diagnostics.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("diagnostics.description")}</p>
        </header>
        {groups.map(({ provider, issues }) => (
          <Card key={provider.id}>
            <CardHeader>
              <CardTitle>{providerLabel(provider)}</CardTitle>
              <CardDescription>{issues.length ? t("diagnostics.issueCount", { count: issues.length }) : t("diagnostics.noIssues")}</CardDescription>
            </CardHeader>
            {issues.length ? (
              <CardContent className="space-y-2">
                {issues.map((issue) => (
                  <Link key={`${provider.id}:${issue.title}:${issue.settingKey}`} href={`/dashboard/${guildId}/providers/${provider.id}`} className="block rounded-md border p-3 hover:border-primary">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 break-words font-medium">{issue.title}</div>
                      <Badge tone={issue.level === "danger" ? "danger" : issue.level === "warning" ? "warning" : "muted"}>{levelLabel(issue.level, locale)}</Badge>
                    </div>
                    <div className="mt-1 break-words text-sm text-muted-foreground">{issue.detail}</div>
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
