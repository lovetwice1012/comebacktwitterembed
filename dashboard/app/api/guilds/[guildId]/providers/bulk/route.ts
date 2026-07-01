import { NextRequest } from "next/server";
import { errorResponse, json, requestMeta, requireGuildPermission } from "@/lib/api";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";
import { saveBulkProviderSettings } from "@/lib/settings-db";

type Params = { params: Promise<{ guildId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const { guildId } = await params;
    const { session } = await requireGuildPermission(guildId, "manage", locale);
    const result = await saveBulkProviderSettings(guildId, await req.json(), {
      id: session.user.id,
      username: session.user.globalName || session.user.username,
    }, requestMeta(req), locale);
    return json(result);
  } catch (error) {
    return errorResponse(error, locale);
  }
}
