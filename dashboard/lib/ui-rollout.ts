import "server-only";

import { cookies } from "next/headers";
import { readRootConfig } from "@/lib/env";
import type { DashboardSession } from "@/lib/types";
import { dashboardUIPreferenceCookieName, readDashboardUIPreference } from "@/lib/ui-preference";

export const DEFAULT_DASHBOARD_UI_PREVIEW_USER_ID = "796972193287503913";

function normalizePreviewIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  return [...new Set(values.filter((id): id is string => typeof id === "string").map(id => id.trim()).filter(id => /^\d{16,24}$/.test(id)))];
}

export function getDashboardUIPreviewUserIds() {
  // This list supplies the pilot's default. Other authenticated users can opt
  // in, and an explicit account preference also lets pilot users return to old UI.
  if (process.env.DASHBOARD_UI_PREVIEW_USER_IDS !== undefined) return normalizePreviewIds(process.env.DASHBOARD_UI_PREVIEW_USER_IDS);
  const dashboard = readRootConfig().dashboard;
  if (dashboard && Object.hasOwn(dashboard, "uiPreviewUserIds")) return normalizePreviewIds(dashboard.uiPreviewUserIds);
  return [DEFAULT_DASHBOARD_UI_PREVIEW_USER_ID];
}

/** Call only with the session verified by requireDashboardSession/getDashboardSession. */
export async function usesNewDashboardUI(session: Pick<DashboardSession, "user"> | null | undefined) {
  const id = session?.user?.id;
  if (typeof id !== "string") return false;
  const cookieName = dashboardUIPreferenceCookieName(id);
  if (!cookieName) return false;
  const cookieStore = await cookies();
  const preference = readDashboardUIPreference(id, cookieStore.get(cookieName)?.value);
  return preference ? preference === "preview" : getDashboardUIPreviewUserIds().includes(id);
}
