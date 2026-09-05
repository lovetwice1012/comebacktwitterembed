import { recordQueryFailure, reportLane, statementBudget, withSelectTimeout } from "./report-execution";
import { createHash } from "node:crypto";

export class QueryLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private concurrency = 4) {}

  async run<T>(query: () => PromiseLike<T>): Promise<T> {
    await new Promise<void>(resolve => {
      if (this.active < this.concurrency) {
        this.active++;
        resolve();
      } else this.waiting.push(resolve);
    });
    try { return await query(); }
    finally {
      const next = this.waiting.shift();
      if (next) next(); // Transfer the occupied slot before accepting new work.
      else this.active--;
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
              return await value.apply(target, [withSelectTimeout(args[0], budget), ...args.slice(1)]);
            }
            if (property === "$queryRaw" && Array.isArray(args[0])) {
              const query = Reflect.get(target, "$queryRawUnsafe", target);
              if (typeof query !== "function") throw new Error('Raw SQL execution is unavailable');
              return await query.apply(target, [withSelectTimeout(args[0].join('?'), budget), ...args.slice(1)]);
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
        return (...args: unknown[]) => reportLane() === "analytics" && heavyLimiter !== limiter
          ? heavyLimiter.run(() => run(...args)) : run(...args);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
