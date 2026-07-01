import { NextRequest } from "next/server";
import { errorResponse, json, requestMeta, requireGuildPermission } from "@/lib/api";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";
import { syncGuildSettings } from "@/lib/settings-db";

export async function POST(req: NextRequest) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const body = await req.json().catch(() => ({}));
    const input = body as { sourceGuildId?: unknown; targetGuildId?: unknown; targetGuildIds?: unknown };
    const sourceGuildId = String(input.sourceGuildId || "");
    const rawTargetGuildIds = Array.isArray(input.targetGuildIds) ? input.targetGuildIds : [input.targetGuildId];
    const targetGuildIds: string[] = [
      ...new Set(
        rawTargetGuildIds
          .map((id: unknown) => String(id || "").trim())
          .filter((id: string) => id.length > 0 && id !== sourceGuildId),
      ),
    ];
    await requireGuildPermission(sourceGuildId, "view", locale);
    const permissions = await Promise.all(targetGuildIds.map((targetGuildId) => requireGuildPermission(targetGuildId, "manage", locale)));
    const actor = permissions[0]?.session.user || (await requireGuildPermission(sourceGuildId, "view", locale)).session.user;
    const meta = requestMeta(req);
    const results = [];
    for (const targetGuildId of targetGuildIds) {
      results.push(await syncGuildSettings(sourceGuildId, targetGuildId, actor, meta, locale));
    }
    return json({
      sourceGuildId,
      targetCount: results.length,
      results,
      providerCount: results[0]?.providerCount || 0,
      copied: results.reduce((sum, result) => sum + result.copied, 0),
      skippedTargets: results.reduce((sum, result) => sum + result.skippedTargets, 0),
    });
  } catch (error) {
    return errorResponse(error, locale);
  }
}
