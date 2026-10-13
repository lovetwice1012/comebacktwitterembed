# Dashboard service independent of Bot restarts

`cbte-dashboard.service` owns the HTTP process and its Next child. It has no
`PartOf`, `BindsTo`, or `Requires` relationship with `cbte.service`. A routine Bot
restart therefore preserves the dashboard service, listener, and HTTP process.
The Bot uses `DASHBOARD_MANAGED_EXTERNALLY=true` (or
`dashboard.managedExternally: true`) to skip dashboard preparation, spawning,
and stopping. It still configures integrated media delivery before its ready
handlers run, preventing a second listener from opening on the origin port.

The independent service runs `start-dashboard.js serve`, which selects an
already built `.next-builds/current.json` (or existing legacy `.next`) and never
builds, regenerates Prisma, or prunes builds during startup. Its existing build
pointer watcher restarts only Next after explicit build activation. Systemd
`Restart=always` recovers unexpected Next/wrapper exits. Keep the old build and
pointer for rollback; never delete a selected build or a symlink target.

## Fleet authority

Install this service only together with the dashboard shared-current authority
guard. `/etc/cbte-dashboard/environment.json` must supply `CBTE_FLEET_NODE` and
`CBTE_FLEET_LEASE_FILE`, using the current guardian lease file. Do not pin
`CBTE_FLEET_EPOCH` to the old Bot invocation. In `shared-current` mode the
dashboard rechecks the latest lease for mutations and accepts a renewed valid
epoch/instance after the Bot restarts. When authority is absent or invalid,
HTTP/UI stay reachable and mutations return a retryable 503. HTTP reachability
and authority availability are separate health fields.

The dashboard must not be added to the guardian's forced Bot-workload companion
list. The guardian continues to fence Bot/worker side effects; dashboard writes
are fenced by its lease guard. Ordinary Bot restarts do not grant write
authority during lease reacquisition.

## Deployment and rollback

1. Create a stable, versioned dashboard source/runtime under
   `/opt/cbte-dashboard/releases/`, including the verified build and current
   pointer. Its config/data/backend references must remain valid across Bot
   release changes. Point `/opt/cbte-dashboard/current` at this release.
2. Create the root-owned mode-0600 JSON environment file without copying credentials into
   command arguments or logs. Set `DASHBOARD_RUNTIME_ENV_FILE` to this file.
   Explicit service environment settings take priority over captured values.
   Preserve the canonical origin and port. Install
   the shared-current lease guard and test degraded/reacquisition behavior.
3. Validate the independent service on a temporary loopback port. Verify UI,
   reads, blocked writes during an invalid lease, and writes after a valid new
   lease. Stop only the temporary probe afterward.
4. Configure the Bot for external dashboard management. Stop only its old
   dashboard wrapper/Next pair when handing the origin listener to the
   independent service. Start, enable for host boot, and verify
   `cbte-dashboard.service`. The service binds its new port to `127.0.0.1` using
   `DASHBOARD_HOSTNAME`, with Nginx owning public access.
5. Verify the Bot PID and dashboard service PID, then perform an authorized
   ordinary Bot restart. Dashboard PID/listener and HTTP responses must remain
   available. Confirm the write guard blocks the lease gap and accepts the new
   valid lease without restarting dashboard.

Rollback service ownership by stopping the independent dashboard unit, removing
the Bot's external-management override, and returning to the verified prior
dashboard source/build. That ownership rollback needs an explicitly planned
Bot restart; ordinary UI build rollback only changes the independent service's
build pointer and leaves Bot running.

After isolation, every build selected by the independent service must include
the shared-current authority guard. The earlier account-preview v1/v2 builds
predate that guard and cannot be selected as standalone service rollbacks.
Their verified static assets may be retained for existing browser tabs. Users
can return to the frozen legacy presentation through the UI preference without
removing the authority guard or changing service ownership.

## Installer transaction

`scripts/dashboard-independent-deploy.py prepare` checks the reviewed artifact
report, build ID, guardian/Bot/wrapper/Next identities, release paths, and process
ancestry. It requires a new backup directory and absent installation targets,
captures the current Next environment into private JSON, installs the independent
unit, and verifies its loopback health. Public Nginx routing and Bot settings are
unchanged in this step.

Run `promote` with the same arguments and backup directory after reviewing that
prepared service. It saves both existing Nginx configurations as mode-0600 files,
changes exactly one dashboard upstream in each, validates and reloads Nginx, and
checks both loopback and canonical public health. Only then does it install the
old-Bot-compatible external-management drop-in, enable the dashboard for host
boot, and signal the exact old dashboard wrapper. It never restarts Bot.

Both commands require `--stage-root`, `--artifact-report`,
`--expected-artifact-report-sha256`, `--expected-build-id`,
`--expected-bot-main-pid`, `--expected-bot-workload-pid`,
`--expected-wrapper-pid`, `--expected-next-pid`, `--expected-live-release`,
`--unit-source`, and `--backup-dir`. The default new port is 31089 and the default
canonical origin is `https://cbte.sprink.cloud`.

The verified production migration on 2026-10-13 uses **31089** because 30990
already belongs to the independent report process. Both Nginx dashboard
upstreams now target 127.0.0.1:31089. Evidence and preserved origin configs are
under `docs/qa/dashboard-independent-2026-10-13/production/` and
`/var/backups/cbte/dashboard-independent-20261013-v3`, respectively.

Failures before ownership handoff restore only the transaction's own Nginx
changes, drop-in, and enable state. Concurrent Nginx edits are preserved and
reported as rollback conflicts. After the old wrapper receives its stop signal,
the installer keeps the verified new upstream serving even if writing the final
metadata fails. Old source and builds are always retained.
