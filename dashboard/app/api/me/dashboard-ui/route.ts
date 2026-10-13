import { NextResponse } from "next/server";
import { ApiError, requireSession } from "@/lib/api";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";
import { createDashboardUIPreferenceCookie, DASHBOARD_UI_PREFERENCE_MAX_AGE } from "@/lib/ui-preference";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const locale = getDashboardLocaleFromRequest(req);
  const ja = locale === "ja";
  try {
    const session = await requireSession(locale);
    const canonicalOrigin = new URL(process.env.NEXTAUTH_URL || req.url).origin;
    if (req.headers.get("origin") !== canonicalOrigin) throw new ApiError(403, ja ? "同じサイトから操作してください。" : "Use this control from the dashboard site.");
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new ApiError(415, ja ? "JSON形式で送信してください。" : "Send JSON data.");
    const contentLength = Number(req.headers.get("content-length"));
    if (contentLength > 1024) throw new ApiError(413, ja ? "入力が大きすぎます。" : "The request is too large.");
    const raw = await req.text();
    if (Buffer.byteLength(raw) > 1024) throw new ApiError(413, ja ? "入力が大きすぎます。" : "The request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw); }
    catch { throw new ApiError(400, ja ? "入力の形式が不正です。" : "Invalid request data."); }
    const version = body && typeof body === "object" && !Array.isArray(body) ? (body as { version?: unknown }).version : null;
    if (version !== "legacy" && version !== "preview") throw new ApiError(400, ja ? "切り替える画面を選んでください。" : "Choose a dashboard version.");

    // The account comes exclusively from the verified session. A preference
    // never grants dashboard, guild or administrator access.
    const cookie = createDashboardUIPreferenceCookie(session.user.id, version);
    const response = NextResponse.json({ version });
    response.cookies.set(cookie.name, cookie.value, { httpOnly: true, secure: canonicalOrigin.startsWith("https:"), sameSite: "lax", path: "/", maxAge: DASHBOARD_UI_PREFERENCE_MAX_AGE });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 503;
    const message = error instanceof ApiError ? error.message : ja ? "画面の切り替えを保存できませんでした。もう一度お試しください。" : "Could not save the dashboard version. Please try again.";
    const response = NextResponse.json({ error: message }, { status });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
