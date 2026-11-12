import { ApiError, json, requireSession } from "@/lib/api";
import { automationServices } from "@/lib/automation-server";
import { getMacChromeRelease, readMacChromeSetupDownload, type MacChromeArch } from "@/lib/x-chrome-mac-setup-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Expires: "0",
  Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
function unavailable(status: number, code: string, message: string) {
  const response = json({ error: message, code }, status);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
export async function GET(request: Request) {
  let session;
  try { session = await requireSession(); }
  catch (error) {
    return error instanceof ApiError && error.status === 401
      ? unavailable(401, "AUTH_REQUIRED", "ログインしてからダウンロードしてください。")
      : unavailable(503, "X_SETUP_RELEASE_UNAVAILABLE", "ログイン状態を確認できませんでした。");
  }
  const url = new URL(request.url), values = url.searchParams.getAll("arch");
  if (values.length !== 1 || !["arm64", "x64"].includes(values[0]) || [...url.searchParams.keys()].some(key => key !== "arch"))
    return unavailable(400, "X_SETUP_ARCH_INVALID", "Macの種類を選んでください。");
  if (process.env.X_NOTIFICATION_CHROME_ENABLED !== "1" || process.env.X_NOTIFICATION_CHROME_MAC_ENABLED !== "1")
    return unavailable(503, "X_SETUP_CHROME_MAC_NOT_READY", "Mac用ツールは準備中です。");
  const arch = values[0] as MacChromeArch, release = getMacChromeRelease(arch);
  if (!release) return unavailable(503, "X_SETUP_RELEASE_UNAVAILABLE", "Mac用ツールは準備中です。");
  try {
    const services = automationServices();
    const status = await services.api.dispatch({ method: "GET", path: ["x-setup"], search: new URLSearchParams(), body: {} },
      { userId: session.user.id, isAdmin: session.user.isAdmin === true }, services);
    if (status?.receiverEnabled !== true || status?.chromeEnabled !== true || status?.chromeMacDownloads?.[arch] !== true
        || status?.rollout?.eligible !== true || !["supporters", "public"].includes(status?.rollout?.mode)) {
      const reason = status?.rollout?.reasonCode;
      const code = reason === "X_ROLLOUT_SUPPORTERS_ONLY" || reason === "X_ROLLOUT_DISABLED" ? reason : "X_SETUP_CHROME_MAC_NOT_READY";
      return unavailable(code === "X_ROLLOUT_SUPPORTERS_ONLY" ? 403 : 503, code, "Mac用ツールは現在利用できません。");
    }
    const archive = await readMacChromeSetupDownload(arch);
    return new Response(new Uint8Array(archive), { status: 200, headers: { ...headers, "Content-Type": "application/zip",
      "Content-Length": String(archive.byteLength), "Content-Disposition": `attachment; filename="${release.filename}"`,
      "X-Checksum-Sha256": release.sha256 } });
  } catch { return unavailable(503, "X_SETUP_RELEASE_UNAVAILABLE", "Mac用ツールを現在提供できません。"); }
}
