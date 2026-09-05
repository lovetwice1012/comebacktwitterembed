# Independent complete report generation

The report service calls `require('./dashboard/lib/admin-report-worker.cjs').buildReport({ kind, filters })` from the repository working directory. Supported kinds are `overview`, `analytics`, `guild-preview`, and `provider-preview`.

The function returns `{ kind, filters, report, generatedAt, definitionVersion, durationMs, complete: true }` only after every required query succeeds. `overview` includes the complete advanced analytics object. A failed optional SQL query is recorded by the strict report execution context and prevents publication of a partial result as complete.

No running Next server or dashboard build is required. Install the root dependencies and run `npm ci --prefix dashboard` without omitting development dependencies: the trusted source loader uses the installed TypeScript compiler and the generated Prisma client. The loader evaluates only repository dashboard modules, resolves their existing aliases, and handles the `server-only` marker without starting Next.

The core submits `reports.build` to its separate report worker URL, configured with `ADMIN_AGENT_REPORT_WORKER_URL`. Keep this service separate from the interactive analysis worker. Its request/worker deadline must allow the report builder's 600-second total budget; use at least 660 seconds. Individual SQL statements keep their existing `DASHBOARD_REPORT_QUERY_TIMEOUT_MS` limits and query concurrency controls.

When `ADMIN_AGENT_TOKEN` is configured in Next, all four existing admin report routes use the core's `/v1/reports/:kind` snapshots. Next's report prewarming is disabled. GET reads the last complete snapshot; a deduplicated POST queues generation. Refresh failure retains the last complete report and its failure metadata. A failed report waits for an explicit retry rather than retrying on every poll.

The headless loader wraps Prisma with `src/adminSupport/reportQueries.js`. Each SQL query keeps a dedicated transaction connection through query registration, cancellation coordination, and cleanup. Both report and interactive workers must share `ADMIN_QUERY_REGISTRY_DIR` (or the same `ADMIN_SUPPORT_DATA_DIR`). `diagnostics.queries` and `diagnostics.query.cancel` expose only registered queries and preserve the ownership checks.

The independent recovery route, `/api/admin/agent-recovery`, uses `ADMIN_AGENT_EXECUTOR_SOCKET` (default `/run/cbte-admin-executor/executor.sock`) and `ADMIN_OWNER_ID`. It permits only `agent.status` and `agent.restart`, requires a matching invocation ID for restart, and preserves the executor receipt key across an interrupted response. It does not require the core's HTTP endpoint or MySQL.

Local checks:

```text
npm run typecheck --prefix dashboard
npm run lint --prefix dashboard
node --test scripts/test/admin-report-worker.test.js scripts/test/admin-agent-recovery.test.js
node scripts/test-admin-dashboard-support.cjs
```

The SQL fixture tests cover observation collection time, duplicate snapshots, provider identity, missing latest values, and unavailable currency/scale aggregation. Deployment must also execute the report queries against the actual MySQL version and validate the complete snapshot response through the public admin routes.
