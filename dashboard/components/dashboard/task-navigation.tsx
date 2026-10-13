"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Bookmark, ChevronRight, Settings2 } from "lucide-react";
import type { DashboardLocale } from "@/lib/i18n";

export function TaskNavigation({ guildId, locale, overview = false }: { guildId?: string; locale: DashboardLocale; overview?: boolean }) {
  const pathname = usePathname(), ja = locale === "ja";
  const items = [
    { href: guildId ? `/dashboard/${guildId}/providers` : "/dashboard?mode=user", icon: Settings2,
      title: ja ? "リンク展開" : "Link expansion", action: ja ? "リンク展開を設定" : "Edit link expansion" },
    { href: guildId ? `/dashboard/${guildId}/automation` : "/dashboard/automation", icon: Bell,
      title: ja ? "自動通知" : "Notifications", action: ja ? "自動通知を登録" : "Add a notification" },
    { href: "/dashboard/personal-links", icon: Bookmark,
      title: ja ? "あとで見る" : "Saved links", action: ja ? "リンクを保存" : "Save a link" },
  ];
  return <nav className={overview ? "dashboard-task-hub" : "dashboard-task-navigation"} aria-label={ja ? "主な機能" : "Main navigation"}>{items.map(({ icon: Icon, ...item }) => {
    const active = pathname === item.href.split("?")[0] || !!guildId && item.href.endsWith("providers") && pathname?.startsWith(`${item.href}/`);
    return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}><Icon size={overview ? 22 : 17} aria-hidden /><span><strong>{overview ? item.action : item.title}</strong></span>{overview && <ChevronRight size={18} className="dashboard-task-chevron" aria-hidden />}</Link>;
  })}</nav>;
}
