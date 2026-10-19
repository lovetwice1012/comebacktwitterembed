const MAX_RETRY_DELAY = 24 * 60 * 60 * 1000;
let activeReads = 0;
const waitingReads: Array<() => void> = [];

// Keep background reads below the server's four-request actor ceiling,
// leaving capacity for explicit edits. Mutations start immediately.
async function readInOrder<T>(work: () => Promise<T>): Promise<T> {
  if (activeReads >= 2) await new Promise<void>(resolve => waitingReads.push(resolve));
  else activeReads++;
  try { return await work(); }
  finally {
    const next = waitingReads.shift();
    if (next) next();
    else activeReads--;
  }
}

export function automationFetch(url: string, init?: RequestInit): Promise<any> {
  return (init?.method || "GET").toUpperCase() === "GET"
    ? readInOrder(() => requestAutomation(url, init)) : requestAutomation(url, init);
}

/** A transport failure never includes an upstream body or browser exception. */
async function requestAutomation(url: string, init?: RequestInit): Promise<any> {
  let response: Response;
  try { response = await fetch(url, init); }
  catch { throw Object.assign(new Error("通信できませんでした。接続を確認して、一覧を再読み込みしてください。入力内容は保持されています。"), { code: "AUTOMATION_NETWORK_ERROR", status: 0 }); }
  const authRequired = response.status === 401 || response.redirected && /\/(?:api\/auth\/signin|login)(?:[/?#]|$)/u.test(response.url);
  if (authRequired) throw Object.assign(new Error("ログインの有効期限が切れました。別のタブでログインし直し、この画面で再読み込みしてください。入力内容は保持されています。"), { code: "AUTH_REQUIRED", status: 401 });
  let data: any;
  try { data = await response.json(); }
  catch { throw Object.assign(new Error("サービスの応答を確認できませんでした。時間をおいて、一覧を再読み込みしてください。入力内容は保持されています。"), { code: "AUTOMATION_INVALID_RESPONSE", status: response.status }); }
  if (!response.ok) throw automationResponseError(data, response);
  const collection = /\/api\/automation\/(?:workflows|destinations|dictionaries)(?:[?#]|$)/u.test(url)
    && (!init?.method || init.method.toUpperCase() === "GET");
  // History is a legitimate array; collection GETs have a paged-list contract.
  // A malformed successful response must never become React state or raw JS errors.
  if (data === null || typeof data !== "object" || collection && (Array.isArray(data) || !Array.isArray(data.items)
    || data.items.some((item: any) => item === null || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string")
    || data.nextCursor != null && typeof data.nextCursor !== "string")) {
    throw Object.assign(new Error("サービスの応答を確認できませんでした。時間をおいて、一覧を再読み込みしてください。入力内容は保持されています。"), { code: "AUTOMATION_INVALID_RESPONSE", status: response.status });
  }
  return data;
}

export function automationPlanName(value: unknown): string {
  return typeof value === "string" && value.length <= 80 && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ? value.trim() : "";
}

export function automationRetryDelay(error: any): number | null {
  if (!["AUTOMATION_RATE_LIMITED", "AUTOMATION_RATE_LIMIT_UNAVAILABLE"].includes(error?.code) && error?.status !== 429) return null;
  const delay = Number(error.retryAfterMs);
  return Number.isFinite(delay) && delay > 0 ? Math.min(MAX_RETRY_DELAY, Math.ceil(delay)) : error?.code === "AUTOMATION_RATE_LIMIT_UNAVAILABLE" ? 60000 : 1000;
}

export function automationErrorMessage(error: any): string {
  const delay = automationRetryDelay(error);
  if (error?.status === 401 || error?.code === "AUTH_REQUIRED") return "ログインの有効期限が切れました。別のタブでログインし直し、この画面で再読み込みしてください。入力内容は保持されています。";
  if (error?.code === "AUTOMATION_SLOT_LIMIT") {
    const maximum = Number(error.maxSlots ?? error.limit), available = Number(error.availableSlots);
    const plan = automationPlanName(error.planName);
    const limits = Number.isInteger(maximum) && maximum > 0 && maximum <= 100000 ? `（${Number.isInteger(available) && available >= 0 && available <= maximum ? `残り${available}枠／` : ""}最大${maximum}枠）` : "";
    return `${plan ? `${plan}の` : ""}通知の登録枠が上限に達しています${limits}。不要な通知を削除してから再度登録してください。入力内容は保持されています。`;
  }
  if (error?.code === "AUTOMATION_RATE_LIMIT_UNAVAILABLE") return `利用制限を確認できませんでした。約${Math.ceil((delay || 60000) / 1000)}秒待ってから再試行してください。編集内容は保持されています。`;
  if (delay !== null && ["slot", "notification"].includes(error?.scope)) return `この通知枠の送信上限に達しました。約${Math.ceil(delay / 1000)}秒後に再度送信できます。1通は実際に送信したメッセージ1件として数えます。`;
  if (delay !== null) return `操作が集中しています。約${Math.ceil(delay / 1000)}秒待ってから再試行してください。編集内容は保持されています。`;
  if (["AUTOMATION_FANOUT_LIMIT", "AUTOMATION_NOTIFICATION_BATCH_LIMIT"].includes(error?.code)) return "1件のイベントから作れる通知が上限を超えています。分岐・通知ブロックを減らしてください。";
  if (error?.code === "AUTOMATION_DELIVERY_RATE_LIMIT") return "サービス側の通知件数の上限に達したため、次に送信できる時刻まで待機しています。";
  if (error?.code === "AUTOMATION_DELIVERY_SIZE_LIMIT") return "通知内容がサービス側の上限を超えています。通知の長さやまとめる件数を減らしてください。";
  if (Number(error?.status) >= 500) return "サービス側で処理を確認できませんでした。現在の状態を再読み込みしてください。入力内容は保持されています。";
  return typeof error?.message === "string" && error.message ? error.message : "操作に失敗しました。時間をおいて再試行してください。";
}

export function automationResponseError(data: any, response: Pick<Response, "status" | "headers">): Error & { retryAfterMs?: number; status: number; code?: string; issues?: any[] } {
  const error = Object.assign(new Error(typeof data?.error === "string" ? data.error : "操作に失敗しました。"), data, { status: response.status });
  if (["AUTOMATION_RATE_LIMITED", "AUTOMATION_RATE_LIMIT_UNAVAILABLE"].includes(error.code) || response.status === 429) {
    const bodyDelay = Number(data?.retryAfterMs);
    const header = response.headers.get("Retry-After");
    const seconds = header === null || !header.trim() ? NaN : Number(header);
    const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : NaN;
    const delay = Number.isFinite(bodyDelay) && bodyDelay > 0 ? bodyDelay : headerDelay;
    error.retryAfterMs = Number.isFinite(delay) && delay > 0 ? Math.min(MAX_RETRY_DELAY, Math.ceil(delay)) : error.code === "AUTOMATION_RATE_LIMIT_UNAVAILABLE" ? 60000 : 1000;
  }
  error.message = automationErrorMessage(error);
  return error;
}
