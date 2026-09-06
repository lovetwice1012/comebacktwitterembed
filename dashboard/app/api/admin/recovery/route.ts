import { NextResponse } from "next/server";
import { errorResponse, requireAdminSession } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store, max-age=0" };
const MAX_STATUS_BYTES = 1024 * 1024;

function unavailable(state: string, message: string, configured: boolean, status = 200) {
  return NextResponse.json({ configured, available: false, state, message, fetchedAt: new Date().toISOString() }, { status, headers });
}

function redact(value: unknown, token: string): unknown {
  if (typeof value === "string") return value.split(token).join("[credential omitted]");
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|cookie|set-cookie|password|secret|token|.*_token|.*_secret|private_?key|access_?key)$/i.test(key) ? "[credential omitted]" : redact(item, token)]));
  return value;
}

export async function GET() {
  try {
    await requireAdminSession();
    const configuredUrl = process.env.RECOVERY_CONTROLLER_URL;
    const token = process.env.RECOVERY_CONTROLLER_TOKEN;
    if (!configuredUrl || !token) return unavailable("not_configured", "緊急復旧コントローラーの接続設定が未設定です。", false);
    let endpoint: URL;
    try {
      const base = new URL(configuredUrl);
      if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || /[\r\n]/.test(token)) throw new Error("invalid configuration");
      endpoint = new URL("/v1/status", base);
    } catch { return unavailable("invalid_configuration", "緊急復旧コントローラーにはローカルHTTP接続先を設定してください。", false, 503); }
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000), cache: "no-store", redirect: "error" });
    } catch { return unavailable("unavailable", "緊急復旧コントローラーへ接続できません。他の管理操作は引き続き利用できます。", true, 503); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return unavailable("upstream_error", `緊急復旧コントローラーがHTTP ${response.status}を返しました。`, true, 503);
    }
    let value: Record<string, unknown>;
    try {
      if (Number(response.headers.get("content-length") || 0) > MAX_STATUS_BYTES) throw new Error("status too large");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing body");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_STATUS_BYTES) { await reader.cancel(); throw new Error("status too large"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || Array.isArray(value) || typeof value.phase !== "string") throw new Error("invalid status");
    } catch { await response.body?.cancel().catch(() => {}); return unavailable("invalid_response", "緊急復旧コントローラーの状態を読み取れません。最後の取得結果と現在の状態を区別してください。", true, 503); }
    const status = Object.fromEntries(["phase", "updatedAt", "backup", "candidate", "gates", "lastError", "primaryEnrolled", "activeNode", "epoch"].filter(key => key in value).map(key => [key, redact(value[key], token)]));
    return NextResponse.json({ ...status, configured: true, available: true, fetchedAt: new Date().toISOString() }, { headers });
  } catch (error) { return errorResponse(error); }
}
