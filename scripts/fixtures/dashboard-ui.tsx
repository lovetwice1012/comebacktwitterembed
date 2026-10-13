import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Link from "next/link";
import { Globe2 } from "lucide-react";
import { DashboardShell as PreviewDashboardShell } from "../../dashboard/components/dashboard/dashboard-shell";
import { GuildList as PreviewGuildList } from "../../dashboard/components/dashboard/guild-list";
import { AccessManagement as PreviewAccessManagement } from "../../dashboard/components/dashboard/access-management";
import { AccessDenied as PreviewAccessDenied } from "../../dashboard/components/dashboard/access-denied";
import { ProviderList as PreviewProviderList } from "../../dashboard/components/providers/provider-list";
import { ProviderSettingsForm as PreviewProviderSettingsForm } from "../../dashboard/components/settings/provider-settings-form";
import { CrossSettingsView as PreviewCrossSettingsView } from "../../dashboard/components/settings/cross-settings-view";
import { ProviderPreviewBrowser } from "../../dashboard/components/settings/provider-preview-browser";
import { PersonalLinksWorkspace as PreviewPersonalLinksWorkspace } from "../../dashboard/components/personal-links/personal-links-workspace";
import { AuditHistory } from "../../dashboard/features/audit/audit-history";
import { presentAuditEntry } from "../../dashboard/features/audit/audit-history-model";
import { CleanupExpiredButton as PreviewCleanupExpiredButton } from "../../dashboard/components/media/media-actions";
import { DashboardUIProvider } from "../../dashboard/components/dashboard/dashboard-ui-provider";
import { DashboardShell as LegacyDashboardShell } from "../../dashboard/legacy/components/dashboard/dashboard-shell";
import { DashboardWorkspace as LegacyDashboardWorkspace } from "../../dashboard/legacy/components/dashboard/dashboard-workspace";
import { GuildSwitcher as LegacyGuildSwitcher } from "../../dashboard/legacy/components/dashboard/guild-switcher";
import { LanguageSwitcher as LegacyLanguageSwitcher } from "../../dashboard/legacy/components/dashboard/language-switcher";
import { SignOutButton as LegacySignOutButton } from "../../dashboard/legacy/components/dashboard/auth-buttons";
import { GuildList as LegacyGuildList } from "../../dashboard/legacy/components/dashboard/guild-list";
import { AccessManagement as LegacyAccessManagement } from "../../dashboard/legacy/components/dashboard/access-management";
import { AccessDenied as LegacyAccessDenied } from "../../dashboard/legacy/components/dashboard/access-denied";
import { ProviderList as LegacyProviderList } from "../../dashboard/legacy/components/providers/provider-list";
import { ProviderSettingsForm as LegacyProviderSettingsForm } from "../../dashboard/legacy/components/settings/provider-settings-form";
import { CrossSettingsView as LegacyCrossSettingsView } from "../../dashboard/legacy/components/settings/cross-settings-view";
import { PersonalLinksWorkspace as LegacyPersonalLinksWorkspace } from "../../dashboard/legacy/components/personal-links/personal-links-workspace";
import { OutputPreviewCard as LegacyOutputPreviewCard } from "../../dashboard/legacy/components/preview/output-preview-card";
import { CleanupExpiredButton as LegacyCleanupExpiredButton } from "../../dashboard/legacy/components/media/media-actions";
import { createTranslator as createLegacyTranslator } from "../../dashboard/legacy/lib/i18n";
import { buildPreview as buildLegacyPreview } from "../../dashboard/legacy/lib/settings-preview";
import { Badge as PreviewBadge } from "../../dashboard/components/ui/badge";
import { Card as PreviewCard, CardContent as PreviewCardContent, CardDescription as PreviewCardDescription, CardHeader as PreviewCardHeader, CardTitle as PreviewCardTitle } from "../../dashboard/components/ui/card";
import { Card as LegacyCard, CardContent as LegacyCardContent, CardDescription as LegacyCardDescription, CardHeader as LegacyCardHeader, CardTitle as LegacyCardTitle } from "../../dashboard/legacy/components/ui/card";
import { Badge as LegacyBadge } from "../../dashboard/legacy/components/ui/badge";
import { createTranslator, type DashboardLocale } from "../../dashboard/lib/i18n";
import type { SettingState } from "../../dashboard/lib/types";
import { buildPreview } from "../../dashboard/lib/settings-preview";
import { formatBytes } from "../../dashboard/lib/format";
import "../../dashboard/app/globals.css";

function LegacyPreview({ data, guild, locale }: any) {
  return <div className="grid gap-4 xl:grid-cols-2">{data.providers.map((provider: any) => <LegacyCard key={provider.providerId}><LegacyCardHeader><LegacyCardTitle>{provider.label}</LegacyCardTitle></LegacyCardHeader><LegacyCardContent><LegacyOutputPreviewCard preview={buildLegacyPreview(provider.providerId, data.settings[`${guild.guildId}:${provider.providerId}`], locale)} locale={locale} /></LegacyCardContent></LegacyCard>)}</div>;
}

