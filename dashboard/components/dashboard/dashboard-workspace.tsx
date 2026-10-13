"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Bell, Bookmark, ChevronDown, ClipboardList, FileClock, Gauge, Layers3, Menu, Settings2, ShieldCheck, Server, UsersRound, Video, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { DashboardLocale } from "@/lib/i18n";
import { dashboardDestinations, isDashboardDestinationActive, type DashboardDestination } from "./navigation-model";

const icons = { servers: Server, notifications: Bell, saved: Bookmark, overview: Gauge, providers: Layers3, settings: Settings2, preview: ClipboardList, diagnostics: Activity, media: Video, logs: FileClock, access: UsersRound, bulk: Layers3, admin: ShieldCheck };

export function DashboardWorkspace({ locale, defaultGuildId, guildName, children, isAdmin = false, initialGuildIds }: {
  initialGuildIds: string[];
  locale: DashboardLocale;
  defaultLayout: "plain" | "server";
  defaultGuildId?: string;
  guildName?: string;
  isAdmin?: boolean;
  children: ReactNode;
}) {
  const router = useRouter(), pathname = usePathname(), ja = locale === "ja";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId(), menuButton = useRef<HTMLButtonElement>(null);
  const destinations = dashboardDestinations(locale, defaultGuildId, isAdmin);
  if (initialGuildIds.length > 1) destinations.tools.push({ href: `/dashboard/bulk?guildIds=${encodeURIComponent(initialGuildIds.join(","))}`, label: ja ? "複数サーバーの設定" : "Multiple server settings", icon: "bulk" });
  const active = [...destinations.personal, ...destinations.server, ...destinations.tools].find(item => isDashboardDestinationActive(pathname, item.href));
  const toolsActive = destinations.tools.some(item => isDashboardDestinationActive(pathname, item.href));

  useEffect(() => {
    const navigate = (event: Event) => {
      const href = (event as CustomEvent<{ href?: string }>).detail?.href;
      if (!href?.startsWith("/dashboard")) return;
      event.preventDefault();
      router.push(href);
    };
    window.addEventListener("dashboard:guild-navigation", navigate);
    return () => window.removeEventListener("dashboard:guild-navigation", navigate);
  }, [router]);
  useEffect(() => {
    const header = document.querySelector<HTMLElement>("[data-dashboard-header]");
    if (!header) return;
    const measure = () => document.documentElement.style.setProperty("--dashboard-header-height", `${header.getBoundingClientRect().height}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  function destinationLink(item: DashboardDestination) {
    const Icon = icons[item.icon];
    return <Link key={item.href} href={item.href} aria-current={isDashboardDestinationActive(pathname, item.href) ? "page" : undefined} onClick={() => setMenuOpen(false)}><Icon size={18} aria-hidden /><span>{item.label}</span></Link>;
  }
  return <div className="dashboard-layout">
    <nav className="dashboard-primary-navigation" aria-label={ja ? "ダッシュボード" : "Dashboard"} onKeyDown={event => { if (event.key === "Escape" && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); } }}>
      <button ref={menuButton} type="button" className="dashboard-mobile-menu" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen(value => !value)}>{menuOpen ? <X size={19} aria-hidden /> : <Menu size={19} aria-hidden />}<span>{ja ? "メニュー" : "Menu"}</span><strong>{active?.label}</strong><ChevronDown size={16} aria-hidden /></button>
      <div id={menuId} className="dashboard-navigation-panel" data-open={menuOpen}>
        <div className="dashboard-navigation-group"><p>{ja ? "自分のスペース" : "My space"}</p>{destinations.personal.map(destinationLink)}</div>
        {destinations.server.length ? <div className="dashboard-navigation-group"><p className="dashboard-navigation-server" title={guildName}>{guildName || (ja ? "選択中のサーバー" : "Selected server")}</p>{destinations.server.map(destinationLink)}</div> : null}
        {destinations.tools.length ? <details className="dashboard-navigation-tools" open={toolsActive || undefined}><summary>{ja ? "詳細設定と履歴" : "Settings and history"}<ChevronDown size={14} aria-hidden /></summary><div>{destinations.tools.map(destinationLink)}</div></details> : null}
        {destinations.administration.map(destinationLink)}
      </div>
    </nav>
    <main id="dashboard-content" tabIndex={-1} className="dashboard-content">{children}</main>
  </div>;
}
