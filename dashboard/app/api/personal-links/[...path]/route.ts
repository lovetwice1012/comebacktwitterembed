import { NextRequest } from "next/server";
import { ApiError, json, requireSession } from "@/lib/api";
import { getDashboardLocaleFromRequest } from "@/lib/server-locale";
import { dispatchPersonalLinks, personalLinkError, personalLinkServices } from "@/lib/personal-links-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ path: string[] }> };
async function readBody(req: NextRequest) {
  if (!req.headers.get("content-type")?.startsWith("application/json")) throw new ApiError(415, "JSON形式で送信してください。");
  const reader = req.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new ApiError(408, "入力の受信がタイムアウトしました。")); }, 10000); });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new ApiError(413, "入力が大きすぎます。"); }
      chunks.push(result.value);
    }
    try { return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
    catch { throw new ApiError(400, "入力の形式が不正です。"); }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
async function handle(req: NextRequest, { params }: Params) {
  const locale = getDashboardLocaleFromRequest(req);
  try {
    const session = await requireSession(locale);
    if (req.method !== "GET" && req.headers.get("origin") !== new URL(process.env.NEXTAUTH_URL || req.url).origin) throw new ApiError(403, "同じサイトから操作してください。");
    const { path } = await params;
    const body = req.method === "GET" ? undefined : await readBody(req);
    const result = await dispatchPersonalLinks({ method: req.method, path, search: req.nextUrl.searchParams, body }, session.user.id, locale, personalLinkServices());
    const response = json(result); response.headers.set("Cache-Control", "private, no-store"); return response;
  } catch (error) {
    const failure = error instanceof ApiError ? { message: error.message, status: error.status } : personalLinkError(error, locale);
    const response = json({ error: failure.message }, failure.status);
    response.headers.set("Cache-Control", "private, no-store");
    if (failure.status === 429) response.headers.set("Retry-After", "30");
    return response;
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
