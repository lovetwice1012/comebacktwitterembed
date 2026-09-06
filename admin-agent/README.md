# Independent administration service

The Go binary includes the independent Japanese administration UI, authenticated API, SQLite event/action/incident/outbox store, deterministic monitor, Unix-socket executor mode and external witness mode. No LLM is used. The normal Next admin page proxies the same API after its existing owner-session check.

## Build and test

Use Go 1.25 or later. Dependencies are pinned by `go.mod` and `go.sum`; SQLite uses the pure-Go modernc driver and needs no system SQLite or CGO.

```sh
cd admin-agent
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o cbte-admin .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o cbte-admin-arm64 .
```

Do not put built binaries, `.env` credentials or the SQLite state directory in source control.

## Runtime separation

- `cbte-admin.service`: embedded Web/API, SQLite, monitoring, notifications. `/opt/cbte-admin/current/cbte-admin`; user `cbte-admin`; `/etc/cbte-admin/core.env`; state `/var/lib/cbte-admin`.
- `cbte-admin-analysis.service`: separate Node runtime process/cgroup handling the shared support worker over loopback HTTP. `ADMIN_AGENT_WORKER_URL=http://127.0.0.1:30990/execute`. Its durable receipt endpoint reconciles actions if the Go core restarts while a worker operation continues. Local CLI worker execution remains a development fallback.
- `cbte-admin-executor.service`: root-owned binary and state. Unix socket `/run/cbte-admin-executor/executor.sock`; peer UID must be root or configured numeric `ADMIN_AGENT_EXECUTOR_ALLOWED_UID`. `/etc/cbte-admin/executor.env` is root-owned and must not be editable by the core user.
- `cbte-admin-witness.service`: same binary with `witness` argument on a different host, its own SQLite/outbox and notification credentials. No owner API token is needed.

Unit files under `deploy/systemd` have no `Requires`, `BindsTo` or `PartOf` dependency on Bot/MySQL. `Type=notify` watchdog messages follow completed SQLite monitoring writes. External health fails when the monitoring loop has not persisted evidence for the configured period. Protect the worker runtime and its mutable data using the production release layout; do not broaden access to `/root`.

## Independent login and reverse proxy

The browser never receives `ADMIN_AGENT_TOKEN`. The normal owner-authenticated dashboard can set a standalone password via `POST /v1/account/password {password}`. It accepts 14–72 bytes and persists a bcrypt hash, invalidating all previous local sessions. The local login is independent of Discord OAuth, Bot and MySQL. A bootstrap hash may be generated with `cbte-admin password-hash` by passing the password on stdin; do not put a password in shell arguments or logs.

Session cookies are HttpOnly, SameSite=Strict and Secure by default. Mutations need the session CSRF token; trusted server calls use the shared token and validated owner principal instead. Failed login attempts are rate-limited. `ADMIN_AGENT_BASE_PATH=/ops` sets the cookie path to `/ops/`; all UI assets and API calls use relative paths. A reverse proxy must redirect `/ops` to `/ops/` then strip `/ops/` before forwarding to port 30988. `ADMIN_AGENT_COOKIE_SECURE=false` is for explicit HTTP-only local testing.

Example environment files are checked in with placeholders. Production files should be readable only by the responsible service. The executor only accepts the fixed Bot, management-core, analysis-worker and MySQL unit mappings. It never accepts an arbitrary command, path or unit from the browser.

## API contracts

Trusted calls authenticate with `X-Admin-Agent-Token` or `Authorization: Bearer ...`. `X-Admin-Actor`, when supplied, must equal `ADMIN_OWNER_ID`. Responses never expose the shared token, login hash or notification URL.

- `GET /healthz`: unauthenticated minimal core/storage-progress probe. It does not establish Bot/content/Discord health.
- `GET /v1/health`, `/v1/catalog`: health/capabilities and implemented operation inputs.
- `POST /v1/events`: one event, array, or `{events:[...]}`. SQLite transaction commits with `synchronous=FULL` before acknowledgement. Event IDs deduplicate producer retries. Maximum 500 records/24 MiB HTTP request/8 MiB encoded event; oversized data is explicitly rejected so the producer retains its spool.
- `GET /v1/events`: `guildId`, ISO `from`/`to`, `kind`, `runId`, `cursor`, `limit`. Full authenticated raw payloads are preserved. Times normalize to fixed-width UTC nanoseconds for ordering.
- `GET /v1/runs`: root request cohort by receipt time; filters `guildId`, `from`, `to`, `outcome=F,D,...`, `problematic=1`, `scope=all`, cursor, limit. Diagnostics/admin requests are excluded by default. `GET /v1/runs/:id` returns all related event evidence.
- `POST /v1/actions {type,input,idempotencyKey}` returns the durable action with HTTP 202. Repeated identical keys return the original action; conflicting inputs/actor are rejected. `GET /v1/actions` and `/:id` expose queue/running/succeeded/failed/unknown plus full result/error. Action cursor includes timestamp and ID so ties cannot drop records.
- `GET /v1/metrics`: exact root-request counts, F/(F+D+P+E+U+X), outcome/provider counts, exact nearest-rank per-outcome latency, distinct IDs, exclusions, coverage. A zero denominator is null. A missing terminal after ten minutes (or twice a longer worker deadline) is X; this does not claim a confirmed failure. The matching run list uses the same rule. Views/read receipts/link clicks are unsupported and never fabricated.
- `GET /v1/incidents`, `/:id`; `POST /:id/acknowledge`: persisted evidence-backed incidents and acknowledgement. Repeated observations do not enqueue repeated notifications. Recovery needs at least three positive observations over two minutes, with the recovered capability scope displayed.
- `GET/PUT /v1/policies`: expected revision required. Defaults observe/investigate; Bot auto-restart is disabled. All restart paths require fixed unit/current invocation identity and are capped to one per 15 minutes/three per 24 hours in the executor itself.
- `GET /v1/notifications`: per-channel pending/accepted state, retries, response and last error. Acceptance is not proof the administrator read a notification.

