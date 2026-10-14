type Query = (sql: string, params?: unknown[]) => Promise<any>;
type Actor = { userId: string; isAdmin?: boolean };
export type XProcessingMode = 'batch' | 'realtime';
export type XProcessingSettings = {
    requestedMode: XProcessingMode; effectiveMode: XProcessingMode; realtimeAllowed: boolean;
    planId: string; planLabel: string; intervalMinutes: number | null; configured: boolean; reasonCode: string | null;
};
export function inspectXProcessingSettings(query: Query, userId: string, now?: number,
    options?: { plan?: import('./entitlements').NotificationPlan; useLegacyUserInterval?: boolean }): Promise<XProcessingSettings>;
export function createXProcessingSettings(db: { queryDatabase: Query; withDatabaseTransaction: (work: (query: Query) => Promise<any>) => Promise<any> },
    options?: { now?: () => number; rolloutMode?: 'disabled' | 'supporters' | 'public'; useLegacyUserInterval?: boolean }): {
    get(actor: Actor): Promise<XProcessingSettings & { rollout: import('./x-rollout-policy').XRolloutDecision }>;
    save(actor: Actor, input: unknown): Promise<XProcessingSettings & { rollout: import('./x-rollout-policy').XRolloutDecision }>;
};