// Mirror the legacy server component's card output using fake records. The
// actual AuditLogsPage remains covered by route tests with authorization mocks.
function LegacyHistory({ logs }: any) {
  return <div className="space-y-3" data-fixture-legacy-history>{logs.map((log: any) => <LegacyCard key={log.auditLogId}><LegacyCardHeader><LegacyCardTitle>{log.action}</LegacyCardTitle><LegacyCardDescription>{log.actorUsernameSnapshot}</LegacyCardDescription></LegacyCardHeader><LegacyCardContent className="grid gap-3 lg:grid-cols-2"><pre className="max-h-64 min-w-0 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(log.before, null, 2)}</pre><pre className="max-h-64 min-w-0 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(log.after, null, 2)}</pre></LegacyCardContent></LegacyCard>)}</div>;
}

function FixtureShell({ preview, data, guild, selectedGuildIds, locale, children }: any) {
  if (preview) return <PreviewDashboardShell guildId={guild?.guildId} guildName={guild?.name} canEdit={guild?.canEdit} selectedGuildIds={selectedGuildIds} guilds={data.guilds} locale={locale} isAdmin={data.viewer.isAdmin}>{children}</PreviewDashboardShell>;
  if (guild) return <LegacyDashboardShell guildId={guild.guildId} guildName={guild.name} canEdit={guild.canEdit} locale={locale}>{children}</LegacyDashboardShell>;
  if (window.location.pathname === "/dashboard/personal-links") return <main className="mx-auto min-h-screen max-w-7xl space-y-6 px-4 py-6 sm:px-6"><Link className="text-sm text-muted-foreground hover:underline" href={data.viewer.isAdmin ? "/admin" : "/dashboard"}>← {locale === "ja" ? "ダッシュボードへ" : "Dashboard"}</Link>{children}</main>;
  const t = createLegacyTranslator(locale);
  return <main className="mx-auto min-h-screen max-w-7xl space-y-5 px-3 py-4 sm:space-y-6 sm:px-4 sm:py-6"><header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h1 className="text-2xl font-semibold">{t("dashboard.guilds.title")}</h1><p className="text-sm text-muted-foreground">{t("dashboard.guilds.selectHelp")}</p></div><div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end"><LegacyGuildSwitcher selectedGuildIds={[]} guilds={data.guilds} locale={locale} /><LegacyLanguageSwitcher locale={locale} /><Link href="/dashboard/personal-links" className="rounded-md border px-3 py-2 text-sm hover:bg-muted">{locale === "ja" ? "あとで見る・通知" : "Saved links & notifications"}</Link><LegacySignOutButton locale={locale} /></div></header><LegacyDashboardWorkspace initialGuildIds={[]} locale={locale} defaultLayout="plain">{children}</LegacyDashboardWorkspace></main>;
}

