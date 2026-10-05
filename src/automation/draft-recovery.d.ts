export interface RecoveryRecord {
  ownerId: string;
  guildId?: string | null;
  workflowId: string | null;
  baseRevision: number | null;
  scope: string;
  definition: any;
  bindings: any;
  textDraft: { text: string; format: string } | null;
  schemaVersion?: number;
  savedAtMs?: number;
}
export function recoveryKey(ownerId: string, guildId?: string | null): string;
export function encodeRecovery(record: RecoveryRecord, now?: number): string;
export function decodeRecovery(text: string, ownerId: string, guildId?: string | null, now?: number): RecoveryRecord;
export const MAX_AGE_MS: number;
