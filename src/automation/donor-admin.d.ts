import type { SquareActor } from './square-billing';
import type { DonationGrant, DonationHistory } from './square-donations';
import type { NotificationPlan } from './entitlements';

export interface DonorManual {
    isDonor: boolean;
    extraSlots: number;
    paymentCount: number;
    purchaseUnits: number;
    displayName: string;
    note: string;
    updatedAtMs: number | null;
}
export interface DonorVersion { updatedAtMs: number | null; legacyIsDonor: number; legacyExtraSlots: number }
export interface DonorCurrencyTotal { currency: string; amount: number; refundedAmount: number; netAmount: number; paymentCount: number }
export interface DonorSquareSummary {
    configured: boolean;
    environment: 'sandbox' | 'production' | null;
    active: boolean;
    paymentCount: number;
    totalsByCurrency: DonorCurrencyTotal[];
}
export interface DonorListItem {
    userId: string;
    exists: boolean;
    manual: DonorManual;
    square: DonorSquareSummary;
    totals: { paymentCount: number };
}
export interface DonorDetail extends DonorListItem {
    version: DonorVersion;
    square: DonorSquareSummary & { grant: DonationGrant; history: DonationHistory[]; historyNextCursor: string | null };
    entitlement: NotificationPlan & { usedSlots: number; remainingSlots: number; overLimit: boolean };
}
export interface DonorEdit {
    isDonor: boolean;
    extraSlots: number;
    paymentCount: number;
    purchaseUnits: number;
    displayName: string;
    note: string;
    reason: string;
    expectedUpdatedAtMs: number | null;
    expectedLegacyIsDonor: number;
    expectedLegacyExtraSlots: number;
}
export interface DonorPage<T> { items: T[]; nextCursor: string | null; pageSize: number }
export interface DonorAudit { id: string; userId: string; actorUserId: string; reason: string; before: DonorManual & { legacyIsDonor: number; legacyExtraSlots: number }; after: DonorManual & { legacyIsDonor: number; legacyExtraSlots: number }; createdAtMs: number }
export function createDonorAdmin(db: { queryDatabase: Function; withDatabaseTransaction: Function }, options?: { env?: Record<string, string | undefined>; clock?: () => number }): {
    list(actor: SquareActor, input?: { search?: string | null; cursor?: string | null; pageSize?: number | string | null }): Promise<DonorPage<DonorListItem> & { total: number }>;
    get(actor: SquareActor, userId: string): Promise<DonorDetail>;
    save(actor: SquareActor, userId: string, input: DonorEdit): Promise<DonorDetail>;
    history(actor: SquareActor, userId: string, input?: { cursor?: string | null; pageSize?: number | string | null }): Promise<DonorPage<DonationHistory>>;
    audit(actor: SquareActor, userId: string, input?: { cursor?: string | null; pageSize?: number | string | null }): Promise<DonorPage<DonorAudit>>;
};
