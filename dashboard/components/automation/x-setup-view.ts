import { xObject } from "./x-monitor-view";

export const X_SETUP_MAX_FILE_BYTES = 32 * 1024;
export const X_SETUP_DOWNLOAD_URL = "/api/automation/x-setup/download";
export const X_SETUP_CHROME_DOWNLOAD_URL = "/api/automation/x-setup/download-chrome";
export const X_SETUP_CHROME_MAC_DOWNLOAD_URL = "/api/automation/x-setup/download-chrome-mac";
export const X_SETUP_EDGE_DOWNLOAD_URL = "/api/automation/x-setup/download-edge";
export type XReceiverState = "awaiting" | "connecting" | "listening" | "requires_reenrollment" | "stopped" | "error";
export type XReceiptCounts = { received: number; routed: number; unsupported: number; decryptionFailed: number; unmatched?: number };
export type XSetupSubscription = { id: string; state: "stored"; revision: number; createdAtMs: number; updatedAtMs: number; browserKind: "firefox" | "chrome" | "brave" | "edge"; browserVersion: string; receiverState: XReceiverState; receiverRetryPending?: boolean; boundMonitorCount: number; lastReceivedAtMs: number | null; lastProviderLossAtMs?: number; receiptCounts?: XReceiptCounts };
export type XSetupStatus = { available: boolean; receiverEnabled: boolean; chromeEnabled: boolean; chromeMacDownloads: { arm64: boolean; x64: boolean }; braveEnabled: boolean; edgeEnabled: boolean; rollout: { mode: "disabled" | "supporters" | "public"; eligible: boolean; reasonCode: string | null; reason: string | null }; download: { url: string; version: string; sha256: string }; subscriptions: XSetupSubscription[]; maxFileBytes: number; nextCursor: string | null };
export type XSetupSession = { sessionId: string; expiresAtMs: number };
export type XSetupPreview = { browserVersion: string; scope: string; formatVersion: 1 | 2 | 3; browserKind?: "brave" | "edge" };
const invalid = () => new Error("Invalid X setup response");
function count(value: unknown, minimum = 0): number { if (!Number.isSafeInteger(value) || Number(value) < minimum) throw invalid(); return value as number; }
function timestamp(value: unknown): number { const result = count(value); if (result > 8640000000000000) throw invalid(); return result; }
function browserVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9A-Za-z._+-]{1,64}$/u.test(value)) throw invalid();
  return value;
}
export function parseXSetupSubscription(value: unknown): XSetupSubscription {
  const item = xObject(value);
  if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.id) || item.state !== "stored") throw invalid();
  if (item.browserKind !== undefined && item.browserKind !== "firefox" && item.browserKind !== "chrome" && item.browserKind !== "brave" && item.browserKind !== "edge") throw invalid();
  const receiverState = item.receiverState ?? "awaiting";
  if (!["awaiting", "connecting", "listening", "requires_reenrollment", "stopped", "error"].includes(String(receiverState))) throw invalid();
  if (item.receiverRetryPending !== undefined && (typeof item.receiverRetryPending !== "boolean" || item.receiverRetryPending && receiverState !== "error")) throw invalid();
  // Older servers omit the breakdown. Keep that absence distinct from a
  // verified zero count, and reject incomplete/invalid new status data.
  const receipts = item.receiptCounts === undefined ? undefined : xObject(item.receiptCounts);
  const receiptCounts = receipts === undefined ? undefined : { received: count(receipts.received), routed: count(receipts.routed),
    unsupported: count(receipts.unsupported), decryptionFailed: count(receipts.decryptionFailed),
    ...(receipts.unmatched === undefined ? {} : { unmatched: count(receipts.unmatched) }) };
  return { id: item.id, state: "stored", revision: count(item.revision, 1), createdAtMs: timestamp(item.createdAtMs), updatedAtMs: timestamp(item.updatedAtMs), browserKind: item.browserKind === "brave" ? "brave" : item.browserKind === "chrome" ? "chrome" : item.browserKind === "edge" ? "edge" : "firefox", browserVersion: browserVersion(item.browserVersion), receiverState: receiverState as XReceiverState, ...(item.receiverRetryPending === true ? { receiverRetryPending: true } : {}), boundMonitorCount: item.boundMonitorCount == null ? 0 : count(item.boundMonitorCount), lastReceivedAtMs: item.lastReceivedAtMs == null ? null : timestamp(item.lastReceivedAtMs), ...(item.lastProviderLossAtMs == null ? {} : { lastProviderLossAtMs: timestamp(item.lastProviderLossAtMs) }), ...(receiptCounts === undefined ? {} : { receiptCounts }) };
}
export function parseXSetupStatus(value: unknown): XSetupStatus {
  const item = xObject(value), download = xObject(item.download);
  const rollout = item.rollout == null ? { mode: "disabled", eligible: false, reasonCode: "X_ROLLOUT_DISABLED", reason: null } : xObject(item.rollout);
  const macDownloads = item.chromeMacDownloads === undefined ? { arm64: false, x64: false } : xObject(item.chromeMacDownloads);
  if (typeof macDownloads.arm64 !== "boolean" || typeof macDownloads.x64 !== "boolean") throw invalid();
  if (!["disabled", "supporters", "public"].includes(String(rollout.mode)) || typeof rollout.eligible !== "boolean"
    || rollout.reasonCode != null && (typeof rollout.reasonCode !== "string" || rollout.reasonCode.length > 80)
    || rollout.reason != null && (typeof rollout.reason !== "string" || rollout.reason.length > 500)) throw invalid();
  if (typeof item.available !== "boolean" || typeof item.receiverEnabled !== "boolean" || item.chromeEnabled !== undefined && typeof item.chromeEnabled !== "boolean" || item.braveEnabled !== undefined && typeof item.braveEnabled !== "boolean" || item.edgeEnabled !== undefined && typeof item.edgeEnabled !== "boolean" || !Array.isArray(item.subscriptions)
    || download.url !== X_SETUP_DOWNLOAD_URL || typeof download.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/u.test(download.version)
    || typeof download.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(download.sha256)
    || item.nextCursor != null && (typeof item.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.nextCursor))
    || !Number.isSafeInteger(item.maxFileBytes) || Number(item.maxFileBytes) < 1 || Number(item.maxFileBytes) > X_SETUP_MAX_FILE_BYTES) throw invalid();
  return { available: item.available && rollout.eligible && rollout.mode !== "disabled", receiverEnabled: item.receiverEnabled, chromeEnabled: item.chromeEnabled === true,
    chromeMacDownloads: { arm64: macDownloads.arm64 === true && item.chromeEnabled === true && item.receiverEnabled && rollout.eligible && rollout.mode !== "disabled", x64: macDownloads.x64 === true && item.chromeEnabled === true && item.receiverEnabled && rollout.eligible && rollout.mode !== "disabled" },
    braveEnabled: item.braveEnabled === true && item.chromeEnabled === true, edgeEnabled: item.edgeEnabled === true && item.receiverEnabled && rollout.eligible && rollout.mode !== "disabled", rollout: { mode: rollout.mode as XSetupStatus["rollout"]["mode"], eligible: rollout.eligible, reasonCode: rollout.reasonCode as string | null ?? null, reason: rollout.reason as string | null ?? null }, download: { url: download.url, version: download.version, sha256: download.sha256 },
    subscriptions: item.subscriptions.map(parseXSetupSubscription), maxFileBytes: item.maxFileBytes as number, nextCursor: item.nextCursor as string | null ?? null };
}
export function parseXSetupSession(value: unknown): XSetupSession {
  const item = xObject(value);
  if (typeof item.sessionId !== "string" || !/^[a-f0-9]{64}$/u.test(item.sessionId)) throw invalid();
  return { sessionId: item.sessionId, expiresAtMs: count(item.expiresAtMs, 1) };
}
export function parseXSetupPreview(value: unknown): XSetupPreview {
  const item = xObject(value);
  if (item.valid !== true || ![1, 2, 3].includes(Number(item.formatVersion)) || typeof item.scope !== "string" || item.scope.length > 4096) throw invalid();
  const scope = new URL(item.scope);
  if (scope.protocol !== "https:" || scope.hostname !== "x.com" || scope.port || scope.username || scope.password || scope.search || scope.hash || scope.href !== item.scope) throw invalid();
  if (item.formatVersion === 3 && scope.href !== "https://x.com/") throw invalid();
  // The full scope is checked but never displayed: it may contain identifiers.
  if (item.formatVersion !== 1 && item.formatVersion !== 2 && item.formatVersion !== 3) throw invalid();
  if (item.browserKind !== undefined && !(item.formatVersion === 1 && item.browserKind === "firefox")
    && !(item.formatVersion === 2 && (item.browserKind === "chrome" || item.browserKind === "brave")) && !(item.formatVersion === 3 && item.browserKind === "edge")) throw invalid();
  if (item.formatVersion === 3 && item.browserKind !== "edge") throw invalid();
  return { browserVersion: browserVersion(item.browserVersion), scope: "https://x.com/", formatVersion: item.formatVersion,
    ...(item.browserKind === "brave" ? { browserKind: "brave" as const } : item.browserKind === "edge" ? { browserKind: "edge" as const } : {}) };
}
export function xSetupFeedback(cause: unknown): string {
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  if (code === "X_ROLLOUT_DISABLED") return "X通知は現在、公開準備中です。保存ツールのダウンロードと手順の確認ができます。ファイルの登録や監視の開始は、受付開始後にご案内します。";
  if (code === "X_ROLLOUT_SUPPORTERS_ONLY") return "現在は、これまでに寄付いただいた方を対象にしたベータ版です。受付対象の拡大をお待ちください。寄付はサービスへの支援であり、ベータ参加や利用枠の購入ではありません。";
  if (["X_SETUP_SESSION_INVALID", "X_SETUP_SESSION_EXPIRED", "X_SETUP_SESSION_USED"].includes(String(code))) return "ファイルを選び直して、もう一度内容を確認してください。確認から時間が経ったか、別の画面で登録操作が進んでいます。";
  if (code === "X_SETUP_NOT_CONFIGURED") return "現在、ファイルの受付は準備中です。手順の確認と保存ツールのダウンロードができます。";
  if (code === "X_SETUP_FILE_TOO_LARGE") return "保存ツールで作成した32 KiB以下のJSONファイルを選んでください。選択したファイルは容量の上限を超えています。";
  if (code === "X_SETUP_INVALID_FILE") return "保存ツールでX通知データを作り直してください。ファイルの形式を確認できませんでした。";
  if (code === "X_SETUP_CHROME_NOT_READY") return "このブラウザーの接続は準備中です。受付開始までお待ちください。";
  if (code === "X_SETUP_BRAVE_NOT_READY") return "Braveの接続は準備中です。受付開始までお待ちください。";
  if (code === "X_SETUP_EDGE_NOT_READY") return "Edge の接続は準備中です。";
  if (code === "X_SETUP_CONSENT_REQUIRED") return "ファイルに入る情報と通知の扱いを確認し、同意にチェックしてください。";
  if (code === "X_SETUP_SUBSCRIPTION_CONFLICT") return "ご自身の登録一覧を確認してください。受信情報が別の登録と重複しているか、作成時から変わっています。内容を確認したうえで、必要な場合は古い登録を削除し、ファイルを作り直してください。";
  if (code === "REVISION_CONFLICT" || code === "NOT_FOUND") return "一覧を更新してから、もう一度確認してください。別の操作で登録情報が更新・削除されています。";
  return "受付状態と登録一覧を更新して、もう一度お試しください。今回の操作中にエラーが発生しました。";
}
export function xReceiverLabel(state: XReceiverState, retryPending = false): string {
  if (state === "error" && retryPending) return "再接続待ち";
  return ({ awaiting: "サーバー接続待ち", connecting: "サーバー接続中", listening: "サーバー接続を確認済み", requires_reenrollment: "受信情報の再登録が必要", stopped: "サーバー受信は停止中", error: "サーバー接続の確認が必要" })[state];
}
export function xReceiverDescription(state: XReceiverState, retryPending = false): string {
  if (state === "error" && retryPending) return "再接続を待っています。";
  return ({ awaiting: "受信情報の保存が完了しました。サーバーとの接続を待っています。", connecting: "サーバーとの接続を準備しています。接続後は、通知データの受信記録と通知先への配信結果をご確認ください。", listening: "サーバーとの接続を確認しました。投稿通知が届いたら、受信記録と通知先への配信結果を確認してください。", requires_reenrollment: "設定用ブラウザーで通知を設定し直し、新しいファイルを作成してください。一覧から古い受信情報を削除して新しいファイルを登録し、監視するアカウントに設定してください。", stopped: "受信情報は保存されています。受信を再開するには、受付状態と監視の設定を確認してください。", error: "下の更新ボタンで、受信情報と接続状態を確認してください。エラーが続く場合は管理者へお問い合わせください。" })[state];
}
