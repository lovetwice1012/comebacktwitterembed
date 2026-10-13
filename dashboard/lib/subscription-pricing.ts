type SubscriptionPrice = { amount: number; currency: string };
type SubscriptionIntervalPrice = SubscriptionPrice & { cadence: string };

export const subscriptionCadenceLabels: Record<string, string> = {
  DAILY: "毎日", WEEKLY: "毎週", EVERY_TWO_WEEKS: "2週間ごと",
  THIRTY_DAYS: "30日ごと", SIXTY_DAYS: "60日ごと", NINETY_DAYS: "90日ごと",
  MONTHLY: "毎月", EVERY_TWO_MONTHS: "2か月ごと", QUARTERLY: "3か月ごと",
  EVERY_FOUR_MONTHS: "4か月ごと", EVERY_SIX_MONTHS: "6か月ごと",
  ANNUAL: "毎年", EVERY_TWO_YEARS: "2年ごと",
};
export const subscriptionIntervalLabels: Record<string, string> = {
  DAILY: "日額", WEEKLY: "週額", EVERY_TWO_WEEKS: "2週間払い",
  THIRTY_DAYS: "30日払い", SIXTY_DAYS: "60日払い", NINETY_DAYS: "90日払い",
  MONTHLY: "月額", EVERY_TWO_MONTHS: "2か月払い", QUARTERLY: "3か月払い",
  EVERY_FOUR_MONTHS: "4か月払い", EVERY_SIX_MONTHS: "6か月払い",
  ANNUAL: "年額", EVERY_TWO_YEARS: "2年払い",
};
// Multipliers convert one complete recurring charge into monthly minor units.
// Day and week intervals use a 30-day month only as a comparison estimate.
const monthlyRatios: Record<string, readonly [number, number]> = {
  DAILY: [30, 1], WEEKLY: [30, 7], EVERY_TWO_WEEKS: [30, 14],
  THIRTY_DAYS: [1, 1], SIXTY_DAYS: [1, 2], NINETY_DAYS: [1, 3],
  MONTHLY: [1, 1], EVERY_TWO_MONTHS: [1, 2], QUARTERLY: [1, 3],
  EVERY_FOUR_MONTHS: [1, 4], EVERY_SIX_MONTHS: [1, 6], ANNUAL: [1, 12], EVERY_TWO_YEARS: [1, 24],
};
function validPrice(plan: SubscriptionPrice) {
  return Number.isSafeInteger(plan.amount) && plan.amount >= 0 && /^[A-Z]{3}$/.test(plan.currency);
}
function formatMinorUnits(amount: number, currency: string, converted = false): string {
  try {
    const scale = new Intl.NumberFormat("ja-JP", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat("ja-JP", { style: "currency", currency, ...(converted ? { minimumFractionDigits: scale, maximumFractionDigits: Math.max(scale, 2) } : {}) }).format(amount / 10 ** scale);
  } catch { return "料金を確認できません"; }
}
export function subscriptionPrice(plan: SubscriptionPrice): string {
  return validPrice(plan) ? formatMinorUnits(plan.amount, plan.currency) : "料金を確認できません";
}
export function subscriptionMonthlyAmount(plan: SubscriptionIntervalPrice): number | null {
  const ratio = Object.hasOwn(monthlyRatios, plan.cadence) ? monthlyRatios[plan.cadence] : undefined;
  return validPrice(plan) && ratio ? plan.amount * ratio[0] / ratio[1] : null;
}
export function subscriptionMonthlyPrice(plan: SubscriptionIntervalPrice): string {
  const amount = subscriptionMonthlyAmount(plan);
  return amount === null ? "料金を確認できません" : formatMinorUnits(amount, plan.currency, true);
}
export function subscriptionMonthlyApproximate(cadence: string): boolean {
  return ["DAILY", "WEEKLY", "EVERY_TWO_WEEKS", "THIRTY_DAYS", "SIXTY_DAYS", "NINETY_DAYS"].includes(cadence);
}
export function compareSubscriptionMonthlyPrices(a: SubscriptionIntervalPrice, b: SubscriptionIntervalPrice): number {
  // Different currencies are not comparable without an exchange rate. Keep them
  // in separate stable currency groups, and never round amounts before sorting.
  if (a.currency !== b.currency) return a.currency.localeCompare(b.currency, "en");
  const aRatio = validPrice(a) && Object.hasOwn(monthlyRatios, a.cadence) ? monthlyRatios[a.cadence] : undefined;
  const bRatio = validPrice(b) && Object.hasOwn(monthlyRatios, b.cadence) ? monthlyRatios[b.cadence] : undefined;
  if (!aRatio || !bRatio) return aRatio ? -1 : bRatio ? 1 : 0;
  const aScaled = BigInt(a.amount) * BigInt(aRatio[0]) * BigInt(bRatio[1]);
  const bScaled = BigInt(b.amount) * BigInt(bRatio[0]) * BigInt(aRatio[1]);
  return aScaled < bScaled ? -1 : aScaled > bScaled ? 1 : 0;
}
export function sortSubscriptionMonthlyPrices<T extends SubscriptionIntervalPrice>(plans: readonly T[]): T[] {
  return [...plans].sort(compareSubscriptionMonthlyPrices);
}
