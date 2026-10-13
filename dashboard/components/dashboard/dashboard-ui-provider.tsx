"use client";

import { createContext, useContext, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { DashboardUIPreference } from "./dashboard-ui-preference";
import type { DashboardLocale } from "@/lib/i18n";

export type DashboardUIVersion = "legacy" | "preview";
const DashboardUIContext = createContext<DashboardUIVersion>("legacy");

export function DashboardUIProvider({ version, children, authenticated = false, locale = "ja" }: { version: DashboardUIVersion; children: ReactNode; authenticated?: boolean; locale?: DashboardLocale }) {
  const pathname = usePathname();
  const ordinaryPage = pathname === "/" || (pathname.startsWith("/dashboard") && !/^\/dashboard(?:\/[^/]+)?\/automation(?:\/|$)/.test(pathname));
  return <DashboardUIContext.Provider value={version}>{authenticated && ordinaryPage ? <DashboardUIPreference version={version} locale={locale} /> : null}{children}</DashboardUIContext.Provider>;
}

export function useDashboardUIVersion() { return useContext(DashboardUIContext); }
