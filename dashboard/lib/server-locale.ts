import "server-only";

import { cookies, headers } from "next/headers";
import { normalizeDashboardLocale, type DashboardLocale } from "@/lib/i18n";

export const DASHBOARD_LOCALE_COOKIE = "dashboard_locale";

export async function getDashboardLocale(): Promise<DashboardLocale> {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(DASHBOARD_LOCALE_COOKIE)?.value;
  if (cookieLocale) return normalizeDashboardLocale(cookieLocale);

  const headerStore = await headers();
  return normalizeDashboardLocale(headerStore.get("accept-language"));
}

export function getDashboardLocaleFromRequest(req: Request): DashboardLocale {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${DASHBOARD_LOCALE_COOKIE}=([^;]+)`));
  if (match) return normalizeDashboardLocale(decodeURIComponent(match[1]));
  return normalizeDashboardLocale(req.headers.get("accept-language"));
}
