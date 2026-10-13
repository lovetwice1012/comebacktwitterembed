import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDashboardFleetWriteFence, readDashboardFleetAuthority } from "@/lib/fleet-authority";

type Query = (sql: string, params?: unknown[], options?: unknown) => Promise<any>;
type BotDatabase = { queryDatabase: Query; withDatabaseTransaction: (work: (query: Query) => Promise<any>) => Promise<any>; [key: string]: any };

/** Keep the shared Bot stores, with dashboard-scoped authority at their SQL boundary. */
export function guardedDashboardDatabase(db: BotDatabase): BotDatabase {
  const fences = new AsyncLocalStorage<() => void>();
  const runTransaction = async (work: (query: Query) => Promise<any>) => {
    const fence = fences.getStore() || createDashboardFleetWriteFence();
    return db.withDatabaseTransaction(async query => fences.run(fence, async () => {
      fence();
      const checkedQuery: Query = async (...args) => { fence(); return query(...args); };
      const result = await work(checkedQuery);
      // The base store commits only after this callback resolves. An expired or
      // replaced guardian instance throws here, causing the base DB rollback.
      fence();
      return result;
    }));
  };
  const queryDatabase: Query = async (sql, params, options) => {
    const fence = fences.getStore();
    if (fence) { fence(); return db.queryDatabase(sql, params, options); }
    if (/^\s*(?:SELECT|SHOW|EXPLAIN|DESCRIBE|DESC)\b/i.test(sql)) return db.queryDatabase(sql, params, options);
    if (!readDashboardFleetAuthority().managed) return db.queryDatabase(sql, params, options);
    return runTransaction(query => query(sql, params, options));
  };
  return { ...db, queryDatabase, withDatabaseTransaction: runTransaction };
}
