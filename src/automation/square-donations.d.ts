import type { SquareActor } from './square-billing';
export interface DonationPolicy { enabled: boolean; currency: string | null; minimumAmount: number | null; maximumAmount: number | null; supporterThreshold: number | null; validityDays: number | null; unitAmount: number | null; slotsPerUnit: number | null; updatedAtMs: number | null }
export interface DonationOptions extends DonationPolicy { configured: boolean; environment: 'sandbox' | 'production' | null; applicationId?: string; locationId?: string; minorUnitDigits: number | null }
export interface DonationQuote { attemptId: string; expiresAtMs: number; amount: number; currency: string; minorUnitDigits: number; email: string; name: string }
export interface DonationHistory { attemptId: string; state: string; amount: number; currency: string; refundedAmount: number; netAmount: number; verified: boolean; createdAtMs: number; completedAtMs: number | null }
export interface DonationGrant { active: boolean; threshold: number | null; validityDays: number | null; netAmount: number; validUntilAtMs: number | null; unitAmount: number | null; slotsPerUnit: number | null; purchaseUnits: number; extraSlots: number; paymentCount: number; unitsValidUntilAtMs: number | null }
export interface DonationSupporter extends DonationGrant { manualActive: boolean }
export interface DonationStatus { configured: boolean; environment: 'sandbox' | 'production' | null; history: DonationHistory[]; pending: null | (DonationQuote & { state: string; retryable: boolean }); supporter: DonationSupporter; refresh?: { state: 'checked' | 'cooldown' | 'busy' | 'failed'; retryAtMs: number | null } }
export function createSquareDonations(db: { queryDatabase: Function; withDatabaseTransaction: Function }, options?: { env?: Record<string, string | undefined>; fetch?: typeof fetch; clock?: () => number }): {
    getOptions(actor: SquareActor): Promise<DonationOptions>;
    getStatus(actor: SquareActor): Promise<DonationStatus>;
    getAdmin(actor: SquareActor): Promise<{ configured: boolean; environment: 'sandbox' | 'production' | null; missing: string[]; policy: DonationPolicy; locationCurrency?: string | null; minorUnitDigits: number | null }>;
    savePolicy(actor: SquareActor, input: Omit<DonationPolicy, 'updatedAtMs' | 'unitAmount' | 'slotsPerUnit'> & { expectedUpdatedAtMs: number | null; unitAmount?: number | null; slotsPerUnit?: number | null }): Promise<DonationPolicy>;
    createQuote(actor: SquareActor, input: { amount: number; email: string; name: string }): Promise<DonationQuote>;
    donate(actor: SquareActor, input: { attemptId: string; sourceId: string; consent: boolean }): Promise<DonationStatus>;
    getAttempt(actor: SquareActor, attemptId: string): Promise<DonationHistory & { quote: DonationQuote }>;
    handleVerifiedWebhook(event: unknown, query: Function): Promise<void>;
};
export function isSquareDonationSupporter(query: Function, owner: string, now?: number, scope?: { configured: boolean; environment: 'sandbox' | 'production' | null; merchantId: string | null }): Promise<boolean>;
export function getSquareDonationGrant(query: Function, owner: string, now?: number, scope?: { configured: boolean; environment: 'sandbox' | 'production' | null; merchantId: string | null }): Promise<DonationGrant>;
