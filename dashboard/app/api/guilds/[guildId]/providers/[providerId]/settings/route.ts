import { NextRequest } from "next/server";
import { errorResponse, json, requestMeta, requireGuildPermission } from "@/lib/api";
import { createTranslator } from "@/lib/i18n";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";
import { getProviderSettingsState, saveProviderSettings } from "@/lib/settings-db";
import { validateProviderChanges } from "@/lib/settings-validation";

type Params = { params: Promise<{ guildId: string; providerId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const { guildId, providerId } = await params;
    await requireGuildPermission(guildId, "view", locale);
    return json({ providerId, settings: await getProviderSettingsState(providerId, guildId, locale) });
  } catch (error) {
    return errorResponse(error, locale);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  const t = createTranslator(locale);
  try {
    const { guildId, providerId } = await params;
    const { session, access } = await requireGuildPermission(guildId, "edit", locale);
    const body = await req.json();
    const preflight = validateProviderChanges(providerId, body, locale);
    if (preflight.dangerous && !access.canManageGuild) {
      return json({
        error: t("api.dangerousRequiresManage"),
        details: {
          required: "Manage Server or Administrator",
          current: access.permissions,
        },
      }, 403);
    }
    const result = await saveProviderSettings(guildId, providerId, body, {
      id: session.user.id,
      username: session.user.globalName || session.user.username,
    }, requestMeta(req), locale);
    return json(result);
  } catch (error) {
    return errorResponse(error, locale);
  }
}
