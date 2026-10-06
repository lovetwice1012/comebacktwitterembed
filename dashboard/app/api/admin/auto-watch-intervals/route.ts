import { NextRequest } from "next/server";
import { json, requireAdminSession } from "@/lib/api";
import { requireBotModule } from "@/lib/bot-require";

export const dynamic = "force-dynamic";
const response = (value: unknown, status = 200) => { const out = json(value, status); out.headers.set("Cache-Control", "private, no-store"); return out; };
function service() {
  return requireBotModule<any>("src/providers/autoWatch/intervalPolicy.js").createPolicy();
}
function failure(error: unknown) {
  const value = error as { status?: number; code?: string; message?: string };
  if (value?.code === "AUTO_WATCH_INVALID_INTERVAL") return response({ error: value.message }, 400);
  if (value?.status === 401 || value?.status === 403) return response({ error: "管理者権限でログインしてください。" }, value.status);
  return response({ error: "自動展開の間隔設定を読み書きできませんでした。時間をおいて再試行してください。" }, 500);
}
export async function GET(req: NextRequest) {
  try {
    await requireAdminSession();
    return response(await service().get(req.nextUrl.searchParams.get("userId")));
  } catch (error) { return failure(error); }
}
export async function PATCH(req: NextRequest) {
  try {
    const session = await requireAdminSession();
    const origin = req.headers.get("origin");
    let sameOrigin = false;
    try { sameOrigin = !!origin && new URL(origin).origin === new URL(process.env.NEXTAUTH_URL || req.url).origin; } catch { /* Invalid origins are rejected too. */ }
    if (!sameOrigin) return response({ error: "管理画面から操作してください。" }, 403);
    if (!req.headers.get("content-type")?.startsWith("application/json")) return response({ error: "JSON形式で指定してください。" }, 415);
    const raw = await req.text();
    if (raw.length > 4096) return response({ error: "入力が長すぎます。" }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return response({ error: "入力形式を確認してください。" }, 400); }
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some(key => !["userId", "intervalMinutes"].includes(key))) return response({ error: "設定項目を確認してください。" }, 400);
    return response(await service().set(body.userId, body.intervalMinutes, session.user.id));
  } catch (error) { return failure(error); }
}
