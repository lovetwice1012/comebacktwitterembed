import { ApiError, json, requireSession } from "@/lib/api";
import { automationServices } from "@/lib/automation-server";
import { readChromeSetupDownload, X_CHROME_SETUP_DOWNLOAD } from "@/lib/x-chrome-setup-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Expires: "0",
  Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
function unavailable(status: number, code: string, message: string) {
  const response = json({ error: message, code }, status);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
export async function GET() {
  let session;
  try { session = await requireSession(); }
  catch (error) {
    return error instanceof ApiError && error.status === 401
      ? unavailable(401, "AUTH_REQUIRED", "ログインしてからダウンロードしてください。")
      : unavailable(503, "X_SETUP_RELEASE_UNAVAILABLE", "ログイン状態を確認できませんでした。");
  }
  if (process.env.X_NOTIFICATION_CHROME_ENABLED !== "1") return unavailable(503, "X_SETUP_CHROME_NOT_READY", "Chromeの接続は準備中です。");
  try {
    const services = automationServices();
    const status = await services.api.dispatch({ method: "GET", path: ["x-setup"], search: new URLSearchParams(), body: {} },
      { userId: session.user.id, isAdmin: session.user.isAdmin === true }, services);
    if (status?.receiverEnabled !== true || status?.chromeEnabled !== true || status?.rollout?.eligible !== true
        || !["supporters", "public"].includes(status?.rollout?.mode)) {
      const reason = status?.rollout?.reasonCode;
      const code = reason === "X_ROLLOUT_SUPPORTERS_ONLY" || reason === "X_ROLLOUT_DISABLED" ? reason : "X_SETUP_CHROME_NOT_READY";
      return unavailable(code === "X_ROLLOUT_SUPPORTERS_ONLY" ? 403 : 503, code,
        code === "X_ROLLOUT_SUPPORTERS_ONLY" ? "Chrome用ツールは支援者の方に提供しています。" : "Chrome用ツールは準備中です。");
    }
    const archive = await readChromeSetupDownload();
    return new Response(new Uint8Array(archive), { status: 200, headers: { ...headers, "Content-Type": "application/zip",
      "Content-Length": String(archive.byteLength), "Content-Disposition": `attachment; filename="${X_CHROME_SETUP_DOWNLOAD.filename}"`,
      "X-Checksum-Sha256": X_CHROME_SETUP_DOWNLOAD.sha256 } });
  } catch { return unavailable(503, "X_SETUP_RELEASE_UNAVAILABLE", "Chrome用の保存ツールを現在提供できません。"); }
}
