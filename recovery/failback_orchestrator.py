#!/usr/bin/env python3
"""Keep the active cloud workload serving while preparing an automatic failback."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import shlex
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request

try:
    from .user_notifications import send as notify
except ImportError:
    from user_notifications import send as notify

PHASES = {"WAITING_PRIMARY", "PRIMARY_PREPARED", "SOURCE_FROZEN", "OWNERSHIP_COMMITTING", "PRIMARY_VERIFYING", "ROUTING_PRIMARY", "PRIMARY_ACTIVE", "FAILED"}
LOG = logging.getLogger("cbte-recovery.failback")
DEFAULT_CONTROLLER_STATE = "/var/lib/cbte-recovery/controller/state.json"


class FailbackError(Exception):
    pass


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def private_file(path: Path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or (os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077)):
        raise FailbackError("A recovery credential/configuration file is not private")


def private_json(path):
    file = Path(path)
    private_file(file)
    try:
        value = json.loads(file.read_text(encoding="utf-8"))
    except Exception:
        raise FailbackError("A recovery JSON file is invalid") from None
    if not isinstance(value, dict):
        raise FailbackError("A recovery JSON file must be an object")
    return value


def runtime_json(path):
    """Read a root-owned, non-secret runtime status file.

    Guardian runtime leases intentionally omit the bearer lease secret and are
    often mode 0644 so the local dashboard can display their state.  Treating
    that status file like a credential made a valid failback fail closed after
    fencing the source.
    """
    file = Path(path)
    try:
        info = file.lstat()
        if not stat.S_ISREG(info.st_mode) or file.is_symlink() or (os.name == "posix" and info.st_uid != 0):
            raise FailbackError("A recovery runtime status file is invalid")
        value = json.loads(file.read_text(encoding="utf-8"))
    except FailbackError:
        raise
    except Exception:
        raise FailbackError("A recovery runtime status file is invalid") from None
    if not isinstance(value, dict):
        raise FailbackError("A recovery runtime status file must be an object")
    return value


def atomic_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".next")
    with temporary.open("w", encoding="utf-8") as output:
        if os.name == "posix":
            os.chmod(temporary, 0o600)
        json.dump(value, output, ensure_ascii=False, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


class Failback:
    def __init__(self, config, runner=None):
        self.config = self.validate(config)
        self.runner = runner or self.command
        self.state_path = Path(self.config["statePath"])
        self.state = self.load_state()
        manual = self.manual_switch_record()
        if (self.state.get("phase") in {"PRIMARY_ACTIVE", "FAILED"} and isinstance(manual, dict)
                and manual.get("targetNode") == "primary" and manual.get("state") in {"scheduled", "executing"}
                and manual.get("operationId") != self.state.get("operationId")):
            self.state = {"version": 1, "phase": "WAITING_PRIMARY", "operationId": manual["operationId"], "manualSwitchId": manual["operationId"], "updatedAt": now_iso()}
            self.save()

    @staticmethod
    def validate(config):
        required = {"statePath", "authorityUrl", "authorityConfig", "primarySshKey", "primarySnapshotPath", "primaryReadyMarker", "primaryTunnelId", "cloudflared", "originCertificate", "notificationConfig", "primaryHostnames", "handoffMarker", "sourceLeaseFile"}
        if not isinstance(config, dict) or required - set(config):
            raise FailbackError("Failback configuration is incomplete")
        for key in ("statePath", "authorityConfig", "primarySshKey", "primarySnapshotPath", "primaryReadyMarker", "handoffMarker", "sourceLeaseFile", "notificationConfig"):
            path = Path(config[key])
            if not path.is_absolute() or path == Path(path.anchor) or ".." in path.parts:
                raise FailbackError("Failback paths must be absolute and non-root")
        if "controllerStatePath" in config:
            controller_state = Path(config["controllerStatePath"])
            if not controller_state.is_absolute() or controller_state == Path(controller_state.anchor) or ".." in controller_state.parts:
                raise FailbackError("Controller state path must be absolute and non-root")
        if config["primaryHostnames"] != ["cbte.sprink.cloud", "twidata.sprink.cloud"]:
            raise FailbackError("Failback hostnames are fixed policy")
        parsed = urllib.parse.urlsplit(config["authorityUrl"])
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.query or parsed.fragment:
            raise FailbackError("Authority must be authenticated loopback HTTP")
        return config

    def load_state(self):
        if not self.state_path.exists():
            return {"version": 1, "phase": "WAITING_PRIMARY", "operationId": secrets.token_hex(24), "updatedAt": now_iso()}
        value = private_json(self.state_path)
        if value.get("version") != 1 or value.get("phase") not in PHASES or not isinstance(value.get("operationId"), str):
            raise FailbackError("Failback state is invalid")
        return value

    def manual_switch_record(self):
        path = Path(self.config.get("controllerStatePath", DEFAULT_CONTROLLER_STATE))
        if not path.exists():
            return None
        value = private_json(path)
        record = value.get("manualSwitch")
        return record if isinstance(record, dict) else None

    def bind_manual_switch(self, authority):
        """Return whether a scheduled primary handoff may run now.

        A future reservation must hold the automatic failback state machine at
        WAITING_PRIMARY.  Once due, the normal evidence, fencing and handoff
        phases are reused unchanged.
        """
        record = self.manual_switch_record()
        if not isinstance(record, dict) or record.get("targetNode") != "primary" or record.get("state") not in {"scheduled", "executing"}:
            # A recovered OCI workload remains authoritative until an
            # operator schedules the primary handoff from the console. This
            # prevents a newly reachable but stale primary from triggering an
            # unsolicited cutback.
            return self.config.get("manualFailbackOnly", True) is not True
        try:
            execute_at = dt.datetime.fromisoformat(str(record.get("executeAt", "")).replace("Z", "+00:00"))
            if execute_at.tzinfo is None:
                raise ValueError
        except (TypeError, ValueError, OverflowError):
            raise FailbackError("Manual switch reservation has an invalid time")
        if time.time() < execute_at.timestamp():
            return False
        if self.state.get("operationId") != record.get("operationId"):
            if self.state.get("phase") in {"WAITING_PRIMARY", "FAILED", "PRIMARY_ACTIVE"}:
                self.state = {"version": 1, "phase": "WAITING_PRIMARY", "operationId": record["operationId"], "manualSwitchId": record["operationId"], "updatedAt": now_iso()}
                self.save()
        return True

    def save(self, **updates):
        previous = self.state.get("phase")
        if updates.get("lastError") is None:
            for key in ("lastErrorMessage", "lastErrorPhase", "lastErrorAt"):
                self.state.pop(key, None)
        self.state.update(updates, updatedAt=now_iso())
        atomic_json(self.state_path, self.state)
        current = self.state.get("phase")
        if current != previous:
            LOG.info("phase %s -> %s", previous, current)

    @staticmethod
    def command(argv, timeout=30):
        try:
            result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout, check=False, env={"PATH": os.defpath})
        except subprocess.TimeoutExpired:
            raise FailbackError("A bounded recovery command timed out") from None
        except OSError:
            raise FailbackError("A bounded recovery command could not start") from None
        if result.returncode != 0:
            # Do not persist stdout/stderr: a remote command may contain paths
            # or deployment details that are not needed for the state machine.
            raise FailbackError("A bounded recovery command failed")
        return result.stdout.strip()

    def ssh(self, command, timeout=30):
        return self.runner(["ssh", "-T", "-i", self.config["primarySshKey"], "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + self.config.get("primaryKnownHosts", "/etc/cbte-recovery/primary-known-hosts"), "-o", "ConnectTimeout=10", "-p", str(self.config.get("primarySshPort", 34222)), "root@127.0.0.1", command], timeout)

    @staticmethod
    def unit_state(unit):
        try:
            result = subprocess.run(["systemctl", "is-active", unit], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5, check=False, env={"PATH": os.defpath})
        except (OSError, subprocess.TimeoutExpired):
            raise FailbackError("A source unit state could not be confirmed") from None
        # systemctl uses exit status 3 for an inactive unit.  That is an
        # expected result while fencing and must remain distinguishable from a
        # command failure.
        if result.returncode not in {0, 3}:
            raise FailbackError("A source unit state could not be confirmed")
        return result.stdout.strip()

    def authority(self):
        config = private_json(self.config["authorityConfig"])
        token = (config.get("tokens") or {}).get("controller")
        if not isinstance(token, str) or len(token) < 32:
            raise FailbackError("Controller authority credential is unavailable")
        request = urllib.request.Request(self.config["authorityUrl"].rstrip("/") + "/v1/status", headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                value = json.loads(response.read(65537))
        except Exception:
            raise FailbackError("Authority status could not be confirmed") from None
        if value.get("ok") is not True:
            raise FailbackError("Authority status is invalid")
        return value

    def primary_ready(self):
        marker = shlex.quote(self.config["primaryReadyMarker"])
        snapshot = shlex.quote(self.config["primarySnapshotPath"])
        cached = self.state.get("primary") if isinstance(self.state.get("primary"), dict) else {}
        cached_meta = cached.get("snapshotMeta", "")
        cached_hash = cached.get("snapshotSha256", "")
        # One SSH session performs all checks.  The snapshot is immutable while
        # this operation is in progress, so a matching stat tuple safely reuses
        # the verified digest on later phase checks.
        cached_meta_literal = shlex.quote(cached_meta) if isinstance(cached_meta, str) else "''"
        cached_hash_literal = shlex.quote(cached_hash) if isinstance(cached_hash, str) else "''"
        command = "\n".join([
            "set -eu",
            f"test -s {marker}",
            f"test -s {snapshot}",
            "systemctl start cbte-admin.service cbte-admin-executor.service cbte-admin-analysis.service cbte-admin-reports.service",
            "test \"$(systemctl is-active cbte.service)\" = active",
            "printf 'CBTE_BOOT=%s\\n' \"$(cat /proc/sys/kernel/random/boot_id)\"",
            "printf 'CBTE_TABLES=%s\\n' \"$(mysql --defaults-file=/etc/mysql/debian.cnf --batch --skip-column-names -e \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='ComebackTwitterEmbed';\")\"",
            "printf 'CBTE_GUILDS=%s\\n' \"$(mysql --defaults-file=/etc/mysql/debian.cnf --batch --skip-column-names -e \"SELECT COUNT(*) FROM ComebackTwitterEmbed.guilds;\")\"",
            f"snapshot_meta=$(stat -c '%s:%Y:%Z:%i' {snapshot})",
            f"if [ \"$snapshot_meta\" = {cached_meta_literal} ] && printf '%s' {cached_hash_literal} | grep -Eq '^[0-9a-f]{{64}}$'; then snapshot_hash={cached_hash_literal}; else snapshot_hash=$(sha256sum {snapshot} | awk '{{print $1}}'); fi",
            "printf 'CBTE_SNAPSHOT_META=%s\\n' \"$snapshot_meta\"",
            "printf 'CBTE_SNAPSHOT_SHA256=%s\\n' \"$snapshot_hash\"",
        ])
        output = self.ssh(command, timeout=90)
        values = {}
        for line in output.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value.strip()
        import re
        if not re.fullmatch(r"[0-9a-f-]{8,128}", values.get("CBTE_BOOT", "")):
            raise FailbackError("Primary boot identity is unavailable")
        if values.get("CBTE_TABLES") != "39" or not values.get("CBTE_GUILDS") or not re.fullmatch(r"[0-9a-f]{64}", values.get("CBTE_SNAPSHOT_SHA256", "")):
            raise FailbackError("Primary snapshot or database validation is incomplete")
        return {"bootId": values["CBTE_BOOT"], "tables": int(values["CBTE_TABLES"]), "guilds": int(values["CBTE_GUILDS"]), "snapshotSha256": values["CBTE_SNAPSHOT_SHA256"], "snapshotMeta": values.get("CBTE_SNAPSHOT_META", "")}

    def fence_source(self):
        # Queue the stop and poll the unit instead of waiting on a systemd job
        # that can inherit the workload's container shutdown timeout.
        for unit in ("cbte-recovery-controller.service", "cbte-recovery-workload.service"):
            self.runner(["systemctl", "stop", "--no-block", unit], timeout=10)
            deadline = time.monotonic() + 35
            while True:
                state = self.unit_state(unit)
                if state in {"inactive", "failed"}:
                    break
                if time.monotonic() >= deadline:
                    raise FailbackError("Source workload did not stop within the fence deadline")
                time.sleep(0.25)
        for unit in ("cbte-recovery-controller.service", "cbte-recovery-workload.service"):
            state = self.unit_state(unit)
            if state not in {"inactive", "failed"}:
                raise FailbackError("Source workload is still active")

    def record_error(self, phase, error):
        # Keep diagnostics useful after a reboot without persisting command
        # output or credentials.  Error messages in this module are bounded
        # and intentionally generic.
        message = str(error)[:160]
        self.save(lastError=type(error).__name__, lastErrorPhase=phase, lastErrorMessage=message, lastErrorAt=now_iso())
        LOG.warning("phase %s failed: %s: %s", phase, type(error).__name__, message)

    def release_source_lease(self):
        lease_path = Path(self.config["sourceLeaseFile"])
        if not lease_path.exists():
            return
        lease = runtime_json(lease_path)
        if lease.get("state") not in {"active", "renewal_unconfirmed"}:
            return
        # The runtime lease intentionally omits its secret leaseId.  The
        # authority clears it atomically when the fenced handoff marker is
        # consumed during the planned authority restart; never send a forged
        # release request with a missing identity.
        if not isinstance(lease.get("leaseId"), str) or not lease["leaseId"]:
            return
        child_pid = lease.get("childPid")
        if type(child_pid) is int and child_pid > 1 and Path(f"/proc/{child_pid}").exists():
            raise FailbackError("Source workload child is still alive")
        config = private_json(self.config["authorityConfig"])
        body = {key: lease.get(key) for key in ("node", "instanceId", "epoch", "leaseId")}
        request = urllib.request.Request(self.config["authorityUrl"].rstrip("/") + "/v1/lease/release", data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + config["tokens"]["oci"], "Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.loads(response.read(65537))
        except Exception:
            raise FailbackError("Source lease release was not confirmed") from None
        if result.get("ok") is not True or result.get("released") is not True:
            raise FailbackError("Source lease release was rejected")
        # The guardian was stopped before this call and may have been killed
        # before it could rewrite its runtime lease file.  Record the confirmed
        # release locally so a stale runtime file cannot block the next phase.
        atomic_json(lease_path, {"version": 1, "node": "oci", "instanceId": lease.get("instanceId"), "state": "standby", "reason": "FAILBACK_LEASE_RELEASED", "epoch": None, "childPid": None, "expiresAt": None, "validUntilUnixMs": 0, "localStopDeadline": None, "updatedAt": time.time()})

    def failback_authority(self, authority, primary):
        config = private_json(self.config["authorityConfig"])
        handoff = {"handoffId": self.state["operationId"], "sourceBackupSha256": primary["snapshotSha256"], "sourceEpoch": authority["epoch"], "primaryBootId": primary["bootId"], "acceptPrimaryDivergence": True}
        body = {"expectedEpoch": authority["epoch"], "idempotencyKey": "failback-" + self.state["operationId"], "handoff": handoff}
        request = urllib.request.Request(self.config["authorityUrl"].rstrip("/") + "/v1/failback", data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + config["tokens"]["controller"], "Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.loads(response.read(65537))
        except Exception:
            raise FailbackError("Authority failback was not confirmed") from None
        if result.get("ok") is not True or result.get("activeNode") != "primary":
            raise FailbackError("Authority did not transfer ownership")
        return result

    def route(self, epoch, instance):
        records = []
        for hostname in self.config["primaryHostnames"]:
            self.runner([self.config["cloudflared"], "tunnel", "--origincert", self.config["originCertificate"], "route", "dns", "--overwrite-dns", self.config["primaryTunnelId"], hostname], timeout=30)
            request = urllib.request.Request("https://" + hostname + "/api/health", headers={"User-Agent": "CBTE-Recovery/1.0"})
            with urllib.request.urlopen(request, timeout=10) as response:
                body = json.loads(response.read(65537))
            if response.status != 200 or body.get("ok") is not True or body.get("node") != "primary" or body.get("epoch") != epoch or body.get("instanceId") != instance:
                raise FailbackError("Public primary route identity is not verified")
            records.append({"hostname": hostname, "status": response.status, "body": body})
        return {"ok": True, "records": records, "tunnelId": self.config["primaryTunnelId"]}

    def step(self):
        phase = self.state["phase"]
        if phase == "WAITING_PRIMARY":
            try:
                authority = self.authority()
                if authority.get("activeNode") != "oci":
                    return self.state
                if not self.bind_manual_switch(authority):
                    return self.state
                primary = self.primary_ready()
                notify(self.config["notificationConfig"], "failback-start", authority["epoch"], self.state["operationId"])
                self.save(phase="PRIMARY_PREPARED", primary=primary)
            except Exception as error:
                self.record_error("WAITING_PRIMARY", error)
            return self.state
        if phase == "PRIMARY_PREPARED":
            try:
                self.fence_source()
                self.release_source_lease()
                authority = self.authority()
                self.save(phase="SOURCE_FROZEN", sourceEpoch=authority["epoch"])
            except Exception as error:
                self.record_error("PRIMARY_PREPARED", error)
            return self.state
        if phase == "SOURCE_FROZEN":
            try:
                authority = self.authority()
                primary = self.primary_ready()
                atomic_json(Path(self.config["handoffMarker"]), {"version": 1, "sourceNode": "oci", "sourceEpoch": authority["epoch"], "sourceFenced": True, "createdAt": time.time()})
                self.runner(["systemctl", "restart", "cbte-recovery-authority.service"], timeout=30)
                self.save(phase="OWNERSHIP_COMMITTING", primary=primary)
            except Exception as error:
                self.record_error("SOURCE_FROZEN", error)
            return self.state
        if phase == "OWNERSHIP_COMMITTING":
            try:
                authority = self.authority()
                primary = self.primary_ready()
                result = self.failback_authority(authority, primary)
                self.save(phase="PRIMARY_VERIFYING", primary=primary, authority=result)
            except Exception as error:
                self.record_error("OWNERSHIP_COMMITTING", error)
            return self.state
        if phase == "PRIMARY_VERIFYING":
            try:
                authority = self.authority()
                primary = self.primary_ready()
                lease = json.loads(self.ssh("cat /run/cbte-recovery/primary-lease.json", timeout=20))
                if lease.get("state") not in {"active", "renewal_unconfirmed"} or lease.get("epoch") != authority["epoch"]:
                    raise FailbackError("Primary lease is not active")
                self.save(phase="ROUTING_PRIMARY", primary=primary, primaryInstanceId=lease.get("instanceId"), authority=authority)
            except Exception as error:
                self.record_error("PRIMARY_VERIFYING", error)
            return self.state
        if phase == "ROUTING_PRIMARY":
            try:
                authority = self.authority()
                self.route(authority["epoch"], self.state.get("primaryInstanceId", ""))
                notify(self.config["notificationConfig"], "primary-active", authority["epoch"], self.state["operationId"])
                self.save(phase="PRIMARY_ACTIVE", lastError=None)
                self.runner(["systemctl", "start", "cbte-recovery-controller.service"], timeout=30)
            except Exception as error:
                self.record_error("ROUTING_PRIMARY", error)
            return self.state
        return self.state

    def run(self):
        poll_seconds = max(15, int(self.config.get("pollSeconds", 30)))
        retry_seconds = max(5, min(int(self.config.get("retrySeconds", 5)), poll_seconds))
        while self.state["phase"] != "PRIMARY_ACTIVE":
            before = self.state["phase"]
            self.step()
            after = self.state["phase"]
            if after == "PRIMARY_ACTIVE":
                break
            if after != before:
                # Successful transitions are chained immediately.  Waiting at
                # every phase made a healthy failback look like a long outage.
                retry_seconds = max(5, min(int(self.config.get("retrySeconds", 5)), poll_seconds))
                continue
            LOG.info("phase %s is waiting; retrying in %ss", after, retry_seconds)
            time.sleep(retry_seconds)
            retry_seconds = min(poll_seconds, max(retry_seconds * 2, 5))
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    try:
        process = Failback(private_json(args.config))
        if args.once:
            print(json.dumps(process.step(), ensure_ascii=False))
            return 0
        return process.run()
    except FailbackError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
