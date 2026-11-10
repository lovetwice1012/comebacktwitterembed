const explanations: Record<string, string> = {
  EVENT_NOT_SELECTED: "この投稿は通知条件の対象外です。",
  ALL_MEMBERS_REVOKED: "対象の通知設定が変更されました。",
  RUN_REVOKED: "通知設定が変更されました。",
  AUTOMATION_SLOT_LIMIT: "現在のプランで利用できる通知枠を確認してください。",
  AUTOMATION_RATE_LIMITED: "送信上限に達しました。",
  AUTOMATION_RATE_LIMIT_UNAVAILABLE: "送信上限を確認できませんでした。",
  AUTOMATION_NOTIFICATION_BATCH_LIMIT: "通知のメッセージ数が上限を超えています。",
  X_MONITOR_NOT_AVAILABLE: "現在の利用枠では、このX監視を利用できません。",
  X_ROLLOUT_SUPPORTERS_ONLY: "X通知は支援者向けに先行公開しています。",
  X_ROLLOUT_DISABLED: "X通知は現在準備中です。",
  RATE_GATE_LIMIT: "通知件数の上限に達しました。",
  RATE_GATE_DEFERRED: "送信上限により通知が制限されました。",
  RATE_GATE_DEADLINE: "通知件数の上限により期限を過ぎました。",
  DEADLINE_EXCEEDED: "配信期限を過ぎました。",
  DELAY_EXCEEDS_DEADLINE: "待機時刻が配信期限を過ぎています。",
  NO_DELIVERY_WINDOW: "期限内に通知できる時間がありません。",
  FLOW_DESTINATION_MISSING: "通知先を選び直してください。",
  DESTINATION_DELETED: "通知先が削除されました。",
  DESTINATION_DISABLED: "通知先が停止中です。",
  DESTINATION_SCOPE_CHANGED: "通知先の公開範囲が変わりました。",
  WORKFLOW_PAUSED: "通知ルールが停止中です。",
  WORKFLOW_DELETED: "通知ルールの削除に伴い停止しました。",
  MONITOR_CHANGED: "通知設定が変更されました。",
  SEND_LEASE_EXPIRED: "Discordで送信結果を確認してください。",
  AGGREGATE_SUPERSEDED: "最新の内容に置き換えました。",
  SAFETY_CONTENT_DENIED: "安全設定により送信対象外になりました。",
  SAFETY_INPUT_LIMIT: "通知内容が大きすぎます。内容を確認してください。",
  SAFETY_INVALID_ATTACHMENT: "添付ファイルを確認できませんでした。",
  SAFETY_UNINSPECTABLE_ATTACHMENT: "添付ファイルの内容を確認できませんでした。",
  SAFETY_INVALID_PAYLOAD: "通知内容を確認できませんでした。",
  SAFETY_PAYLOAD_CHANGED: "通知内容が変更されました。",
  SAFETY_VERIFIER_UNAVAILABLE: "安全確認を利用できませんでした。",
  SAFETY_CHECK_TIMEOUT: "安全確認が時間内に終わりませんでした。",
  SAFETY_CHECK_FAILED: "安全確認を完了できませんでした。",
  SAFETY_INVALID_ASSESSMENT: "安全確認の結果を確認できませんでした。",
  SAFETY_PACKAGE_REVOKED: "共有ルールが停止中です。",
  SAFETY_DICTIONARY_REVOKED: "共有辞書が停止中です。",
  GRAPH_INPUT_LIMIT: "通知内容が上限を超えています。まとめる件数を確認してください。",
  FLOW_SNAPSHOT_LIMIT: "まとめる件数を確認してください。",
  FLOW_WAITING: "次の処理時刻を待っています。",
};

export function historyReason(value?: string): string | undefined {
  if (!value) return undefined;
  if (explanations[value]) return explanations[value];
  // Unknown internal codes must not be mistaken for a known exclusion reason.
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return "処理記録を確認してください。";
  return value;
}

export function hasConfirmedSend(state: string, sentSteps: unknown, messageId: unknown): boolean {
  return state === "sent" && Number.isSafeInteger(Number(sentSteps)) && Number(sentSteps) > 0 && typeof messageId === "string" && messageId.length > 0;
}

export function excludedRunReason(trace: unknown): string | undefined {
  if (!Array.isArray(trace)) return undefined;
  const records = trace.filter(entry => entry && typeof entry === "object" && typeof entry.reason === "string" && entry.reason);
  const terminal = [...records].reverse().find(entry => ["excluded", "expired", "failed", "unknown"].includes(entry.outcome));
  const unconnected = [...records].reverse().find(entry => entry.reason === "この分岐の接続がないため通知しません");
  const explicitLegacyTerminal = [...records].reverse().find(entry => !entry.outcome && entry.reason === "DEADLINE_EXCEEDED");
  return historyReason((terminal || unconnected || explicitLegacyTerminal)?.reason);
}
