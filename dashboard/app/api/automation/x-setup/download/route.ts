import { ApiError, json, requireSession } from "@/lib/api";
import { readXSetupDownload, X_SETUP_DOWNLOAD } from "@/lib/x-setup-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};

function unavailable(status: number, message: string) {
  const response = json({ error: message, code: status === 401 ? "AUTH_REQUIRED" : "X_SETUP_RELEASE_UNAVAILABLE" }, status);
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value);
  return response;
}

export async function GET() {
  try {
    await requireSession();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return unavailable(401, "ログインしてからダウンロードしてください。");
    return unavailable(503, "ログイン状態を確認できませんでした。時間をおいて再度お試しください。");
  }
  try {
    const archive = await readXSetupDownload();
    return new Response(new Uint8Array(archive), {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/zip",
        "Content-Length": String(archive.byteLength),
        "Content-Disposition": `attachment; filename="${X_SETUP_DOWNLOAD.filename}"; filename*=UTF-8''${encodeURIComponent(X_SETUP_DOWNLOAD.filename)}`,
        "X-Checksum-Sha256": X_SETUP_DOWNLOAD.sha256,
      },
    });
  } catch {
    return unavailable(503, "X通知のセットアップファイルを現在提供できません。時間をおいて再度お試しください。");
  }
}