function Fixture() {
  const [data, setData] = useState<any>(null), [failure, setFailure] = useState(""), [authNotice, setAuthNotice] = useState(false);
  const [version, setVersion] = useState(0);
  const params = new URLSearchParams(window.location.search);
  const localeCookie = document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith("dashboard_locale="))?.split("=").slice(1).join("=");
  const locale = (params.get("locale") || (localeCookie ? decodeURIComponent(localeCookie) : "ja")) as DashboardLocale;
  const ja = locale === "ja";
  const t = (data?.uiVersion === "legacy" ? createLegacyTranslator : createTranslator)(locale);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/fixture/bootstrap", { signal: controller.signal }).then(response => { if (!response.ok) throw new Error("Fixture unavailable"); return response.json(); }).then(setData).catch(error => { if (!controller.signal.aborted) setFailure(error.message); });
    return () => controller.abort();
  }, [version]);
  useEffect(() => { const markAuth = () => setAuthNotice(true); window.addEventListener("dashboard-fixture:auth", markAuth); return () => window.removeEventListener("dashboard-fixture:auth", markAuth); }, []);
  if (!data) return <main className="p-6">{failure || "検証用の架空データを読み込み中…"}</main>;
  const preview = data.uiVersion === "preview";
  const GuildList: React.ComponentType<any> = preview ? PreviewGuildList : LegacyGuildList;
  const ProviderList: React.ComponentType<any> = preview ? PreviewProviderList : LegacyProviderList;
  const AccessManagement: React.ComponentType<any> = preview ? PreviewAccessManagement : LegacyAccessManagement;
  const AccessDenied: React.ComponentType<any> = preview ? PreviewAccessDenied : LegacyAccessDenied;
  const ProviderSettingsForm: React.ComponentType<any> = preview ? PreviewProviderSettingsForm : LegacyProviderSettingsForm;
  const CrossSettingsView: React.ComponentType<any> = preview ? PreviewCrossSettingsView : LegacyCrossSettingsView;
  const PersonalLinksWorkspace: React.ComponentType<any> = preview ? PreviewPersonalLinksWorkspace : LegacyPersonalLinksWorkspace;
  const CleanupExpiredButton: React.ComponentType<any> = preview ? PreviewCleanupExpiredButton : LegacyCleanupExpiredButton;
  const Card: React.ComponentType<any> = preview ? PreviewCard : LegacyCard;
  const CardHeader: React.ComponentType<any> = preview ? PreviewCardHeader : LegacyCardHeader;
  const CardTitle: React.ComponentType<any> = preview ? PreviewCardTitle : LegacyCardTitle;
  const CardDescription: React.ComponentType<any> = preview ? PreviewCardDescription : LegacyCardDescription;
  const CardContent: React.ComponentType<any> = preview ? PreviewCardContent : LegacyCardContent;
  const Badge: React.ComponentType<any> = preview ? PreviewBadge : LegacyBadge;
  const path = window.location.pathname;
  const match = path.match(/^\/dashboard\/(\d+)(?:\/|$)/);
  const guild = data.guilds.find((item: any) => item.guildId === match?.[1]);
  const selectedGuildIds = path === "/dashboard/bulk" ? (params.get("guildIds") || "").split(",").filter(Boolean) : guild ? [guild.guildId] : [];
  const title = (name: string, extra?: React.ReactNode) => <header className={preview ? "dashboard-page-heading" : "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"}><div>{preview && guild && <span className="dashboard-eyebrow">{guild.name}</span>}<h1 className={preview ? undefined : "text-2xl font-semibold"}>{name}</h1></div>{extra}</header>;
  let content: React.ReactNode;
  if (path === "/dashboard/personal-links") content = <PersonalLinksWorkspace viewerId={data.viewer.id} displayName={data.viewer.displayName} locale={locale} />;
  else if (guild) {
    const providerMatch = path.match(/\/providers\/([^/]+)$/), providerId = providerMatch?.[1];
    const provider = data.providers.find((item: any) => item.providerId === providerId);
    if (provider) content = <>{title(provider.label, <Link href={`/dashboard/${guild.guildId}/providers`}>{ja ? "サービス一覧" : "Services"}</Link>)}<ProviderSettingsForm guildId={guild.guildId} providerId={providerId!} providerLabel={provider.label} settings={data.settings[`${guild.guildId}:${providerId}`]} canEdit={guild.canEdit} locale={locale} viewerId={data.viewer.id} scopeLabel={guild.name} onSaved={() => setVersion(value => value + 1)} /></>;
    else if (path.endsWith("/settings")) content = <>{title(preview ? ja ? "設定を探す" : "Find settings" : t("settingsCross.title"))}<CrossSettingsView guildId={guild.guildId} guildName={guild.name} viewerId={data.viewer.id} locale={locale} canManage={guild.canManageGuild} onSaved={() => setVersion(value => value + 1)} items={data.providers.flatMap((provider: any) => (data.settings[`${guild.guildId}:${provider.providerId}`] as SettingState[]).map(setting => ({ providerId: provider.providerId, providerLabel: provider.label, setting })))} /></>;
    else if (path.endsWith("/preview")) content = <>{title(preview ? ja ? "表示を確認" : "Preview output" : t("preview.title"))}{preview ? <ProviderPreviewBrowser guildId={guild.guildId} locale={locale} items={data.providers.map((provider: any) => { const states = data.settings[`${guild.guildId}:${provider.providerId}`] as SettingState[]; return { providerId: provider.providerId, label: provider.label, enabled: states.find(setting => setting.key === "enabled")?.value === true, preview: buildPreview(provider.providerId, states, locale) }; })} /> : <LegacyPreview data={data} guild={guild} locale={locale} />}</>;
    else if (path.endsWith("/access")) content = guild.canManageGuild ? <><p className="dashboard-eyebrow">{guild.name}</p><AccessManagement guildId={guild.guildId} locale={locale} /></> : <AccessDenied guildId={guild.guildId} locale={locale} required={ja ? "サーバーの管理 または 管理者" : "Manage Server or Administrator"} />;
    else if (path.endsWith("/logs") || path.endsWith("/audit-logs")) {
      const catalog = data.providers.map((provider: any) => ({ ...provider, enabledByDefault: true, settings: (data.settings[`${guild.guildId}:${provider.providerId}`] as SettingState[]).map(setting => setting.spec) }));
      content = guild.canManageGuild ? <>{title(preview ? ja ? "変更履歴" : "Change history" : t("logs.title"))}{preview ? <AuditHistory guildId={guild.guildId} locale={locale} entries={data.auditLogs.map((log: any) => presentAuditEntry({ ...log, guildId: guild.guildId }, catalog, locale))} /> : <LegacyHistory logs={data.auditLogs} />}</> : <AccessDenied guildId={guild.guildId} locale={locale} required={ja ? "サーバーの管理 または 管理者" : "Manage Server or Administrator"} />;
    } else if (path.endsWith("/media")) content = <div className="space-y-4"><header className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><h1 className="text-2xl font-semibold">{ja ? "メディア容量" : "Media storage"}</h1><p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Globe2 size={15} aria-hidden />{ja ? "全サーバー共通" : "Shared across all servers"}</p></div><CleanupExpiredButton guildId={guild.guildId} locale={locale} canClean={guild.permissions.administrator} /></header><div className="grid gap-3 md:grid-cols-3">{[{ title: data.media.running ? t("media.running") : t("media.stopped"), label: t("media.serverStatus") }, { title: data.media.totalCacheCount, label: t("media.cacheItems") }, { title: formatBytes(data.media.totalSizeBytes), label: t("media.totalSize") }].map(item => <Card key={item.label}><CardHeader><CardTitle>{item.title}</CardTitle><CardDescription>{item.label}</CardDescription></CardHeader></Card>)}</div>{data.media.providers.map((provider: any) => <Card key={provider.providerId}><CardHeader><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><CardTitle>{provider.label}</CardTitle><CardDescription>{provider.domain}</CardDescription></div><Badge tone={provider.expiredCount ? "warning" : "muted"}>{t("media.expired", { count: provider.expiredCount })}</Badge></div></CardHeader><CardContent><div className="grid gap-3 text-sm sm:grid-cols-3">{[{ label: t("media.cacheItems"), value: provider.cacheCount }, { label: t("media.totalSize"), value: formatBytes(provider.totalSizeBytes) }, { label: t("media.expiredLabel"), value: provider.expiredCount }].map(item => <div key={item.label} className="rounded-md bg-muted p-3"><div className="text-muted-foreground">{item.label}</div><div className="mt-1 text-lg font-semibold">{item.value}</div></div>)}</div></CardContent></Card>)}</div>;
    else content = <>{title(preview ? ja ? "リンク展開" : "Link expansion" : t("providers.title"))}<ProviderList guildId={guild.guildId} locale={locale} providers={data.providers.map((provider: any) => { const states = data.settings[`${guild.guildId}:${provider.providerId}`] as SettingState[]; return { ...provider, enabled: states.find(setting => setting.key === "enabled")?.value === true, enabledByDefault: true, changedFromDefault: states.some(setting => setting.changedFromDefault), settingCount: states.length, customizedSettingCount: states.filter(setting => setting.changedFromDefault).length, warnings: [] }; })} /></>;
  } else if (path === "/dashboard/bulk") content = <>{title(ja ? "選択したサーバー" : "Selected servers")}<div className="space-y-3">{data.guilds.filter((guild: any) => selectedGuildIds.includes(guild.guildId)).map((guild: any) => <section key={guild.guildId} className="rounded-lg border bg-card p-4"><h2 className="mb-3 font-semibold">{guild.name}</h2><Link className="underline" href={`/dashboard/${guild.guildId}/providers`}>{ja ? "リンク展開を変更" : "Edit link expansion"}</Link></section>)}</div><p className="mt-4 text-sm text-muted-foreground">検証専用の選択先一覧です。一括設定の画面はこの検証の対象外です。</p></>;
  else content = preview ? <section id="servers" className="space-y-5"><header className="dashboard-page-heading"><div><span className="dashboard-eyebrow">{ja ? "リンク展開の設定" : "Link expansion settings"}</span><h1>{ja ? "サーバー一覧" : "Servers"}</h1></div><span className="dashboard-count">{data.guilds.length}</span></header><GuildList guilds={data.guilds} locale={locale} /></section> : <GuildList guilds={data.guilds} locale={locale} />;
  return <DashboardUIProvider version={data.uiVersion} authenticated={Boolean(data.viewer.id)} locale={locale}><div className="border-b bg-accent px-4 py-2 text-center text-xs text-accent-foreground" data-fixture-banner>検証専用　架空のユーザー・サーバー・設定　メモリ内のみ保存　Discord・本番DB・認証への通信なし　UI: {data.uiVersion}　架空の利用者: {String(data.viewer.id ?? "未ログイン")}</div>{authNotice && <p role="status" className="border-b bg-muted p-2 text-center text-sm">検証用の認証ボタンです。ログイン状態は変更していません。</p>}<FixtureShell preview={preview} data={data} guild={guild} selectedGuildIds={selectedGuildIds} locale={locale}>{content}</FixtureShell></DashboardUIProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
