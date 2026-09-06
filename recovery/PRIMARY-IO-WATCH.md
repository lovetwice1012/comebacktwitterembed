# Opt-in primary I/O stall coverage

This source feature is **off by default and is not deployed or enabled by this change**. It addresses the observed case where the primary guardian can still renew over the network while its Bot child is stuck in uninterruptible disk I/O. It does not tune WBT, reset storage, reboot, run a shell, or add a second process-killing implementation.

After the primary kernel/storage incident is resolved, an approved maintenance deployment may add this policy to the root-owned primary guardian configuration:

```json
"primaryIoWatch": {
  "enabled": true,
  "physicalDevice": "sda",
  "logicalDevice": "dm-0",
  "thresholdSeconds": 180,
  "startupGraceSeconds": 300
}
```

The policy is accepted only for the primary and these fixed device names. Verify that they still identify the intended backing block device and root logical volume before enabling it. Thresholds below 180 seconds or a startup grace below 300 seconds are rejected. Both values have a maximum of 86400 seconds. No installer or OCI configuration generator enables the policy automatically.

The guardian samples every five seconds. It reads the exact direct child PID's `/proc/PID/stat` both before and after the bounded device reads, requiring its PPID to match the guardian and retaining the original process start ticks. PID reuse or a different parent cannot establish a new identity within the existing watch. Each sample reads only that process, `/proc/diskstats`, and the already-available `/sys/kernel/debug/block/sda/rqos/wbt/inflight`. It does not mount debugfs or scan unrelated devices.

After startup grace, **every** observed condition must remain true continuously for the configured threshold:

- The verified Bot child is in state `D` before and after the sample.
- Both physical and logical write-completion counters remain unchanged.
- Physical requests in flight are zero, logical requests in flight are positive, and WBT requests in flight are positive.

Write progress, a cleared condition, missing/invalid input, counter reset, or a gap over fifteen seconds resets the observation window. A sample taking over one second is unknown. One outstanding sampler daemon thread is allowed; a stuck kernel read does not create replacement threads and cannot block the independent lease watchdog. A sampling failure cannot itself authorize fencing.

Only the complete sustained conjunction latches `PRIMARY_IO_STALL`. The guardian then stops starting renewal requests, rejects adoption of a late response, sets its existing stop/fence events, and invokes the existing verified systemd/cgroup fencer once. Existing lease expiration, stop budget and authority drain timing remain unchanged. A renewal already sent before the latch may still finish at the authority; it is not adopted locally. The authority's original expiry/drain safeguards continue to apply. There is no renewal solely to report a fault.

The public lease file includes a compact `primaryIoWatch` observation with fixed policy names, PID/start ticks, status/reason, the last numeric evidence and continuous duration. It contains no raw paths, command arguments, credentials or lease IDs. On confirmation, subsequent publication uses `state=io_stalled`, `reason=PRIMARY_IO_STALL`, and a zero usable lease deadline. Final publication runs best effort on a separate daemon thread so a stalled status write cannot delay fencing. Loss of the host or immediate unit termination may prevent the final observation from being persisted.

This change deliberately does **not** modify the authority schema/protocol, send a new notification, or provide durable off-host node-health history to the independent Web UI. That is a separate follow-up. The public lease may be collected while the primary remains reachable, but must not be described as an independent retained incident record.

The detector is specific to this failure signature. It does not cover all disk failures, an event loop waiting in another state, a busy physical device, unavailable debugfs, a host-wide kernel hang, or a dead guardian. It requests the existing fence; kernel `D` tasks may not disappear until their kernel wait returns. It cannot repair a kernel I/O deadlock. HTTP 200 and an authority lease remain separate from these I/O observations.

`guardian.py` is part of the signed enrollment installation proof. Deploying this source requires a coordinated update of the installed guardian, its installation manifest and the authority's approved guardian hash, followed by the existing enrollment procedure. Do not patch or replace the current live primary guardian or its authority policy during the unresolved I/O stall. This source change does not grant reboot approval or change any live hash/configuration.
