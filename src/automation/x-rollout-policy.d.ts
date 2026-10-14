export type XRolloutMode = 'disabled' | 'supporters' | 'public';
export type XRolloutActor = { userId: string; isAdmin?: boolean };
export type XRolloutQuery = (sql: string, params?: unknown[]) => Promise<unknown>;
/** Trusted server configuration only; never forward a request body here. */
export type XRolloutOptions = { mode?: XRolloutMode };
export type XRolloutDecision = {
    mode: XRolloutMode;
    eligible: boolean;
    reasonCode: 'X_ROLLOUT_DISABLED' | 'X_ROLLOUT_SUPPORTERS_ONLY' | null;
    reason: string | null;
};
/** Rollout access is independent of capacity, credit ownership and receiver readiness. */
export function evaluateXRollout(query: XRolloutQuery, actor: XRolloutActor, options?: XRolloutOptions): Promise<XRolloutDecision>;
/** Denies disabled enrollment with 503 and non-donor supporter enrollment with 403. */
export function requireXEnrollment(query: XRolloutQuery, actor: XRolloutActor, options?: XRolloutOptions): Promise<XRolloutDecision>;
