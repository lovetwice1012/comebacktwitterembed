const MAX_RETRY_DELAY = 24 * 60 * 60 * 1000;

// HTTP 429 handling only; existing non-throttling API errors retain their message.
export function automationRetryDelay(error: any): number | null {
  if (error?.status !== 429) return null;
  const delay = Number(error.retryAfterMs);
  return Number.isFinite(delay) && delay > 0 ? Math.min(MAX_RETRY_DELAY, Math.ceil(delay)) : 1000;
}

export function automationErrorMessage(error: any): string {
  const delay = automationRetryDelay(error);
  if (delay !== null) return `操作が集中しています。約${Math.ceil(delay / 1000)}秒待ってから再試行してください。編集内容は保持されています。`;
  return typeof error?.message === "string" && error.message ? error.message : "操作に失敗しました。時間をおいて再試行してください。";
}

export function automationResponseError(data: any, response: Pick<Response, "status" | "headers">): Error & { retryAfterMs?: number; status: number; code?: string; issues?: any[] } {
  const error = Object.assign(new Error(typeof data?.error === "string" ? data.error : "操作に失敗しました。"), data, { status: response.status });
  if (response.status === 429) {
    const bodyDelay = Number(data?.retryAfterMs);
    const header = response.headers.get("Retry-After");
    const seconds = header === null || !header.trim() ? NaN : Number(header);
    const headerDelay = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : NaN;
    const delay = Number.isFinite(bodyDelay) && bodyDelay > 0 ? bodyDelay : headerDelay;
    error.retryAfterMs = Number.isFinite(delay) && delay > 0 ? Math.min(MAX_RETRY_DELAY, Math.ceil(delay)) : 1000;
  }
  error.message = automationErrorMessage(error);
  return error;
}
