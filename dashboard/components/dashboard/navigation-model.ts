import type { DashboardLocale } from "@/lib/i18n";

export type DashboardDestination = { href: string; label: string; icon: "servers" | "notifications" | "saved" | "overview" | "providers" | "settings" | "preview" | "diagnostics" | "media" | "logs" | "access" | "bulk" | "admin" };

export function dashboardDestinations(locale: DashboardLocale, guildId?: string, isAdmin = false) {
  const ja = locale === "ja";
  const personal: DashboardDestination[] = [
    { href: "/dashboard?mode=user", label: ja ? "サーバー一覧" : "Servers", icon: "servers" },
    { href: "/dashboard/personal-links", label: ja ? "あとで見る" : "Saved links", icon: "saved" },
    { href: "/dashboard/automation", label: ja ? "自分の通知" : "My notifications", icon: "notifications" },
  ];
  const server: DashboardDestination[] = guildId ? [
    { href: `/dashboard/${guildId}`, label: ja ? "サーバーのホーム" : "Server home", icon: "overview" },
    { href: `/dashboard/${guildId}/providers`, label: ja ? "リンク展開" : "Link expansion", icon: "providers" },
    { href: `/dashboard/${guildId}/automation`, label: ja ? "サーバーの通知" : "Server notifications", icon: "notifications" },
  ] : [];
  const tools: DashboardDestination[] = guildId ? [
    { href: `/dashboard/${guildId}/settings`, label: ja ? "設定をまとめて変更" : "Edit settings together", icon: "settings" },
    { href: `/dashboard/${guildId}/preview`, label: ja ? "表示サンプル" : "Output samples", icon: "preview" },
    { href: `/dashboard/${guildId}/diagnostics`, label: ja ? "設定の確認" : "Check settings", icon: "diagnostics" },
    { href: `/dashboard/${guildId}/media`, label: ja ? "メディア容量" : "Media storage", icon: "media" },
    { href: `/dashboard/${guildId}/logs`, label: ja ? "変更履歴" : "Change history", icon: "logs" },
    { href: `/dashboard/${guildId}/access`, label: ja ? "編集メンバー" : "Editors", icon: "access" },
  ] : [];
  const administration: DashboardDestination[] = isAdmin ? [{ href: "/admin", label: ja ? "運営管理" : "Administration", icon: "admin" }] : [];
  return { personal, server, tools, administration };
}

export function isDashboardDestinationActive(pathname: string | null, href: string) {
  if (!pathname) return false;
  const target = href.split("?")[0];
  if (pathname === target) return true;
  return target.endsWith("/providers") && pathname.startsWith(`${target}/`);
}
