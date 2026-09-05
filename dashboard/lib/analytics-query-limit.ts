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

export function limitAnalyticsReads<T extends object>(client: T, limiter: QueryLimiter): T {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value === "function" && (property === "$queryRaw" || property === "$queryRawUnsafe")) {
        return (...args: unknown[]) => limiter.run(() => value.apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
