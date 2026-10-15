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
import { AutomationPageFrame } from "../../dashboard/components/automation/automation-page-frame";
import type { SettingState } from "../../dashboard/lib/types";
import "../../dashboard/app/globals.css";

const params = new URLSearchParams(window.location.search);
const pathname = window.location.pathname;
const guildId = pathname.match(/^\/dashboard\/(\d+)/)?.[1] || "111111111111111111";
const editable = guildId !== "666666666666666666", guildName = editable ? "検証用サーバーA" : "検証用サーバーB";
const view = params.get("view") || (pathname === "/admin/notification-plans" ? "plan-admin" : pathname === "/dashboard/automation/plans" ? "billing" : pathname === "/dashboard/automation/support" ? "support" : pathname === "/dashboard/personal-links" ? "personal" : pathname === "/dashboard" ? "navigation" : /^\/dashboard\/\d+$/.test(pathname) ? "server" : /\/(providers|settings)(\/|$)/.test(pathname) ? "settings" : null);
const locale = params.get("locale") === "en" ? "en" : "ja";
const auditReadiness = (window as Window & { __AUTOMATION_UI_AUDIT__?: boolean }).__AUTOMATION_UI_AUDIT__ === true;
function AuditFaultControls() {
  const [route, setRoute] = React.useState("monitors/"), [mode, setMode] = React.useState("html502"), [message, setMessage] = React.useState("故障注入なし");
  async function configure(clear = false) {
    try {
      const response = await fetch("/fixture/fault", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(clear ? { mode: "clear" } : { mode, route }) });
      if (!response.ok) throw Error("fixture fault setup failed");
      setMessage(clear ? "故障を解除しました" : `次の ${route} APIを1回だけ ${mode} で失敗させます`);
    } catch { setMessage("検証用の故障設定に失敗しました"); }
  }
  return <details className="rounded border border-amber-600 p-3 text-sm"><summary>検証専用：通信障害の再現</summary><div className="space-y-2 pt-3">
    <p>この操作はローカルの架空データだけに適用します。実際のDiscord・X・決済・OAuthへ接続しません。</p>
    <label className="block">故障対象<select aria-label="検証用の故障対象" className="block w-full rounded border p-2" value={route} onChange={event => setRoute(event.target.value)}><option value="catalog">初期一覧</option><option value="monitors/">新着・価格の登録と編集</option><option value="x-monitors">X監視の登録と編集</option><option value="workflows">ルールの一覧と編集</option></select></label>
    <label className="block">故障の種類<select aria-label="検証用の故障種類" className="block w-full rounded border p-2" value={mode} onChange={event => setMode(event.target.value)}><option value="html502">HTMLの502応答</option><option value="network">通信切断</option><option value="auth">認証切れ（401）</option><option value="malformed200">壊れた一覧（200）</option></select></label>
    <button type="button" className="rounded border px-3 py-2" onClick={() => void configure()}>次のAPIを1回失敗させる</button>{" "}<button type="button" className="rounded border px-3 py-2" onClick={() => void configure(true)}>故障を解除</button>
    <p role="status" aria-label="検証用の故障設定">{message}</p>
  </div></details>;
}
const settings = [
  { key: "enabled", kind: "providerEnabled", value: true, defaultValue: true, warnings: [], spec: { key: "enabled", kind: "providerEnabled", label: { ja: "リンクを展開", en: "Expand links" }, description: {}, category: "basic", impactLevel: "low" } },
  { key: "silent_expansion", kind: "bool", value: false, defaultValue: false, warnings: [], spec: { key: "silent_expansion", kind: "bool", label: { ja: "通知音なし", en: "Silent notifications" }, description: { ja: "展開メッセージの通知音を鳴らしません。", en: "Send expansion messages silently." }, category: "output", impactLevel: "low" } },
  { key: "show_previous_shares", kind: "bool", value: true, defaultValue: true, warnings: [], spec: { key: "show_previous_shares", kind: "bool", label: { ja: "過去の共有を表示", en: "Show previous shares" }, description: {}, category: "output", impactLevel: "low" } },
] as SettingState[];

createRoot(document.getElementById("root")!).render(<React.StrictMode><div className={auditReadiness ? "space-y-4" : "mx-auto max-w-[1500px] space-y-4 p-4"}>
  <div className="rounded border border-amber-500 bg-amber-50 p-3 text-sm">ローカル検証専用 — 架空ユーザー・テストデータ。Discordへの実送信はありません。</div>
  {auditReadiness && <AuditFaultControls />}
  {view === "plan-admin" ? <><h1 className="text-2xl font-semibold">通知プラン・利用枠</h1><NotificationPlanManager /><DonationPolicyManager /></>
    : view === "billing" ? <><h1 className="text-2xl font-semibold">プラン・お支払い</h1><p>この検証画面は外部のSquare決済に接続しません。</p><SubscriptionManager /></>
    : view === "support" ? <><h1 className="text-2xl font-semibold">寄付で支援する</h1><p>この検証画面は外部のSquare決済に接続しません。</p><SquareDonationManager /></>
    : view === "navigation" ? <><h1 className="text-2xl font-semibold">{locale === "ja" ? "ダッシュボード" : "Dashboard"}</h1><TaskNavigation locale={locale} overview /><h2 className="text-lg font-semibold">{locale === "ja" ? "サーバー" : "Servers"}</h2><a className="block rounded-xl border bg-card p-5" href="/dashboard/111111111111111111/settings">{locale === "ja" ? "検証用サーバー" : "Test server"}</a></>
    : view === "personal" ? <PersonalLinksWorkspace locale={locale} viewerId="222222222222222222" displayName="Fixture" />
    : view === "server" ? <DashboardShell guildId={guildId} guildName={guildName} canEdit={editable} locale={locale}><h1 className="text-2xl font-semibold">{guildName}</h1></DashboardShell>
    : view === "settings" ? <DashboardShell guildId={guildId} guildName={guildName} canEdit={editable} locale={locale}><h1 className="text-2xl font-semibold">Twitter / X</h1><ProviderSettingsForm viewerId="222222222222222222" guildId={guildId} providerId="twitter" providerLabel="Twitter / X" settings={settings} canEdit={editable} locale={locale} onSaveChanges={async () => ({})} showResetProvider={false} /></DashboardShell>
    : auditReadiness ? <AutomationPageFrame locale={locale} isAdmin section="notifications" title="自動通知"><AutomationWorkspace viewerId="222222222222222222" presentation="embedded" canEdit /></AutomationPageFrame>
      : <AutomationWorkspace viewerId="222222222222222222" guildId="111111111111111111" canEdit />}
</div></React.StrictMode>);
