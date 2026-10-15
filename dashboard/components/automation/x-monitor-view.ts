export type XMonitorAPI = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export type XMonitorQuality = { planId: string; priority: number; minuteLimit: number; dayLimit: number; intervalMinutes: number | null };
export type XProcessingMode = "batch" | "realtime";
export type XMonitorProcessing = {
  requestedMode: XProcessingMode; explicitMode: XProcessingMode | null; modeSource: "monitor" | "owner"; effectiveMode: XProcessingMode;
  realtimeSource: "supporter" | "plan" | "slots" | null; realtimeEligibilitySource?: "supporter" | "plan" | "slots" | null;
  slotCost: 1 | 5; effectiveSlotCost: 1 | 5; realtimeSlotCost: 1 | 5; canEnableRealtime: boolean;
  additionalSlotsNeeded: number; configured: boolean; intervalMinutes: number | null; reasonCode: string | null; isPreview?: true;
};
export type XMonitorQuota = {
  featureEnabled: boolean;
  currentPlan: XMonitorQuality & { label: string; tier: string; baseSlotLimit: number };
  personal: { totalLimit: number; registeredCount: number | null; used: number; available: number; supporterExtraSlots: number };
  x: { used: number; available: number; reasonCode: string | null; reason: string | null; specialLimit: number; specialUsed: number };
  pools: { free: XPool; supporter: XPool };
  registrationProcessing?: XMonitorProcessing & { isPreview: true };
  supporterRealtimeRegistration?: XMonitorProcessing & { isPreview: true; poolKind: "supporter"; eligible: boolean; available: boolean; reason: string | null };
};
export type XPool = { limit: number; used: number; available: number };
export type XMonitor = {
  id: string; accountId: string | null; accountHandle: string | null; name: string; enabled: boolean; state: string;
  poolKind: "free" | "supporter" | "special" | null; subscriptionState: string; revision: number;
  notificationSettings: { workflowId?: string; destinationId?: string; subscriptionId?: string }; quality: XMonitorQuality;
  processing?: XMonitorProcessing;
  workflowStatus?: "active" | "paused" | "unapplied" | "missing" | "unknown" | null;
  destinationStatus?: "active" | "paused" | "missing" | "unknown" | null;
  supporterRealtimeProcessing?: XMonitorProcessing & { isPreview: true; poolKind: "supporter"; eligible: boolean; available: boolean; reason: string | null };
};
export const xCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function xObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid X response");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 120): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error("Invalid X response");
  return value;
}
function count(value: unknown): number { if (!xCount(value)) throw new Error("Invalid X response"); return value; }
export function parseXPool(value: unknown): XPool {
  const item = xObject(value);
  return { limit: count(item.limit), used: count(item.used), available: count(item.available) };
}
function quality(value: unknown): XMonitorQuality {
  const item = xObject(value);
  if (item.intervalMinutes !== null && !xCount(item.intervalMinutes)) throw new Error("Invalid X response");
  return { planId: text(item.planId, 64), priority: count(item.priority), minuteLimit: count(item.minuteLimit),
    dayLimit: count(item.dayLimit), intervalMinutes: item.intervalMinutes as number | null };
}
export function parseXMonitorProcessing(value: unknown, preview = false): XMonitorProcessing {
  const item = xObject(value), modes = ["batch", "realtime"], sources = [null, "supporter", "plan", "slots"];
  if (!modes.includes(String(item.requestedMode)) || !modes.includes(String(item.effectiveMode))
    || item.explicitMode !== null && !modes.includes(String(item.explicitMode)) || !["owner", "monitor"].includes(String(item.modeSource))
    || (item.explicitMode === null) !== (item.modeSource === "owner") || !sources.includes(item.realtimeSource as string | null)
    || item.realtimeEligibilitySource !== undefined && !sources.includes(item.realtimeEligibilitySource as string | null)
    || ![1, 5].includes(Number(item.slotCost)) || typeof item.slotCost !== "number" || ![1, 5].includes(Number(item.effectiveSlotCost)) || typeof item.effectiveSlotCost !== "number"
    || ![1, 5].includes(Number(item.realtimeSlotCost)) || typeof item.realtimeSlotCost !== "number" || typeof item.canEnableRealtime !== "boolean" || typeof item.configured !== "boolean"
    || !xCount(item.additionalSlotsNeeded) || Number(item.additionalSlotsNeeded) > 4
    || item.intervalMinutes !== null && (!Number.isSafeInteger(item.intervalMinutes) || Number(item.intervalMinutes) < 5 || Number(item.intervalMinutes) > 10080)
    || item.reasonCode !== null && (typeof item.reasonCode !== "string" || !/^[A-Z_]{1,80}$/u.test(item.reasonCode))
    || preview && item.isPreview !== true || !preview && item.isPreview !== undefined
    || item.effectiveMode === "realtime" && (item.realtimeSource === null || !item.configured)
    || item.effectiveMode === "batch" && item.effectiveSlotCost !== 1 || item.effectiveMode === "batch" && item.realtimeSource !== null
    || item.configured && item.effectiveMode === "batch" && item.intervalMinutes === null) throw new Error("Invalid X processing response");
  return { requestedMode: item.requestedMode as XProcessingMode, explicitMode: item.explicitMode as XProcessingMode | null, modeSource: item.modeSource as XMonitorProcessing["modeSource"],
    effectiveMode: item.effectiveMode as XProcessingMode, realtimeSource: item.realtimeSource as XMonitorProcessing["realtimeSource"],
    ...(item.realtimeEligibilitySource === undefined ? {} : { realtimeEligibilitySource: item.realtimeEligibilitySource as XMonitorProcessing["realtimeEligibilitySource"] }),
    slotCost: item.slotCost as 1 | 5, effectiveSlotCost: item.effectiveSlotCost as 1 | 5, realtimeSlotCost: item.realtimeSlotCost as 1 | 5,
    canEnableRealtime: item.canEnableRealtime, additionalSlotsNeeded: Number(item.additionalSlotsNeeded), configured: item.configured,
    intervalMinutes: item.intervalMinutes as number | null, reasonCode: item.reasonCode as string | null, ...(preview ? { isPreview: true } : {}) };
}
function optionalProcessing(value: unknown, preview = false): XMonitorProcessing | undefined {
  // An older or incompatible optional read model must not invent a price or
  // hide the existing owner controls for stopping and deleting the monitor.
  if (value === undefined) return undefined;
  try { return parseXMonitorProcessing(value, preview); } catch { return undefined; }
}
function optionalSupporterRegistration(value: unknown): XMonitorQuota["supporterRealtimeRegistration"] {
  if (value === undefined) return undefined;
  try {
    const item = xObject(value), processing = parseXMonitorProcessing(value, true);
    if (item.poolKind !== "supporter" || typeof item.eligible !== "boolean" || typeof item.available !== "boolean"
      || item.reason !== null && typeof item.reason !== "string"
      || item.available && (!item.eligible || !processing.canEnableRealtime || processing.realtimeSlotCost !== 1 || processing.realtimeEligibilitySource !== "supporter")) return undefined;
    return { ...processing, isPreview: true, poolKind: "supporter", eligible: item.eligible, available: item.available, reason: item.reason === null ? null : text(item.reason, 500) };
  } catch { return undefined; }
}
export function parseXQuota(value: unknown): XMonitorQuota {
  const item = xObject(value), plan = xObject(item.currentPlan), personal = xObject(item.personal), x = xObject(item.x), pools = xObject(item.pools);
  if (typeof item.featureEnabled !== "boolean") throw new Error("Invalid X response");
  return { featureEnabled: item.featureEnabled, currentPlan: { ...quality(plan), label: text(plan.label), tier: text(plan.tier, 32), baseSlotLimit: count(plan.baseSlotLimit) },
    personal: { totalLimit: count(personal.totalLimit), registeredCount: personal.registeredCount == null ? null : count(personal.registeredCount), used: count(personal.used), available: count(personal.available), supporterExtraSlots: count(personal.supporterExtraSlots) },
    x: { used: count(x.used), available: count(x.available), specialLimit: count(x.specialLimit), specialUsed: count(x.specialUsed),
      reasonCode: x.reasonCode == null ? null : text(x.reasonCode, 80), reason: x.reason == null ? null : text(x.reason, 500) },
    pools: { free: parseXPool(pools.free), supporter: parseXPool(pools.supporter) },
    ...(optionalProcessing(item.registrationProcessing, true) ? { registrationProcessing: optionalProcessing(item.registrationProcessing, true) as XMonitorProcessing & { isPreview: true } } : {}),
    ...(optionalSupporterRegistration(item.supporterRealtimeRegistration) ? { supporterRealtimeRegistration: optionalSupporterRegistration(item.supporterRealtimeRegistration) } : {}) };
}
export function parseXMonitor(value: unknown): XMonitor {
  const item = xObject(value), settings = xObject(item.notificationSettings);
  if (typeof item.enabled !== "boolean" || !xCount(item.revision) || item.revision < 1
    || item.accountId !== null && (typeof item.accountId !== "string" || !/^[1-9]\d{0,19}$/u.test(item.accountId)) || ![null, "free", "supporter", "special"].includes(item.poolKind as string | null)) throw new Error("Invalid X response");
  const handle = item.accountHandle == null ? null : text(item.accountHandle, 15);
  if (handle !== null && !/^[A-Za-z0-9_]{1,15}$/u.test(handle)) throw new Error("Invalid X response");
  if (item.accountId === null && handle === null) throw new Error("Invalid X response");
  if (settings.subscriptionId != null && (typeof settings.subscriptionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(settings.subscriptionId))) throw new Error("Invalid X response");
  return { id: text(item.id, 128), accountId: item.accountId === null ? null : String(item.accountId), accountHandle: handle, name: text(item.name), enabled: item.enabled,
    state: text(item.state, 32), poolKind: item.poolKind as XMonitor["poolKind"], subscriptionState: text(item.subscriptionState, 40), revision: item.revision,
    ...(item.workflowStatus === undefined ? {} : { workflowStatus: [null, "active", "paused", "unapplied", "missing", "unknown"].includes(item.workflowStatus as string | null) ? item.workflowStatus as XMonitor["workflowStatus"] : "unknown" }),
    ...(item.destinationStatus === undefined ? {} : { destinationStatus: [null, "active", "paused", "missing", "unknown"].includes(item.destinationStatus as string | null) ? item.destinationStatus as XMonitor["destinationStatus"] : "unknown" }),
    ...(optionalProcessing(item.processing) ? { processing: optionalProcessing(item.processing) } : {}),
    ...(optionalSupporterRegistration(item.supporterRealtimeProcessing) ? { supporterRealtimeProcessing: optionalSupporterRegistration(item.supporterRealtimeProcessing) } : {}),
    notificationSettings: { ...(typeof settings.workflowId === "string" ? { workflowId: text(settings.workflowId, 128) } : {}),
      ...(typeof settings.destinationId === "string" ? { destinationId: text(settings.destinationId, 128) } : {}),
      ...(typeof settings.subscriptionId === "string" ? { subscriptionId: settings.subscriptionId } : {}) }, quality: quality(item.quality) };
}
export function xReason(code: string | null | undefined): string {
  return ({ X_ROLLOUT_DISABLED: "X通知は公開準備中です。登録済みの監視を確認できます。新しい監視の受付は公開後に始まります。",
    X_ROLLOUT_SUPPORTERS_ONLY: "ベータ版は、受付対象となっている既存の寄付者の方にご案内しています。寄付は活動への支援として受け付け、参加資格と利用枠は別に確認します。",
    X_MONITOR_PERSONAL_LIMIT: "登録数が個人の上限に達しています。通常通知とX監視の登録を確認し、使い終えた登録を削除すると、新しく追加できます。",
    X_MONITOR_POOL_FULL: "X監視の全体枠は現在すべて利用中です。全体に空きができると追加できます。個人の利用数と全体の空きは、この画面で確認できます。",
    X_MONITOR_UNAVAILABLE: "X通知は公開に向けて準備を進めています。こちらでは登録済みの監視の確認・停止・削除ができます。新しい監視の受付は、受信テストの完了後にご案内します。",
    X_MONITOR_NOT_CONFIGURED: "受信を始めるために、管理者へ現在のプランの確認間隔の設定をご依頼ください。" } as Record<string, string>)[code ?? ""] ?? "X監視の利用枠を確認してください。";
}
export function xFeedback(cause: unknown): string {
  const error = cause && typeof cause === "object" ? cause as { code?: string; status?: number } : {};
  if (error.code === "X_REALTIME_COST_CONFLICT") return "必要な枠数が変わりました。一覧を更新し、使用する枠数を確認し直してください。";
  if (error.code === "X_REALTIME_SLOT_LIMIT") return "リアルタイム通知に必要な個人枠が不足しています。利用状況を確認してください。";
  if (error.code === "X_MONITOR_SUPPORTER_POOL_FULL") return "支援者優先枠は現在すべて利用中です。空き状況を再確認してください。選択した通知方法と入力内容は保持しています。";
  if (error.code === "X_MONITOR_SUPPORTER_REALTIME_INELIGIBLE") return "この特典の対象となる既存支援者の資格を確認してください。選択した通知方法と入力内容は保持しています。";
  if (error.code === "X_MONITOR_SUPPORTER_LIMIT") return "保有する支援者追加枠をすべて使用しています。利用状況を確認してください。選択した通知方法と入力内容は保持しています。";
  if (error.code === "X_MONITOR_REGISTRATION_CONFLICT") return "このXアカウントは登録済みです。一覧から利用枠と通知方法を変更してください。入力内容は保持しています。";
  if (error.code === "X_MONITOR_NOT_AVAILABLE") return "この監視の利用資格と割り当てを確認してください。";
  if (["X_MONITOR_PERSONAL_LIMIT", "X_MONITOR_POOL_FULL", "X_MONITOR_UNAVAILABLE", "X_MONITOR_NOT_CONFIGURED", "X_ROLLOUT_DISABLED", "X_ROLLOUT_SUPPORTERS_ONLY"].includes(error.code ?? "")) return xReason(error.code);
  if (error.code === "X_SETUP_SUBSCRIPTION_NOT_FOUND" || error.code === "X_MONITOR_SUBSCRIPTION_INVALID") return "自分の受信情報の一覧を更新し、登録済みの情報を選び直してください。入力内容はそのまま残っています。";
  if (error.code === "AUTOMATION_SLOT_LIMIT") return xReason("X_MONITOR_PERSONAL_LIMIT");
  if (error.code === "X_MONITOR_DESTINATION_INELIGIBLE") return "現在の契約プランと支援者追加枠に合う移動先を選んでください。現在の登録と選択内容はそのまま残っています。";
  if (error.code === "X_MONITOR_DESTINATION_FULL") return "移動先の枠はすべて利用中です。別の移動先を選ぶか、空き状況を確認してください。現在の登録と選択内容はそのまま残っています。";
  if (error.code === "X_MONITOR_HANDLE_CONFLICT") return "このXアカウントはすでに登録されています。一覧を更新して、登録済みの監視を確認してください。入力内容はそのまま残っています。";
  if (error.status === 409) return "監視の設定が更新されています。入力内容を保持しています。一覧・利用枠を更新して、変更内容をもう一度確認してください。";
  if (error.code === "NOT_FOUND" || error.status === 403 || error.status === 404) return "一覧を更新して、この監視のアクセス権と登録済みの受信情報を確認してください。入力内容はそのまま残っています。";
  if (error.status === 422) return "Xアカウント名と通知設定を確認してください。入力内容はそのまま残っています。";
  return "入力内容はそのまま残っています。X監視の操作をもう一度お試しください。";
}
export const xPoolName = (kind: XMonitor["poolKind"]) => ({ free: "共用無料枠", supporter: "支援者優先枠", special: "特別枠" } as Record<string, string>)[kind ?? ""] ?? "未割当";
export const xInterval = (value: number | null) => value === null ? "未設定" : `${value}分`;
