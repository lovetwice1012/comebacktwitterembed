import { errorResponse, json, requireGuildPermission } from "@/lib/api";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";
import { getCrossProviderSettings } from "@/lib/settings-db";

type Params = { params: Promise<{ guildId: string }> };

export async function GET(req: Request, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const { guildId } = await params;
    const { access } = await requireGuildPermission(guildId, "view", locale);
    return json({
      guildId,
      guildName: access.name,
      canManageGuild: access.canManageGuild,
      items: await getCrossProviderSettings(guildId, locale),
    });
  } catch (error) {
    return errorResponse(error, locale);
  }
}
