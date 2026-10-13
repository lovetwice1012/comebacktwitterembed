import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/guild-diagnostics";
import Link from "next/link";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  if (!await usesNewDashboardUI(session)) return <LegacyPage params={params} />;
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;
  const groups = await Promise.all(getBotProviders().map(async (provider) => ({
    provider,
    issues: diagnoseProvider(provider.id, await getProviderSettingsState(provider.id, guildId, locale), locale),
  })));
  const attention = groups.map(group => ({ ...group, issues: group.issues.filter(issue => issue.level === "danger" || issue.level === "warning") })).filter(group => group.issues.length);
  const other = groups.map(group => ({ ...group, issues: group.issues.filter(issue => issue.level !== "danger" && issue.level !== "warning") })).filter(group => group.issues.length);
  const attentionCount = attention.reduce((count, group) => count + group.issues.length, 0);
  const renderGroups = (rows: typeof groups) => rows.map(({ provider, issues }) => <Card key={provider.id}><CardHeader><CardTitle>{providerLabel(provider)}</CardTitle></CardHeader><CardContent className="space-y-2">{issues.map(issue => <Link key={`${provider.id}:${issue.title}:${issue.settingKey}`} href={`/dashboard/${guildId}/providers/${provider.id}${issue.settingKey ? `?setting=${encodeURIComponent(issue.settingKey)}` : ""}`} className="block rounded-md border p-3 hover:border-primary"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0 break-words font-medium">{issue.title}</div><span className="flex shrink-0 items-center gap-2"><Badge tone={issue.level === "danger" ? "danger" : issue.level === "warning" ? "warning" : "muted"}>{levelLabel(issue.level, locale)}</Badge><ChevronRight size={16} aria-hidden="true" /></span></div><div className="mt-1 break-words text-sm text-muted-foreground">{issue.detail}</div></Link>)}</CardContent></Card>);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale} isAdmin={session.user.isAdmin}>
      <div className="space-y-4">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold">{t("diagnostics.title")}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm"><AlertTriangle size={16} aria-hidden="true" /><span>{locale === "ja" ? "確認が必要な設定" : "Settings needing attention"}</span><Badge tone={attentionCount ? "warning" : "success"}>{attentionCount}</Badge></div>
        </header>
        {renderGroups(attention)}
        {other.length ? <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">{locale === "ja" ? "停止中のサービス・その他の設定" : "Disabled services and other settings"}</summary><div className="mt-4 space-y-3">{renderGroups(other)}</div></details> : null}
      </div>
    </DashboardShell>
  );
}
