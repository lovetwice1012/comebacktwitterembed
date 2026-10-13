export type AutomationRatePolicy = {
    version: number;
    notifications: { slot: { minute: number; day: number }; dayZone: 'Asia/Tokyo'; unit: 'message' };
    operations: Record<'write' | 'monitor' | 'publication' | 'validate' | 'simulate', { minute: number; hour: number }>;
};
export type AutomationRatePolicyOverrides = {
    operations?: Partial<Record<'write' | 'monitor' | 'publication' | 'validate' | 'simulate', Partial<{ minute: number; hour: number }>>>;
};
export class AutomationRateError extends Error {
    code: string;
    status: number;
    retryAfterMs?: number;
    limit?: number;
    issues?: Array<{ path: string; code: string; message: string }>;
    constructor(code: string, message: string, status: number, details?: Record<string, unknown>);
}
export function getPolicy(overrides?: AutomationRatePolicyOverrides): AutomationRatePolicy;
export function createRateLimiter(db: any, options?: { clock?: () => number; policy?: AutomationRatePolicyOverrides }): {
    getPolicy(): AutomationRatePolicy;
    consumeOperation(actor: { userId: string }, group?: 'write' | 'monitor' | 'publication' | 'validate' | 'simulate'): Promise<{ count: number; createdAtMs: number; expiresAtMs: number }>;
    reserveNotifications(principal: { ownerUserId: string; slotId: string; slotIndex: number; minuteLimit: number; dayLimit: number }, count: number): Promise<{ id: string; count: number; createdAtMs: number; expiresAtMs: number }>;
    reserveNotificationBatch(principals: Array<{ ownerUserId: string; slotId: string; slotIndex: number; minuteLimit: number; dayLimit: number }>, count: number, payloadSlots?: string[][]): Promise<{ id: string; count: number; createdAtMs: number; expiresAtMs: number }>;
    commitNotification(reservation: any, index: number): Promise<void>;
    beginNotification(reservation: any, index: number): Promise<void>;
    retainUnknownNotification(reservation: any, index: number): Promise<void>;
    releaseNotifications(reservation: any, index?: number | null): Promise<void>;
    getSlotUsage(slotId: string, quota?: {dayLimit?: number; minuteLimit?: number}): Promise<{slotId: string; todayUsed: number; todayReserved: number; dayLimit: number; minuteLimit: number; resetAtMs: number}>;
};
