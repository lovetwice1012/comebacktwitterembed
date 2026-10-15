export type ResourceStatus = "active" | "paused" | "missing" | "unapplied" | "unknown";
export function workflowStatus(id: string | undefined, rules: any[], verified?: ResourceStatus | null): ResourceStatus | null {
  if (!id) return null;
  if (verified) return verified;
  const rule = rules.find(item => item.id === id);
  if (!rule || typeof rule.enabled !== "boolean" || !Object.hasOwn(rule, "activeRevision")) return "unknown";
  if (!rule.activeRevision) return "unapplied";
  return rule.enabled ? "active" : "paused";
}
export function destinationStatus(id: string | undefined, destinations: any[], verified?: ResourceStatus | null): ResourceStatus | null {
  if (!id) return null;
  if (verified) return verified;
  const destination = destinations.find(item => item.id === id);
  return !destination ? "unknown" : destination.enabled === false ? "paused" : destination.enabled === true ? "active" : "unknown";
}
export function readinessOf(row: any, rules: any[], destinations: any[]) {
  return { ...row, workflowStatus: workflowStatus(row.workflowId, rules, row.workflowStatus), destinationStatus: destinationStatus(row.destinationId, destinations, row.destinationStatus) };
}
export const workflowStatusLabel = (status: ResourceStatus | null) => status === null ? "通常の通知" : status === "active" ? "配信できます" : status === "unapplied" ? "ルール未適用" : status === "paused" ? "ルール停止中" : "ルールの確認待ち";
