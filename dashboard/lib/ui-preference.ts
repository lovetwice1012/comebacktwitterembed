import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { getNextAuthSecret } from "@/lib/env";

export type DashboardUIPreference = "legacy" | "preview";
export const DASHBOARD_UI_PREFERENCE_MAX_AGE = 60 * 60 * 24 * 365;
const COOKIE_PREFIX = "cbte_dashboard_ui_";
const USER_ID = /^\d{16,24}$/;

export function dashboardUIPreferenceCookieName(userId: string) {
  return USER_ID.test(userId) ? `${COOKIE_PREFIX}${userId}` : null;
}

function signature(userId: string, version: DashboardUIPreference, expires: number) {
  const secret = getNextAuthSecret();
  if (!secret) throw new Error("Dashboard UI preference signing is unavailable");
  return createHmac("sha256", secret).update(`dashboard-ui:v1:${userId}:${version}:${expires}`).digest();
}

export function createDashboardUIPreferenceCookie(userId: string, version: DashboardUIPreference, now = Date.now()) {
  const name = dashboardUIPreferenceCookieName(userId);
  if (!name || (version !== "legacy" && version !== "preview")) throw new Error("Invalid dashboard UI preference");
  const expires = Math.floor(now / 1000) + DASHBOARD_UI_PREFERENCE_MAX_AGE;
  return { name, value: `v1.${version}.${expires}.${signature(userId, version, expires).toString("hex")}` };
}

export function readDashboardUIPreference(userId: string, cookie: string | undefined, now = Date.now()): DashboardUIPreference | null {
  if (!dashboardUIPreferenceCookieName(userId) || !cookie || cookie.length > 120) return null;
  const match = /^v1\.(legacy|preview)\.(\d{10,11})\.([a-f0-9]{64})$/.exec(cookie);
  if (!match) return null;
  const version = match[1] as DashboardUIPreference;
  const expires = Number(match[2]);
  const seconds = Math.floor(now / 1000);
  if (expires <= seconds || expires > seconds + DASHBOARD_UI_PREFERENCE_MAX_AGE + 60) return null;
  try {
    return timingSafeEqual(Buffer.from(match[3], "hex"), signature(userId, version, expires)) ? version : null;
  } catch {
    return null;
  }
}
