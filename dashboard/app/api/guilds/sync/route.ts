import { NextRequest } from "next/server";
import { errorResponse, json, requestMeta, requireGuildPermission } from "@/lib/api";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";
import { syncGuildSettings } from "@/lib/settings-db";

export async function POST(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const body = await req.json().catch(() => ({}));
    const sourceGuildId = String(body.sourceGuildId || "");
    const targetGuildId = String(body.targetGuildId || "");
    await requireGuildPermission(sourceGuildId, "view", locale);
    const { session } = await requireGuildPermission(targetGuildId, "manage", locale);
    return json(await syncGuildSettings(sourceGuildId, targetGuildId, session.user, requestMeta(req), locale));
  } catch (error) {
    return errorResponse(error, locale);
  }
}
