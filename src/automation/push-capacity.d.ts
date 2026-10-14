type Query = (sql: string, params?: unknown[]) => Promise<any>;
type AdminActor = { userId: string; isAdmin?: boolean };
export type PushPoolPolicy = { featureEnabled: false; freePoolLimit: number; supporterPoolLimit: number; updatedAtMs: number };
export type PushPlanCapacity = { planId: string; label: string; planEnabled: boolean; isPaid: true; eligible: boolean; specialSlotLimit: number; realtimeEnabled: boolean; consumesUserSlots: true; featureEnabled: false; updatedAtMs: number };
export type PushPoolPolicyInput = { freePoolLimit: number; supporterPoolLimit: number; expectedUpdatedAtMs: number };
export type PushPlanCapacityInput = { eligible: boolean; specialSlotLimit: number; expectedUpdatedAtMs: number; realtimeEnabled?: boolean };
export const CAPACITY_LIMIT_MAX: number;
export const DEFAULT_POOL_POLICY: Readonly<{ freePoolLimit: number; supporterPoolLimit: number }>;
export function requireAdmin(actor: AdminActor): string;
export function getPoolPolicy(query: Query, actor: AdminActor): Promise<PushPoolPolicy>;
/** Untrusted input is strictly validated before any policy write. */
export function savePoolPolicy(query: Query, actor: AdminActor, input: unknown): Promise<PushPoolPolicy>;
export function getPlanCapacity(query: Query, actor: AdminActor, planId: string): Promise<PushPlanCapacity>;
export function savePlanCapacity(query: Query, actor: AdminActor, planId: string, input: unknown): Promise<PushPlanCapacity>;
