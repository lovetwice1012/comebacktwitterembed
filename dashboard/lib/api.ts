import "server-only";

import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/features/auth/options";
import { getGuildAccess } from "@/lib/discord";
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

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return json({ error: error.message, details: error.details || null }, error.status);
  }
  const message = error instanceof Error ? error.message : "Internal Server Error";
  return json({ error: message }, 500);
}

export async function requireSession(): Promise<DashboardSession> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.accessToken) throw new ApiError(401, "Login required");
  return {
    user: {
      id: session.user.id,
      username: session.user.username || session.user.name || "",
      globalName: session.user.globalName,
      avatarUrl: session.user.avatarUrl,
    },
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
  };
}

export async function requireGuildPermission(
  guildId: string,
  mode: "view" | "edit" | "manage" | "media",
) {
  const session = await requireSession();
  const access = await getGuildAccess(session, guildId);
  if (!access) {
    throw new ApiError(403, "You do not have dashboard access for this guild", {
      required: permissionRequirementText(mode),
      current: null,
      adminHelp: "Ask a server administrator to grant Manage Channels, Manage Server, or Administrator and confirm the bot is installed.",
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
    throw new ApiError(403, "Insufficient Discord permissions", {
      required: permissionRequirementText(mode),
      current: access.permissions,
      adminHelp: "The dashboard disables unsafe operations unless the Discord permission is present and the API verifies it again.",
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
