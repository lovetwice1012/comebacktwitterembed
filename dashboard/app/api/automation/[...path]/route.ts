import { NextRequest } from "next/server";
import { ApiError, json, requireSession } from "@/lib/api";
import { getGuildAccess } from "@/lib/discord";
import { automationServices } from "@/lib/automation-server";
import { AdmissionError, bodyLimit, reserveAdmission } from "@/lib/automation-admission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ path: string[] }> };

async function readBody(req: NextRequest, maxBody: number) {
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new ApiError(408, "入力の受信がタイムアウトしました。")); void reader.cancel().catch(() => {}); }, maxBody > 2 * 1024 * 1024 ? 60000 : 15000); });
  try {
  while (true) {
    const { done, value } = await Promise.race([reader.read(), deadline]);
    if (done) break;
    size += value.byteLength;
    if (size > maxBody) { await reader.cancel(); throw new ApiError(413, "入力が大きすぎます。辞書パックを分割してください。"); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "JSONの構文が不正です。"); }
  } finally { clearTimeout(timer!); reader.releaseLock(); }
}
async function handle(req: NextRequest, { params }: Params) {
  let release: (() => void) | undefined;
  try {
    const mutation = req.method !== "GET";
    if (mutation) {
      const origin = req.headers.get("origin");
      const expected = new URL(process.env.NEXTAUTH_URL || req.url).origin;
      if (origin !== expected) throw new ApiError(403, "同じサイトから操作してください。");
    }
    const session = await requireSession();
    const guildId = req.nextUrl.searchParams.get("guildId") || undefined;
    if (guildId && !/^\d{16,22}$/.test(guildId)) throw new ApiError(400, "サーバーIDが不正です。");
    const access = guildId ? await getGuildAccess(session, guildId) : null;
    const actor = { userId: session.user.id, guildId, canView: access?.canView === true, canEdit: access?.canEdit === true, isAdmin: session.user.isAdmin === true };
    const { path } = await params;
    if (path.length > 3) throw new ApiError(404, "ページが見つかりません。");
    const maxBody = mutation ? bodyLimit(`/${path.join("/")}`) : 0;
    const claimedLength = req.headers.get("content-length");
    if (claimedLength !== null && (!/^\d+$/.test(claimedLength) || Number(claimedLength) > maxBody)) throw new ApiError(413, "入力が大きすぎます。");
    release = reserveAdmission(actor.userId, maxBody);
    const body = mutation ? await readBody(req, maxBody) : {};
    const services = automationServices();
    const result = await services.api.dispatch({ method: req.method, path, search: req.nextUrl.searchParams, body }, actor, services);
    const response = json(result);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error: any) {
    const dictionaryError = /^DICTIONARY_[A-Z_]+$/.test(String(error.code || error.message || ""));
    const known = error instanceof ApiError || error instanceof AdmissionError || error.name === "AutomationError" || ["AUTOMATION_RULE_INVALID", "AUTOMATION_TEXT_LIMIT"].includes(error.code) || dictionaryError;
    const response = json({ error: known ? error.message : "操作に失敗しました。設定とサービスの状態を確認してください。", code: known ? error.code || null : "AUTOMATION_REQUEST_FAILED", issues: known ? error.issues : undefined }, known ? error.status || 400 : 500);
    if (error instanceof AdmissionError) response.headers.set("Retry-After", "60");
    return response;
  } finally { release?.(); }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
