export interface SourceGuidance { placeholder: string; example?: string; help: string }
export interface MonitorSummary { kind?: string; name?: string; source?: string; providerId?: string; enabled?: boolean; errorCode?: string; lastCheckedAtMs?: number; workflowId?: string | null; workflowStatus?: string | null; destinationId?: string | null; destinationStatus?: string | null }
export function sourceProvider(value: string): string | undefined;
export function sourceGuidance(providerId?: string): SourceGuidance;
export function monitorState(row: MonitorSummary): { id: string; label: string; description: string; action?: "workflow" | "destination" };
export function filterMonitors<T extends MonitorSummary>(rows: T[], query: string, state: string): T[];
