import { usesNewDashboardUI } from "@/lib/ui-rollout";
import LegacyPage from "@/legacy/pages/guild-overview";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronRight, Eye, Layers3, Search } from "lucide-react";
import { AccessDenied } from "@/components/dashboard/access-denied";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { settingChoiceTitle } from "@/components/settings/settings-presentation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getGuildAccess } from "@/lib/discord";
import { diagnoseProvider } from "@/lib/diagnostics";
import { getMediaCacheStatus } from "@/lib/media-cache";
import { getDashboardLocale } from "@/lib/server-locale";
import { getBotProviders, providerLabel } from "@/lib/settings-catalog";
import { getProviderSettingsState } from "@/lib/settings-db";
import { requireDashboardSession } from "@/lib/server-session";
import "@/components/settings/settings-workspace.css";

type Params = { params: Promise<{ guildId: string }> };

export default async function GuildOverviewPage({ params }: Params) {
  const { guildId } = await params;
  const locale = await getDashboardLocale();
  const ja = locale === "ja";
  const session = await requireDashboardSession();
  if (!await usesNewDashboardUI(session)) return <LegacyPage params={params} />;
  const access = await getGuildAccess(session, guildId);
  if (!access) return <AccessDenied locale={locale} />;

  const providers = await Promise.all(getBotProviders().map(async provider => {
    const states = await getProviderSettingsState(provider.id, guildId, locale);
    const issues = diagnoseProvider(provider.id, states, locale);
    return { providerId: provider.id, label: providerLabel(provider), states, issues, enabled: states.find(state => state.key === "enabled")?.value === true, customized: states.some(state => state.changedFromDefault) };
  }));
  const enabled = providers.filter(provider => provider.enabled);
  const disabled = providers.filter(provider => !provider.enabled);
  const attention = providers.flatMap(provider => provider.issues.filter(issue => issue.level === "warning" || issue.level === "danger").map(issue => ({ provider, issue })));
  const media = await getMediaCacheStatus().catch(() => null);
  const displayMode = (provider: typeof providers[number]) => ["display_density", "media_display_mode"].map(key => {
    const setting = provider.states.find(state => state.key === key);
    return setting ? settingChoiceTitle(setting, String(setting.value), locale) : null;
  }).filter(Boolean);

  return (
    <DashboardShell guildId={guildId} guildName={access.name} canEdit={access.canEdit} locale={locale} isAdmin={session.user.isAdmin}>
      <div className="space-y-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="min-w-0 break-words text-2xl font-semibold">{access.name}</h1>
          <Button asChild className="min-h-11"><Link href={`/dashboard/${guildId}/providers`}><Layers3 size={16} aria-hidden="true" />{ja ? "リンクを展開するサービスを選ぶ" : "Choose services to expand"}</Link></Button>
        </header>

        <div className="grid gap-3 sm:grid-cols-3">
          <Link href={`/dashboard/${guildId}/providers`} className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4 hover:border-primary"><div><div className="text-sm font-medium">{ja ? "展開するサービス" : "Enabled services"}</div><div className="mt-2 text-2xl font-semibold">{enabled.length}<span className="ml-2 text-sm font-normal text-muted-foreground">{ja ? `${providers.length}サービス中` : `of ${providers.length}`}</span></div></div><ChevronRight size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" /></Link>
          <Link href={`/dashboard/${guildId}/settings?changed=1`} className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4 hover:border-primary"><div><div className="text-sm font-medium">{ja ? "初期値から変更したサービス" : "Customized services"}</div><div className="mt-2 text-2xl font-semibold">{providers.filter(provider => provider.customized).length}</div></div><ChevronRight size={18} className="shrink-0 text-muted-foreground" aria-hidden="true" /></Link>
          <Link href={`/dashboard/${guildId}/diagnostics`} className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4 hover:border-primary"><div><div className="text-sm font-medium">{ja ? "確認が必要な設定" : "Settings needing attention"}</div><div className={`mt-2 text-2xl font-semibold ${attention.length ? "text-amber-700" : "text-green-700"}`}>{attention.length}</div></div>{attention.length ? <AlertTriangle size={20} className="shrink-0 text-amber-700" aria-hidden="true" /> : <CheckCircle2 size={20} className="shrink-0 text-green-700" aria-hidden="true" />}</Link>
        </div>

        {attention.length ? <Card><CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle size={18} aria-hidden="true" />{ja ? "先に確認する設定" : "Review these settings"}</CardTitle></CardHeader><CardContent className="space-y-2">{attention.map(({ provider, issue }) => <Link key={`${provider.providerId}:${issue.title}:${issue.settingKey}`} className="flex items-start gap-3 rounded-md border p-3 hover:border-primary" href={`/dashboard/${guildId}/providers/${provider.providerId}${issue.settingKey ? `?setting=${encodeURIComponent(issue.settingKey)}` : ""}`}><div className="min-w-0 flex-1"><div className="text-xs text-muted-foreground">{provider.label}</div><div className="mt-1 text-sm font-medium">{issue.title}</div></div><ChevronRight size={16} className="mt-1 shrink-0 text-muted-foreground" aria-hidden="true" /></Link>)}</CardContent></Card> : null}

        <section className="space-y-3" aria-labelledby="enabled-services-heading">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="enabled-services-heading" className="text-base font-semibold">{ja ? "展開するサービス" : "Enabled services"}</h2><Button variant="outline" asChild><Link href={`/dashboard/${guildId}/preview`}><Eye size={16} aria-hidden="true" />{ja ? "Discordの表示例を見る" : "Preview on Discord"}</Link></Button></div>
          {enabled.length ? <div className="service-directory">{enabled.map(provider => <Link key={provider.providerId} href={`/dashboard/${guildId}/providers/${provider.providerId}`}><div className="min-w-0"><div className="font-medium">{provider.label}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{displayMode(provider).map(mode => <span key={mode}>{mode}</span>)}</div></div><span className="flex items-center gap-2 text-sm"><span className="hidden sm:inline">{ja ? "リンク表示を調整" : "Adjust link display"}</span><ChevronRight size={18} aria-hidden="true" /></span></Link>)}</div> : <Button asChild><Link href={`/dashboard/${guildId}/providers`}>{ja ? "展開するサービスを選ぶ" : "Choose services to expand"}</Link></Button>}
          {disabled.length ? <details className="rounded-lg border bg-card"><summary className="cursor-pointer p-4 text-sm font-medium">{ja ? `展開しないサービス ${disabled.length}件` : `${disabled.length} disabled services`}</summary><div className="service-directory rounded-none border-x-0 border-b-0">{disabled.map(provider => <Link key={provider.providerId} href={`/dashboard/${guildId}/providers/${provider.providerId}?setting=enabled`}><span className="min-w-0 break-words text-sm font-medium">{provider.label}</span><span className="flex items-center gap-2 text-sm text-muted-foreground">{ja ? "展開を有効にする" : "Enable expansion"}<ChevronRight size={16} aria-hidden="true" /></span></Link>)}</div></details> : null}
        </section>

        <Button variant="outline" asChild><Link href={`/dashboard/${guildId}/settings`}><Search size={16} aria-hidden="true" />{ja ? "全サービスから設定を探す" : "Find settings across services"}</Link></Button>
        <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium text-muted-foreground">{ja ? "共有メディアの保守" : "Shared media maintenance"}</summary><div className="mt-3 flex flex-wrap items-center gap-2"><Badge tone={media?.expiredCount ? "warning" : "muted"}>{ja ? `期限切れ ${media?.expiredCount ?? "—"}件` : `${media?.expiredCount ?? "—"} expired`}</Badge><Badge tone="muted">{ja ? `保存済み ${media?.totalCacheCount ?? "—"}件` : `${media?.totalCacheCount ?? "—"} cached`}</Badge><Button asChild variant="outline"><Link href={`/dashboard/${guildId}/media`}>{ja ? "保存メディアを確認" : "Inspect cached media"}</Link></Button></div></details>
      </div>
    </DashboardShell>
  );
}
