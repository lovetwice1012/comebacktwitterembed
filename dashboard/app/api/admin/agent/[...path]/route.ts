import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession, errorResponse, ApiError } from "@/lib/api";
import { adminAgentEndpoint, independentAdminUrl } from "@/lib/admin-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ROOTS = new Set(["health", "catalog", "actions", "runs", "events", "metrics", "incidents", "policies", "notifications", "evidence", "account"]);

async function proxy(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  try {
    const session = await requireAdminSession();
    const { path } = await context.params;
    if (!path.length || !ROOTS.has(path[0]) || path.some(part => !/^[A-Za-z0-9_.:-]+$/.test(part) || part === ".." || part === ".")) throw new ApiError(404, "Unknown management endpoint");
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      const expected = new URL(process.env.NEXTAUTH_URL || req.url).origin;
      if (!origin || (origin !== expected && origin !== req.nextUrl.origin)) throw new ApiError(403, "Same-origin request required");
      if ((req.method !== "POST" || !["actions", "account/password"].includes(path.join("/"))) && (req.method !== "PUT" || path.join("/") !== "policies")) throw new ApiError(405, "Unsupported management operation");
      if (!req.headers.get("content-type")?.startsWith("application/json")) throw new ApiError(415, "JSON required");
    }
    const token = process.env.ADMIN_AGENT_TOKEN;
    if (!token) return NextResponse.json({ error: "管理デーモンの接続トークンが未設定です。", state: "unconfigured", independentUrl: independentAdminUrl() }, { status: 503 });
    const endpoint = adminAgentEndpoint(path.join("/"));
    endpoint.search = req.nextUrl.search;
    let body: string | undefined;
    if (req.method !== "GET") {
      body = await req.text();
      if (Buffer.byteLength(body) > 24 * 1024 * 1024) throw new ApiError(413, "操作入力は24 MiB以下にしてください");
      JSON.parse(body);
    }
    let response: Response;
    try {
      response = await fetch(endpoint, { method: req.method, headers: { authorization: `Bearer ${token}`, "x-admin-actor": session.user.id, "content-type": "application/json" }, body, cache: "no-store", signal: AbortSignal.timeout(15000), redirect: "error" });
    } catch (error) {
      return NextResponse.json({ error: "管理デーモンに接続できません。処理が受付済みの場合は履歴で結果を確認してください。", state: "unavailable", detail: error instanceof Error ? error.message : String(error), independentUrl: independentAdminUrl() }, { status: 503 });
    }
    const data = await response.json();
    if (path[0] === "health") data.independentUrl = independentAdminUrl();
    return NextResponse.json(data, { status: response.status, headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
