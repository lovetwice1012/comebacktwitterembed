# Read-only OCI workload logs

The emergency Web recovery tab reads the saved Bot, interactive worker and report worker output, including startup failures. The Go core exposes authenticated `GET /v1/recovery/workload-logs` and forwards only its controller status credential to the loopback controller's `GET /v1/workload-logs`.

Both endpoints accept only `component=bot|interactive|reports`, `archive=0..7`, `bytes=1..262144`, and `lines=1..1000`. Duplicate or extra fields and path selectors are rejected. The default is the current Bot log, the last 64 KiB and 200 lines. Archive 0 is current; 1 is the newest rotated archive. The configured retention count still limits archive selection.

The controller derives the path from its root-owned workload configuration and active-candidate pointer. It verifies the matching restore receipt, physical runtime directory, OCI origin marker and activation metadata. A root-owned candidate activation receipt can supply metadata if a crash interrupted the activation.json write. An older activation epoch for the same candidate remains readable and is identified as historical evidence. Paths, metadata and log files reject symlinks and non-private/non-root ownership.

Responses distinguish no activated candidate, absent runtime, absent activation metadata, absent log, empty log, and denied/unreadable evidence. The bounded tail includes full file size, returned and omitted bytes, line count, file timestamp, query truncation, partial first line and concurrent update/rotation indicators. Available archive metadata is included. Known controller, authority and management credentials are omitted from log text.

The matching `childLogs` record exposes received, written, dropped and trimmed bytes; rotations; write/read errors; and pending queue metadata when recorded by the wrapper. These counters describe saved evidence, while tail truncation describes the current query. Metadata is a persisted snapshot, so its activation update time is displayed. Text is assigned through textContent; log bytes are never rendered as HTML.

Deploy the updated controller source and workload_logs.py together. Do not interrupt an active database import merely to add the read endpoint. Until a safe controller restart loads it, the Go UI explicitly reports that the endpoint update is pending. Installing or querying this feature does not activate a candidate, alter policies, start a workload or change DNS.
