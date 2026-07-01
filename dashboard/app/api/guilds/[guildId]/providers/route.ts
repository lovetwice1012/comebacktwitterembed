import { errorResponse, json, requireGuildPermission } from "@/lib/api";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";
import { getProvidersOverview } from "@/lib/settings-db";

type Params = { params: Promise<{ guildId: string }> };

export async function GET(req: Request, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const { guildId } = await params;
    await requireGuildPermission(guildId, "view", locale);
    return json(await getProvidersOverview(guildId, locale));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
