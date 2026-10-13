import React from "react";
import { createRoot } from "react-dom/client";
import { AutomationWorkspace } from "../../dashboard/components/automation/automation-workspace";
import { NotificationPlanManager } from "../../dashboard/components/admin/notification-plan-manager";
import { SubscriptionManager } from "../../dashboard/components/automation/subscription-manager";
import { SquareDonationManager } from "../../dashboard/components/automation/square-donation-manager";
import { DonationPolicyManager } from "../../dashboard/components/admin/donation-policy-manager";
import { PersonalLinksWorkspace } from "../../dashboard/components/personal-links/personal-links-workspace";
import { ProviderSettingsForm } from "../../dashboard/components/settings/provider-settings-form";
import { TaskNavigation } from "../../dashboard/components/dashboard/task-navigation";
import { DashboardShell } from "../../dashboard/components/dashboard/dashboard-shell";
import type { SettingState } from "../../dashboard/lib/types";
import "../../dashboard/app/globals.css";

const params = new URLSearchParams(window.location.search);
const pathname = window.location.pathname;
const guildId = pathname.match(/^\/dashboard\/(\d+)/)?.[1] || "111111111111111111";
const editable = guildId !== "666666666666666666", guildName = editable ? "検証用サーバーA" : "検証用サーバーB";
const view = params.get("view") || (pathname === "/admin/notification-plans" ? "plan-admin" : pathname === "/dashboard/automation/plans" ? "billing" : pathname === "/dashboard/automation/support" ? "support" : pathname === "/dashboard/personal-links" ? "personal" : pathname === "/dashboard" ? "navigation" : /^\/dashboard\/\d+$/.test(pathname) ? "server" : /\/(providers|settings)(\/|$)/.test(pathname) ? "settings" : null);
const locale = params.get("locale") === "en" ? "en" : "ja";
const settings = [
  { key: "enabled", kind: "providerEnabled", value: true, defaultValue: true, warnings: [], spec: { key: "enabled", kind: "providerEnabled", label: { ja: "リンクを展開", en: "Expand links" }, description: {}, category: "basic", impactLevel: "low" } },
  { key: "silent_expansion", kind: "bool", value: false, defaultValue: false, warnings: [], spec: { key: "silent_expansion", kind: "bool", label: { ja: "通知音なし", en: "Silent notifications" }, description: { ja: "展開メッセージの通知音を鳴らしません。", en: "Send expansion messages silently." }, category: "output", impactLevel: "low" } },
  { key: "show_previous_shares", kind: "bool", value: true, defaultValue: true, warnings: [], spec: { key: "show_previous_shares", kind: "bool", label: { ja: "過去の共有を表示", en: "Show previous shares" }, description: {}, category: "output", impactLevel: "low" } },
] as SettingState[];

createRoot(document.getElementById("root")!).render(<React.StrictMode><main className="mx-auto max-w-[1500px] space-y-4 p-4">
  <div className="rounded border border-amber-500 bg-amber-50 p-3 text-sm">ローカル検証専用 — 架空ユーザー・テストデータ。Discordへの実送信はありません。</div>
  {view === "plan-admin" ? <><h1 className="text-2xl font-semibold">通知プラン・利用枠</h1><NotificationPlanManager /><DonationPolicyManager /></>
    : view === "billing" ? <><h1 className="text-2xl font-semibold">プラン・お支払い</h1><p>この検証画面は外部のSquare決済に接続しません。</p><SubscriptionManager /></>
    : view === "support" ? <><h1 className="text-2xl font-semibold">寄付で支援する</h1><p>この検証画面は外部のSquare決済に接続しません。</p><SquareDonationManager /></>
    : view === "navigation" ? <><h1 className="text-2xl font-semibold">{locale === "ja" ? "ダッシュボード" : "Dashboard"}</h1><TaskNavigation locale={locale} overview /><h2 className="text-lg font-semibold">{locale === "ja" ? "サーバー" : "Servers"}</h2><a className="block rounded-xl border bg-card p-5" href="/dashboard/111111111111111111/settings">{locale === "ja" ? "検証用サーバー" : "Test server"}</a></>
    : view === "personal" ? <PersonalLinksWorkspace locale={locale} viewerId="222222222222222222" displayName="Fixture" />
    : view === "server" ? <DashboardShell guildId={guildId} guildName={guildName} canEdit={editable} locale={locale}><h1 className="text-2xl font-semibold">{guildName}</h1></DashboardShell>
    : view === "settings" ? <DashboardShell guildId={guildId} guildName={guildName} canEdit={editable} locale={locale}><h1 className="text-2xl font-semibold">Twitter / X</h1><ProviderSettingsForm viewerId="222222222222222222" guildId={guildId} providerId="twitter" providerLabel="Twitter / X" settings={settings} canEdit={editable} locale={locale} onSaveChanges={async () => ({})} showResetProvider={false} /></DashboardShell>
    : <AutomationWorkspace viewerId="222222222222222222" guildId="111111111111111111" canEdit />}
</main></React.StrictMode>);
