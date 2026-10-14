type Query = (sql: string, params?: unknown[]) => Promise<any>;
type Actor = { userId: string; isAdmin?: boolean };
export type XProcessingMode = 'batch' | 'realtime';
export type XProcessingSettings = {
    requestedMode: XProcessingMode; effectiveMode: XProcessingMode; realtimeAllowed: boolean;
    planId: string; planLabel: string; intervalMinutes: number | null; configured: boolean; reasonCode: string | null;
};
export function inspectXProcessingSettings(query: Query, userId: string, now?: number,
    options?: { plan?: import('./entitlements').NotificationPlan; useLegacyUserInterval?: boolean }): Promise<XProcessingSettings>;
export type XMonitorProcessing = {
    requestedMode: XProcessingMode; explicitMode: XProcessingMode | null; modeSource: 'monitor' | 'owner'; effectiveMode: XProcessingMode;
    realtimeSource: 'supporter' | 'plan' | 'slots' | null; realtimeEligibilitySource: 'supporter' | 'plan' | 'slots' | null;
    slotCost: number; effectiveSlotCost: number; realtimeSlotCost: 1 | 5; additionalSlotsNeeded: number; canEnableRealtime: boolean;
    planId: string; planLabel: string; intervalMinutes: number | null; configured: boolean; reasonCode: string | null; isPreview?: boolean;
};
export function inspectXMonitorProcessing(query: Query, monitor: { id?: number | string; owner_user_id: string; pool_kind: string | null;
    notification_settings_json: string; state?: string }, now?: number, options?: { plan?: import('./entitlements').NotificationPlan;
    ownerSettings?: XProcessingSettings; useLegacyUserInterval?: boolean; prospectivePool?: boolean; registrationPreview?: boolean }): Promise<XMonitorProcessing>;
export function inspectXRegistrationProcessing(query: Query, owner: string, poolKind: string | null, processingMode?: XProcessingMode,
    now?: number, options?: { plan?: import('./entitlements').NotificationPlan; ownerSettings?: XProcessingSettings; useLegacyUserInterval?: boolean }): Promise<XMonitorProcessing>;
export function createXProcessingSettings(db: { queryDatabase: Query; withDatabaseTransaction: (work: (query: Query) => Promise<any>) => Promise<any> },
    options?: { now?: () => number; rolloutMode?: 'disabled' | 'supporters' | 'public'; useLegacyUserInterval?: boolean }): {
    get(actor: Actor): Promise<XProcessingSettings & { rollout: import('./x-rollout-policy').XRolloutDecision }>;
    save(actor: Actor, input: unknown): Promise<XProcessingSettings & { rollout: import('./x-rollout-policy').XRolloutDecision }>;
};
