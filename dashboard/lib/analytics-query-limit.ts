import { recordQueryFailure, reportLane, reportResourceHints, statementBudget, withSelectTimeout } from "./report-execution";
import { createHash } from "node:crypto";
import { compactUniqueMembershipCount } from "./unique-membership-query";

export class QueryLimiter {
  private active = 0;
  private waiting: Array<{ weight: number; resolve: () => void }> = [];
  constructor(private concurrency = 4) {}
  get capacity() { return this.concurrency; }

  private drain() {
    while (this.waiting.length && this.active + this.waiting[0].weight <= this.concurrency) {
      const next = this.waiting.shift()!;
      this.active += next.weight;
      next.resolve();
    }
  }

  async run<T>(query: () => PromiseLike<T>, requestedWeight = 1): Promise<T> {
    const weight = Math.max(1, Math.min(this.concurrency, Math.floor(requestedWeight) || 1));
    await new Promise<void>(resolve => {
      this.waiting.push({ weight, resolve });
      this.drain();
    });
    try { return await query(); }
    finally {
      this.active -= weight;
      this.drain();
    }
  }
}

export function limitAnalyticsReads<T extends object>(client: T, limiter: QueryLimiter, heavyLimiter = limiter): T {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value === "function" && (property === "$queryRaw" || property === "$queryRawUnsafe")) {
        const run = (...args: unknown[]) => limiter.run(async () => {
          const startedAt = Date.now();
          try {
            const budget = statementBudget();
            if (property === "$queryRawUnsafe" && typeof args[0] === "string") {
              return await value.apply(target, [withSelectTimeout(compactUniqueMembershipCount(args[0]), budget, reportResourceHints), ...args.slice(1)]);
            }
            if (property === "$queryRaw" && Array.isArray(args[0])) {
              const query = Reflect.get(target, "$queryRawUnsafe", target);
              if (typeof query !== "function") throw new Error('Raw SQL execution is unavailable');
              return await query.apply(target, [withSelectTimeout(compactUniqueMembershipCount(args[0].join('?')), budget, reportResourceHints), ...args.slice(1)]);
            }
            return await value.apply(target, args);
          } catch (error) { recordQueryFailure(error); throw error; }
          finally {
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= 5000 || process.env.DASHBOARD_REPORT_PROFILE === '1') {
              const sql = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]);
              console.log('[adminAnalyticsQuery]', JSON.stringify({
                elapsedMs, key: createHash('sha256').update(sql).digest('hex').slice(0, 12),
                sql: sql.replace(/\s+/g, ' ').slice(0, 180),
              }));
            }
          }
        });
        return (...args: unknown[]) => {
          const sql = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]);
          const requestedTempBytes = Number(compactUniqueMembershipCount(sql).match(/SET_VAR\(\s*tmp_table_size\s*=\s*(\d+)/i)?.[1] || 0);
          const weight = requestedTempBytes > 268435456 ? heavyLimiter.capacity : 1;
          return reportLane() === "analytics" && heavyLimiter !== limiter
            ? heavyLimiter.run(() => run(...args), weight) : run(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
