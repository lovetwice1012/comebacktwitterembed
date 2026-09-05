export type LogCursor = { time: string | number; id: string } | "done";
export type LogSearch = { guildId?: string | null; providerId?: string | null; actorUserId?: string | null; action?: string | null; from?: string | null; to?: string | null; cursor?: string | null; limit?: string | number | null };

export function decodeLogCursor(value?: string | null): { audit?: LogCursor; errors?: LogCursor } {
  if (!value) return {};
  if (value.length > 4096) throw new Error("Invalid log cursor");
  try {
    const result = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    for (const key of ["audit", "errors"]) {
      const item = result[key];
      if (item == null || item === "done") continue;
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || !Number.isFinite(new Date(item.time).getTime())) throw new Error();
    }
    return result;
  } catch { throw new Error("Invalid log cursor"); }
}

export function logConditions(kind: "audit" | "errors", filters: LogSearch, cursor?: LogCursor) {
  const clauses: string[] = []; const params: unknown[] = [];
  const audit = kind === "audit"; const time = audit ? "created_at" : "occurred_at_ms"; const id = audit ? "audit_log_id" : "error_event_id";
  for (const [column, value] of [["guild_id", filters.guildId], ["provider_id", filters.providerId], ...(audit ? [["actor_user_id", filters.actorUserId], ["action", filters.action]] : [["author_user_id", filters.actorUserId]])]) {
    if (value) { clauses.push(`${column} = ?`); params.push(value); }
  }
  const start = filters.from ? Date.parse(filters.from) : null; const end = filters.to ? Date.parse(filters.to) : null;
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end)) || (start !== null && end !== null && start >= end)) throw new Error("Invalid log time range");
  if (start !== null) { clauses.push(`${time} >= ?`); params.push(audit ? new Date(start) : start); }
  if (end !== null) { clauses.push(`${time} < ?`); params.push(audit ? new Date(end) : end); }
  if (cursor && cursor !== "done") { const t = audit ? new Date(cursor.time) : Number(cursor.time); clauses.push(`(${time} < ? OR (${time} = ? AND ${id} < ?))`); params.push(t, t, cursor.id); }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", order: `ORDER BY ${time} DESC, ${id} DESC`, params };
}
