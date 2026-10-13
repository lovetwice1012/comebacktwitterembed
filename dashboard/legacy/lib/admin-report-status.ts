export type AdminReportCache = {
  ready?: boolean;
  refreshing?: boolean;
  lastError?: unknown;
  lastErrorDetails?: unknown;
  updatedAt?: string | null;
  failedAt?: string | null;
  actionId?: string | null;
};

export function reportErrorMessage(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (typeof value !== "object") return String(value);
  const row = value as Record<string, unknown>;
  const code = typeof row.code === "string" ? row.code : "";
  const message = typeof row.message === "string" ? row.message : typeof row.error === "string" ? row.error : "";
  if (message) return code ? `${code}: ${message}` : message;
  if (["WORKER_UNCONFIGURED", "REPORT_WORKER_UNCONFIGURED"].includes(code)) return `${code}: 独立レポートworkerが設定されていないため、レポートを生成できません。`;
  return code ? `${code}: レポート処理に失敗しました。詳細を確認してください。` : "レポート処理に失敗しました。エラーの詳細を確認してください。";
}

export function reportDisplayStatus(cache: AdminReportCache) {
  const error = reportErrorMessage(cache.lastError);
  if (cache.ready && error) return { state: "stale", title: "レポートの更新に失敗しました", message: "前回完成したレポートを表示しています。", error };
  if (cache.ready && cache.refreshing) return { state: "refreshing", title: "レポートを更新中です", message: "前回完成したレポートを表示しています。更新が完了すると置き換わります。", error: null };
  if (cache.ready) return { state: "ready", title: "完成済みレポートを表示しています", message: "", error: null };
  if (error) return { state: "failed", title: "レポートを利用できません", message: "完成したレポートを取得できていません。", error };
  if (cache.refreshing) return { state: "pending", title: "レポートを生成中です", message: "完了すると結果を表示します。他のタブやサポート操作は引き続き利用できます。", error: null };
  return { state: "unavailable", title: "レポートはまだ生成されていません", message: "生成を開始すると、独立レポートworkerが集計します。", error: null };
}
