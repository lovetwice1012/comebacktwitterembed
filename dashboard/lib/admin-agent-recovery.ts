import { createConnection } from "node:net";

type RecoveryType = "agent.status" | "agent.restart";
export type RecoveryRequest = { id: string; type: RecoveryType; input: { expectedInvocationId?: string } };
export type RecoveryReply = { ok: boolean; data?: { data?: Record<string, unknown>; error?: unknown }; error?: string };

export function validateRecoveryRequest(value: unknown, ownerId: string): RecoveryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("復旧操作の入力が不正です。");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["type", "input", "idempotencyKey"].includes(key))) throw new Error("復旧操作は固定された管理デーモンだけを対象とします。");
  if (body.type !== "agent.status" && body.type !== "agent.restart") throw new Error("対応する操作は管理デーモンの状態確認と再起動のみです。");
  if (typeof body.idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.idempotencyKey)) throw new Error("操作の受付キーが必要です。");
  if (!/^\d{5,32}$/.test(ownerId)) throw new Error("管理者IDが未設定です。");
  const input = body.input ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "expectedInvocationId")) throw new Error("管理デーモンの起動ID以外は指定できません。");
  const invocationId = (input as Record<string, unknown>).expectedInvocationId;
  if (body.type === "agent.status" && invocationId !== undefined) throw new Error("状態確認に起動IDを指定しないでください。");
  if (body.type === "agent.restart" && (typeof invocationId !== "string" || !/^[0-9a-f]{32}$/i.test(invocationId))) throw new Error("先に管理デーモンの状態を取得し、確認した起動IDを指定してください。");
  return { id: `dashboard-recovery:${ownerId}:${body.idempotencyKey}`, type: body.type, input: body.type === "agent.restart" ? { expectedInvocationId: invocationId as string } : {} };
}

/** Independent executor keeps a durable receipt. A lost connection never causes a new request ID. */
export function requestAgentRecovery(request: RecoveryRequest, socketPath = process.env.ADMIN_AGENT_EXECUTOR_SOCKET || "/run/cbte-admin-executor/executor.sock", timeoutMs = 45000): Promise<RecoveryReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let complete = false;
    let received = "";
    let bytes = 0;
    const finish = (error?: Error, reply?: RecoveryReply) => {
      if (complete) return;
      complete = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error) reject(error); else resolve(reply!);
    };
    const deadline = setTimeout(() => finish(new Error("独立executorの応答期限を超えました。操作の成否は不明です。同じ受付キーで結果を確認してください。")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return finish(new Error("独立executorの応答が上限を超えました。同じ受付キーで結果を確認してください。"));
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(received.slice(0, newline));
        if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") throw new Error("invalid response");
        finish(undefined, reply);
      } catch { finish(new Error("独立executorの応答を読み取れません。同じ受付キーで結果を確認してください。")); }
    });
    socket.once("error", error => finish(new Error(`独立executorに接続できません: ${error.message}。送信済みの場合は同じ受付キーで結果を確認してください。`)));
    socket.once("close", () => { if (!complete) finish(new Error("独立executorへの接続が応答前に閉じられました。同じ受付キーで結果を確認してください。")); });
  });
}
