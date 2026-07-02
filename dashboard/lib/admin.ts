import "server-only";

import { readRootConfig } from "@/lib/env";
import type { DashboardSession } from "@/lib/types";

const DEFAULT_ADMIN_USER_IDS = ["796972193287503913"];

function normalizeUserIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(normalizeUserIds);
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => /^\d{5,32}$/.test(item));
}

export function getDashboardAdminUserIds() {
  const envIds = normalizeUserIds(process.env.DASHBOARD_ADMIN_USER_IDS);
  const configIds = normalizeUserIds(readRootConfig().dashboard?.adminUserIds);
  return [...new Set([...DEFAULT_ADMIN_USER_IDS, ...configIds, ...envIds])];
}

export function isDashboardAdminUserId(userId: string | null | undefined) {
  if (!userId) return false;
  return getDashboardAdminUserIds().includes(userId);
}

export function isDashboardAdminSession(session: Pick<DashboardSession, "user"> | null | undefined) {
  return isDashboardAdminUserId(session?.user.id);
}