## Web support operations

Complete reports use a separate `cbte-admin-reports.service` and `ADMIN_AGENT_REPORT_WORKER_URL=http://127.0.0.1:30991/execute`, with a 660-second core deadline and a shorter worker deadline. Interactive support actions remain on their own queue. `GET /v1/reports/{overview|analytics|guild-preview|provider-preview}?filters=<JSON>` returns the last complete report plus cache/build/error metadata. `POST` with `{filters,force}` atomically queues a deduplicated job. Filters normalize before hashing; a failed refresh never erases the previous completed result. Report snapshots and receipts remain readable with Bot/MySQL stopped.

The owner can refresh reports from either Web interface. Only the overview refreshes on the policy interval (15 minutes by default). Detailed analytics, guild previews, and provider marketing previews generate only on an explicit request; viewing them, restarting the dashboard, and elapsed cache age never generate a new job. Their last complete result remains available until the next requested generation succeeds. Failed overview refreshes back off for at least an hour and only one report job runs at a time. Repeated I/O full-PSI pressure can hold new report jobs for five minutes with automatic expiry, leaving completed reports available. The policy explicitly exposes this pause and refresh behavior.

The standalone interface includes root-request/event search; URL execution with complete captured HTTP attempts and safe output preview; saved-response replay/settings comparison; server/channel resolution and explicit send review; field-based settings editing with expected hash; all worker catalog operations (autoextract, saved posts, quotas, delegated access, translation, bot-message deletion); diagnostics, policies, notifications and operation history. Result views retain raw exceptions, full fields and partial delivery receipts. Captured payloads and HTTP bodies are rendered as text, never executable HTML.

The independent URL inspector exposes a temporary settings override and a visible per-run enable checkbox. This allows disabled-by-default providers such as GitHub to be fetched without changing a server's persisted configuration. Other settings retain the actual selected server baseline. Context presets copy real target IDs from investigation/settings/previous execution; a live inspection still retrieves current Discord context, while unavailable channel/member/permission information is explicitly marked unverified. Registered X source selection and tri-state fallback controls apply only to X URLs.

The shared worker supports the real provider implementation. Its `{ok:false,error,events}` protocol is parsed even when Node exits nonzero; raw error causes and event evidence are not replaced by an exit-code-only message. Discord partial/unknown delivery is distinguished from successful diagnostic capture.

## Monitoring and repair boundaries

The core records systemd state/identity/result, Bot heartbeat age, local/public HTTP probes, Linux meminfo/load/PSI/disk capacity and the known Bot process's status/I/O/FD count. Bounded deep diagnosis additionally gathers unit/kernel journal, diskstats/vmstat and MySQL unit state. The worker's DB action records each query's success/error; PROCESS permission limitations remain visible.

Rules distinguish stopped process, stale progress, failed local HTTP, local-success/public-failure and management storage pressure. Every result carries the evidence event and rule version. Unknown heartbeat does not imply healthy or hung. Auto-restart requires a current process whose PID matches recorded telemetry, stale heartbeat, repeated failed local probes, fresh independent successful DB connection diagnosis, no maintenance intent and restart-budget capacity. Normal process-exit restarts remain systemd's responsibility. Worker CLI failures are never blindly retried.

External witness probes `ADMIN_WITNESS_TARGET` every 15 seconds, confirms after four failures, and uses its own durable outbox. It does not distinguish host power loss from network/tunnel/daemon failure without more evidence. Discord webhook and an optional generic JSON webhook work without the Bot's Discord client. Notification transport timeouts record possible duplicate delivery on retry rather than falsely claiming exactly once.

Journal collection advances per-entry cursors only after durable event persistence, in bounded 200-row/4 MiB batches. Bot, MySQL, nginx, management core, analysis and kernel streams retain boot IDs and continue across boots when the host retains persistent journals. Initial collection starts five minutes before installation. Cursor state and collection errors are visible in health; rotated-away journals cannot be reconstructed. The forward-follow collector uses the documented [journalctl cursor and follow flags](https://www.freedesktop.org/software/systemd/man/255/journalctl.html).

The owner can enroll and use origin-bound WebAuthn passkeys as well as the independent password login. Managed query cancellation accepts only registered query IDs and rechecks the current database statement, connection ownership and deadline; automatic cancellation always requires an overdue owned query. Provider-source overrides use an allowlisted source ID and expiry, with registry/revision details visible through the support catalog. Unclassified failures retain their evidence and open questions for manual investigation; an arbitrary command runner is not used as a substitute for a diagnosis.

State has no automatic destructive purge. Disk-capacity warnings and durable outbox expose growth; deployment must provision and back up the dedicated state directory. SQLite backup should use the online backup interface or copy only while the service is stopped, accounting for its WAL.
