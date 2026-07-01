import "server-only";

import { cookies } from "next/headers";
import { DEFAULT_DASHBOARD_LOCALE } from "@/lib/discord-locales";
import { normalizeDashboardLocale, type DashboardLocale } from "@/lib/i18n";

export const DASHBOARD_LOCALE_COOKIE = "dashboard_locale";

export async function getDashboardLocale(): Promise<DashboardLocale> {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(DASHBOARD_LOCALE_COOKIE)?.value;
  if (cookieLocale) return normalizeDashboardLocale(cookieLocale);

  return DEFAULT_DASHBOARD_LOCALE;
}

export function getDashboardLocaleFromRequest(req: Request): DashboardLocale {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${DASHBOARD_LOCALE_COOKIE}=([^;]+)`));
  if (match) return normalizeDashboardLocale(decodeURIComponent(match[1]));
  return DEFAULT_DASHBOARD_LOCALE;
}
