import "server-only";
import tables from "../../src/table-count-tables.json";

export const countedTables = new Set(tables.map(item => item.table));

export async function loadExactTableCounts(query: (sql: string) => Promise<Array<Record<string, unknown>>>) {
  const rows = await query(`SELECT b.table_name, b.ready, b.counter_version,
      b.baseline_count + COALESCE(SUM(d.delta), 0) AS row_count
    FROM bot_table_count_baselines b
    LEFT JOIN bot_table_count_deltas d ON d.table_name=b.table_name
    GROUP BY b.table_name, b.ready, b.counter_version, b.baseline_count`);
  const result = new Map<string, number>();
  for (const row of rows) {
    const name = String(row.table_name);
    if (!countedTables.has(name)) continue;
    const count = Number(row.row_count);
    if (Number(row.ready) !== 1 || Number(row.counter_version) !== 1 || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Exact table count is not ready: ${name}`);
    }
    result.set(name, count);
  }
  for (const table of countedTables) if (!result.has(table)) throw new Error(`Exact table count is missing: ${table}`);
  return result;
}
