import type { createRateLimiter } from './rate-limits';
export function withRateOperation<T>(db: any, actor: { userId: string }, group: 'write' | 'monitor' | 'publication' | 'validate' | 'simulate', work: () => Promise<T> | T, options?: { rateLimiter?: Pick<ReturnType<typeof createRateLimiter>, 'consumeOperation'> }): Promise<T>;
