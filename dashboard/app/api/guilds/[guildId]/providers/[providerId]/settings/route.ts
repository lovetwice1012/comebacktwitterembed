import { NextRequest } from "next/server";
import { errorResponse, json, requestMeta, requireGuildPermission } from "@/lib/api";
import { getProviderSettingsState, saveProviderSettings } from "@/lib/settings-db";
import { validateProviderChanges } from "@/lib/settings-validation";

type Params = { params: Promise<{ guildId: string; providerId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { guildId, providerId } = await params;
    await requireGuildPermission(guildId, "view");
    return json({ providerId, settings: await getProviderSettingsState(providerId, guildId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { guildId, providerId } = await params;
    const { session, access } = await requireGuildPermission(guildId, "edit");
    const body = await req.json();
    const preflight = validateProviderChanges(providerId, body);
    if (preflight.dangerous && !access.canManageGuild) {
      return json({
        error: "Dangerous settings require Manage Server or Administrator",
        details: {
          required: "Manage Server or Administrator",
          current: access.permissions,
        },
      }, 403);
    }
    const result = await saveProviderSettings(guildId, providerId, body, {
      id: session.user.id,
      username: session.user.globalName || session.user.username,
    }, requestMeta(req));
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
