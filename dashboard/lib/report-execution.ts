import { AsyncLocalStorage } from "node:async_hooks";

type Execution = { deadline: number; failure: Error | null; lane: "analytics" | "overview" };
const executions = new AsyncLocalStorage<Execution>();
const configured = Number(process.env.DASHBOARD_REPORT_QUERY_TIMEOUT_MS);
export const queryTimeoutMs = Number.isInteger(configured) && configured >= 1000 && configured <= 300000 ? configured : 120000;
export const reportResourceHints = [
  'SET_VAR(tmp_table_size=268435456)',
  'SET_VAR(max_heap_table_size=67108864)',
  'SET_VAR(sort_buffer_size=4194304)',
];

export function statementBudget() {
  const execution = executions.getStore();
  if (execution?.failure) throw execution.failure;
  const remaining = execution ? execution.deadline - Date.now() : queryTimeoutMs;
  if (remaining <= 0) throw new Error('Report generation exceeded its time budget.');
  return Math.min(queryTimeoutMs, remaining);
}

export function recordQueryFailure(reason: unknown) {
  const execution = executions.getStore();
  if (execution && !execution.failure) execution.failure = reason instanceof Error ? reason : new Error(String(reason));
}

export function reportLane() { return executions.getStore()?.lane; }

export async function runReportBuild<T>(build: () => Promise<T>, lane: "analytics" | "overview" = "analytics"): Promise<T> {
  return executions.run({ deadline: Date.now() + 600000, failure: null, lane }, async () => {
    const value = await build();
    const failure = executions.getStore()?.failure;
    if (failure) throw failure;
    return value;
  });
}

// Find the top-level SELECT, including WITH queries. Hints inside a CTE do
// not bound the outer query. Never alter bound parameter values.
export function withSelectTimeout(sql: string, milliseconds: number, resources: string[] = []) {
  const timeout = Math.max(1, Math.floor(milliseconds));
  let depth = 0;
  let quote = '';
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (quote) {
      if (char === '\\') { index++; continue; }
      if (char === quote) {
        if (sql[index + 1] === quote) index++;
        else quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw new Error('Unclosed SQL comment');
      index = end + 1;
      continue;
    }
    if (sql.startsWith('--', index) || char === '#') {
      const end = sql.indexOf('\n', index);
      if (end < 0) break;
      index = end;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && /^select\b/i.test(sql.slice(index)) && (index === 0 || !/[\w]/.test(sql[index - 1]))) {
      const end = index + 6;
      const suffix = sql.slice(end);
      const existingHint = /^\s*\/\*\+/.test(suffix) ? suffix.split('*/')[0] : '';
      const explicitVariables = new Set([...existingHint.matchAll(/SET_VAR\(\s*(\w+)\s*=/gi)].map(match => match[1].toLowerCase()));
      const defaults = resources.filter(hint => {
        const variable = hint.match(/^SET_VAR\(\s*(\w+)\s*=/i)?.[1]?.toLowerCase();
        return !variable || !explicitVariables.has(variable);
      });
      const hints = `MAX_EXECUTION_TIME(${timeout})${defaults.length ? ' ' + defaults.join(' ') : ''}`;
      if (/^\s*\/\*\+/.test(suffix)) {
        // Existing optimizer hints must remain in a single hint comment.
        if (/^\s*\/\*\+[^]*?MAX_EXECUTION_TIME\s*\(/i.test(suffix.split('*/')[0])) {
          return sql.slice(0, end) + suffix.replace(/MAX_EXECUTION_TIME\s*\(\s*\d+\s*\)/i, hints);
        }
        return sql.slice(0, end) + suffix.replace('/*+', `/*+ ${hints}`);
      }
      return `${sql.slice(0, end)} /*+ ${hints} */${suffix}`;
    }
  }
  return sql;
}
