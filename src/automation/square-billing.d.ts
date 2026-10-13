export interface SquareActor { userId: string; isAdmin?: boolean }
export interface SquareVariation { variationId: string; catalogName: string; cadence: string; amount: number; currency: string; billingAnchorDay?: number | null; canProrate?: boolean }
export interface SquareBinding extends SquareVariation { planId: string; enabled: boolean; verifiedAtMs: number }
export interface SquarePlan extends SquareBinding { label: string; slotLimit: number; minuteLimit: number; dayLimit: number; priority: number; firstAmount?: number; regularAmount?: number; coupon?: import('./square-commerce').CouponTerms }
export interface SquareOptions { configured: boolean; environment: 'sandbox' | 'production' | null; applicationId?: string; locationId?: string; plans: SquarePlan[] }
export interface SquareQuote { checkoutId: string; expiresAtMs: number; plan: SquarePlan; email: string; name: string }
export interface SquareStatus {
    configured: boolean;
    environment: 'sandbox' | 'production' | null;
    subscription: null | { planId: string; label: string; state: string; paidThroughAtMs: number | null; validUntilAtMs: number | null; canceledDate: string | null; active: boolean; cancelScheduled: boolean };
    pending: null | { checkoutId: string; state: string; retryable: boolean; resumeAllowed: boolean; abortAllowed: boolean; quote: SquareQuote };
    refresh: { state: 'checked' | 'busy' | 'cooldown' | 'failed'; retryAtMs: number };
    verificationWarning?: { code: 'SQUARE_PRORATION_UNVERIFIED'; message: string };
}
export function getSquareScope(env?: Record<string, string | undefined>): { configured: boolean; environment: 'sandbox' | 'production' | null; merchantId: string | null };
export function createSquareClient(options?: { env?: Record<string, string | undefined>; fetch?: typeof fetch; clock?: () => number }): {
    config: { configured: boolean; missing: string[]; environment: 'sandbox' | 'production' | null; accessToken?: string; applicationId?: string; locationId?: string; merchantId?: string; signatureKey?: string; notificationUrl?: string; baseUrl: string };
    scope: Array<string | null | undefined>;
    now: () => number;
    requireConfigured: () => void;
    request: (method: string, path: string, body?: Record<string, any>) => Promise<any>;
    location: (read?: (method: string, path: string, body?: Record<string, any>) => Promise<any>) => Promise<any>;
};
export function createSquareBilling(db: { queryDatabase: Function; withDatabaseTransaction: Function }, options?: { env?: Record<string, string | undefined>; fetch?: typeof fetch; clock?: () => number }): {
    getOptions(actor: SquareActor): Promise<SquareOptions>;
    getStatus(actor: SquareActor): Promise<SquareStatus>;
    getAdmin(actor: SquareActor): Promise<{ configured: boolean; environment: 'sandbox' | 'production' | null; missing: string[]; bindings: SquareBinding[]; availableVariations: SquareVariation[] }>;
    saveBinding(actor: SquareActor, planId: string, input: { variationId: string; enabled: boolean; expectedVerifiedAtMs: number | null }): Promise<SquareBinding>;
    createQuote(actor: SquareActor, input: { planId: string; email: string; name: string; couponCode?: string }): Promise<SquareQuote>;
    subscribe(actor: SquareActor, input: { checkoutId: string; sourceId: string; consent: boolean }): Promise<SquareStatus>;
    resume(actor: SquareActor, input: { checkoutId: string; consent: boolean }): Promise<SquareStatus>;
    abort(actor: SquareActor, input: { checkoutId: string }): Promise<SquareStatus>;
    cancel(actor: SquareActor): Promise<SquareStatus>;
    handleWebhook(rawBody: string | Buffer, signature: string): Promise<{ accepted: boolean; duplicate: boolean }>;
};
export function verifyWebhookSignature(rawBody: string | Buffer, signature: string, signatureKey: string, notificationUrl: string): boolean;
export function dateEnd(date: string, timezone: string): number | null;
export const API_VERSION: string;
export function isValidReceiptEmail(email: string): boolean;
export function validateVariation(object: any, locationId?: string): SquareVariation & { catalogVersion: string };
