# OCI emergency Web service controls

The independent Go core and root executor use `ADMIN_AGENT_SERVICE_PROFILE=oci-guarded` and `ADMIN_AGENT_BOT_UNIT=cbte-recovery-workload.service`. The profile is also inferred from `RECOVERY_NODE=oci`; overriding it with the primary profile is rejected.

Bot start, stop and restart target the guardian's systemd unit. The Go core durably synchronizes operator intent with the recovery controller before these operations. Starting the unit only starts lease supervision: Discord readiness and the active fleet lease remain separate checks. Stopping or restarting affects the Bot, normal dashboard, interactive worker and report worker together. The independent Go core continues running.

The OCI executor accepts only root or the configured `cbte-admin` peer UID over its group-owned Unix socket. Fixed unit selection, invocation matching, bounded commands, durable receipts and restart limits remain enforced. `agent.status` and `agent.restart` address the real independent `cbte-admin.service`.

OCI does not have independent `mysql.service` or analysis/report worker units. Their unit status/restart operations and their individual previous-boot journal sources are explicitly unavailable in the action catalog, Web form, API, queued-action execution and root executor. MySQL connectivity remains available through `diagnostics.db`. Worker HTTP evidence and the guardian group remain available through technical diagnostics. Individual worker file logs and Docker MySQL logs are not represented as unit journals.

The emergency recovery tab reads bounded Bot, interactive worker and report worker file tails through the root-verified controller bridge described in [WORKLOAD-LOGS.md](WORKLOAD-LOGS.md). It displays startup failures, retained archives, query truncation and saved-log loss metadata. Docker MySQL logs remain outside this file-log endpoint.

The OCI monitor does not raise absent-worker incidents while operator policy says stopped/maintenance, and never queues independent analysis-service restarts. Unsupported unit journal collectors report `not_applicable`. Primary installations retain the existing full systemd controls.

Install `systemd/cbte-admin-executor.service` with a root-owned mode-0600 `/etc/cbte-recovery/admin/executor.env` based on `oci-executor.env.example`. Set the actual `cbte-admin` UID/GID and enable the executor. The core environment must use the same service profile, Bot unit, and Unix socket. This installation does not start the Bot workload or change fleet ownership.
