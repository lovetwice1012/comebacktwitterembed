import type { SquareActor, SquareVariation } from './square-billing';
export interface CatalogCreation { creationId: string; planId: string; name: string; cadence: string; amount: number; currency: string; state: string; variationId: string | null; expiresAtMs: number; retryable: boolean }
export interface Coupon { code: string; label: string; type: 'fixed' | 'percent'; value: number; currency: string | null; planIds: string[]; enabled: boolean; expiresAtMs: number | null; totalLimit: number | null; userLimit: number | null; updatedAtMs: number; used: number; reserved: number }
export interface CouponTerms { code: string; label: string; type: 'fixed' | 'percent'; value: number; discountAmount: number; updatedAtMs: number; firstAmount: number; regularAmount: number; currency: string; cadence: string }
export function validateCouponVariation(object: any, locationId: string | undefined, terms: CouponTerms): SquareVariation & { catalogVersion: string; firstAmount: number; regularAmount: number };
export function createSquareCommerce(db: { queryDatabase: Function; withDatabaseTransaction: Function }, options?: { env?: Record<string, string | undefined>; fetch?: typeof fetch; clock?: () => number }): {
    getAdmin(actor: SquareActor): Promise<{ configured: boolean; environment: 'sandbox' | 'production' | null; locationCurrency: string | null; minorUnitDigits: number | null; coupons: Coupon[]; creations: CatalogCreation[] }>;
    createCatalogQuote(actor: SquareActor, input: { planId: string; name: string; cadence: string; amount: number; currency: string }): Promise<CatalogCreation>;
    confirmCatalogCreation(actor: SquareActor, input: { creationId: string; consent: boolean }): Promise<CatalogCreation>;
    getCatalogCreation(actor: SquareActor, creationId: string): Promise<CatalogCreation>;
    getCreation(actor: SquareActor, creationId: string): Promise<CatalogCreation>;
    saveCoupon(actor: SquareActor, input: Omit<Coupon, 'updatedAtMs' | 'used' | 'reserved'> & { expectedUpdatedAtMs: number | null }): Promise<Coupon>;
    resolveCoupon(code: string, plan: any, query?: Function, locked?: boolean): Promise<CouponTerms>;
    couponVariation(terms: CouponTerms, base: any): Promise<SquareVariation & { catalogVersion: string; firstAmount: number; regularAmount: number }>;
    reserveCoupon(query: Function, owner: string, checkoutId: string, terms: CouponTerms, plan: any, expiresAt: number): Promise<void>;
    assertCouponCurrent(quote: any, plan: any): Promise<void>;
    couponStage(query: Function, quote: any, state: string): Promise<void>;
    confirmInvoice(query: Function, quote: any, subscription: any, invoice: any): Promise<number>;
};
