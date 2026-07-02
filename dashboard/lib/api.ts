import "server-only";

import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/features/auth/options";
import { isDashboardAdminUserId } from "@/lib/admin";
import { getGuildAccess } from "@/lib/discord";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";
import { permissionRequirementText } from "@/lib/permissions";
import type { DashboardSession } from "@/lib/types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function errorResponse(error: unknown, locale: DashboardLocale = "ja") {
  const t = createTranslator(locale);
  if (error instanceof ApiError) {
    return json({ error: error.message, details: error.details || null }, error.status);
  }
  const message = error instanceof Error ? error.message : t("api.internalServerError");
  return json({ error: message }, 500);
}

export async function requireSession(locale: DashboardLocale = "ja"): Promise<DashboardSession> {
  const t = createTranslator(locale);
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.accessToken) throw new ApiError(401, t("api.loginRequired"));
  return {
    user: {
      id: session.user.id,
      username: session.user.username || session.user.name || "",
      globalName: session.user.globalName,
      avatarUrl: session.user.avatarUrl,
      isAdmin: isDashboardAdminUserId(session.user.id),
    },
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
  };
}

export async function requireAdminSession(locale: DashboardLocale = "ja"): Promise<DashboardSession> {
  const t = createTranslator(locale);
  const session = await requireSession(locale);
  if (!session.user.isAdmin) {
    throw new ApiError(403, t("api.insufficientPermissions"), {
      required: "Dashboard administrator",
      current: { userId: session.user.id },
    });
  }
  return session;
}

export async function requireGuildPermission(
  guildId: string,
  mode: "view" | "edit" | "manage" | "media",
  locale: DashboardLocale = "ja",
) {
  const t = createTranslator(locale);
  const session = await requireSession(locale);
  const access = await getGuildAccess(session, guildId);
  if (!access) {
    throw new ApiError(403, t("api.noGuildAccess"), {
      required: permissionRequirementText(mode),
      current: null,
      adminHelp: t("api.noGuildAccessHelp"),
    });
  }

  const allowed =
    mode === "view"
      ? access.canView
      : mode === "edit"
        ? access.canEdit
        : mode === "manage"
          ? access.canManageGuild
          : access.permissions.administrator;

  if (!allowed) {
    throw new ApiError(403, t("api.insufficientPermissions"), {
      required: permissionRequirementText(mode),
      current: access.permissions,
      adminHelp: t("api.insufficientPermissionsHelp"),
    });
  }

  return { session, access };
}

export function requestMeta(req: NextRequest) {
  return {
    requestId: req.headers.get("x-request-id") || randomUUID(),
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip"),
    userAgent: req.headers.get("user-agent"),
  };
}
