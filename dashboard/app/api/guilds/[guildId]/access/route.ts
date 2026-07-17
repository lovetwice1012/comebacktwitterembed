import { NextRequest } from "next/server";
import { ApiError, errorResponse, json, requireGuildPermission } from "@/lib/api";
import {
  delegatedAccessEnabled,
  isDiscordSnowflake,
  listDelegatedAccess,
  replaceDelegatedAccess,
  type DelegatedAccessLevel,
  type DelegatedAccessTargetType,
} from "@/lib/delegated-access";
import { fetchGuildAccessDirectory, validateGuildAccessTargets } from "@/lib/discord";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";

type Params = { params: Promise<{ guildId: string }> };

const MAX_TARGETS_PER_WRITE = 100;

function parseWriteBody(value: unknown, guildId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "A JSON access update is required.");
  }
  const body = value as Record<string, unknown>;
  const targetType = body.targetType;
  const targetIds = body.targetIds;
  const accessLevel = body.accessLevel;
  if (targetType !== "user" && targetType !== "role") {
    throw new ApiError(400, "targetType must be user or role.");
  }
  if (!Array.isArray(targetIds) || targetIds.length === 0 || targetIds.length > MAX_TARGETS_PER_WRITE) {
    throw new ApiError(400, `targetIds must contain between 1 and ${MAX_TARGETS_PER_WRITE} Discord IDs.`);
  }
  if (!targetIds.every((id) => typeof id === "string" && isDiscordSnowflake(id))) {
    throw new ApiError(400, "targetIds must contain only valid Discord IDs.");
  }
  const uniqueTargetIds = [...new Set(targetIds)];
  if (targetType === "role" && uniqueTargetIds.includes(guildId)) {
    throw new ApiError(400, "The @everyone role cannot receive delegated access.");
  }
  if (accessLevel !== "view" && accessLevel !== "edit" && accessLevel !== null) {
    throw new ApiError(400, "accessLevel must be view, edit, or null to remove access.");
  }
  return {
    targetType: targetType as DelegatedAccessTargetType,
    targetIds: uniqueTargetIds,
    accessLevel: accessLevel as DelegatedAccessLevel | null,
  };
}

export async function GET(req: NextRequest, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const { guildId } = await params;
    if (!isDiscordSnowflake(guildId)) throw new ApiError(400, "Invalid guild ID.");
    // Delegated grants must only be managed by a member with Discord's native
    // Manage Server or Administrator permission; delegates can never manage grants.
    await requireGuildPermission(guildId, "manage", locale);
    if (!delegatedAccessEnabled()) {
      return json({ enabled: false, grants: [], members: [], roles: [], directoryError: null });
    }

    const query = req.nextUrl.searchParams.get("query") || "";
    const [grants, directory] = await Promise.all([
      listDelegatedAccess(guildId),
      fetchGuildAccessDirectory(guildId, query),
    ]);
    return json({ enabled: true, grants, ...directory });
  } catch (error) {
    return errorResponse(error, locale);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const { guildId } = await params;
    if (!isDiscordSnowflake(guildId)) throw new ApiError(400, "Invalid guild ID.");
    const { session } = await requireGuildPermission(guildId, "manage", locale);
    if (!delegatedAccessEnabled()) {
      throw new ApiError(409, "Delegated access is disabled.");
    }

    const input = parseWriteBody(await req.json().catch(() => null), guildId);
    if (!await validateGuildAccessTargets(guildId, input.targetType, input.targetIds)) {
      throw new ApiError(400, "Every selected user or role must currently belong to this server.");
    }
    await replaceDelegatedAccess({
      guildId,
      targetType: input.targetType,
      targetIds: input.targetIds,
      accessLevel: input.accessLevel || undefined,
      actorUserId: session.user.id,
    });
    return json({ enabled: true, grants: await listDelegatedAccess(guildId) });
  } catch (error) {
    return errorResponse(error, locale);
  }
}
