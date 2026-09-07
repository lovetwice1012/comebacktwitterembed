#!/usr/bin/env python3
"""Keep the active cloud workload serving while preparing an automatic failback."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import time
import urllib.parse
import urllib.request

try:
    from .user_notifications import send as notify
except ImportError:
    from user_notifications import send as notify

PHASES = {"WAITING_PRIMARY", "PRIMARY_PREPARED", "SOURCE_FROZEN", "OWNERSHIP_COMMITTING", "PRIMARY_VERIFYING", "ROUTING_PRIMARY", "PRIMARY_ACTIVE", "FAILED"}


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

    @staticmethod
    def validate(config):
        required = {"statePath", "authorityUrl", "authorityConfig", "primarySshKey", "primarySnapshotPath", "primaryReadyMarker", "primaryTunnelId", "cloudflared", "originCertificate", "notificationConfig", "primaryHostnames", "handoffMarker", "sourceLeaseFile"}
        if not isinstance(config, dict) or required - set(config):
            raise FailbackError("Failback configuration is incomplete")
        for key in ("statePath", "authorityConfig", "primarySshKey", "primarySnapshotPath", "primaryReadyMarker", "handoffMarker", "sourceLeaseFile", "notificationConfig"):
            path = Path(config[key])
            if not path.is_absolute() or path == Path(path.anchor) or ".." in path.parts:
                raise FailbackError("Failback paths must be absolute and non-root")
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

    def save(self, **updates):
        self.state.update(updates, updatedAt=now_iso())
        atomic_json(self.state_path, self.state)

    @staticmethod
    def command(argv, timeout=30):
        try:
            result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout, check=False, env={"PATH": os.defpath})
        except (OSError, subprocess.TimeoutExpired):
            raise FailbackError("A bounded recovery command did not complete") from None
        if result.returncode != 0:
            raise FailbackError("A bounded recovery command failed")
        return result.stdout.strip()

    def ssh(self, command, timeout=30):
        return self.runner(["ssh", "-T", "-i", self.config["primarySshKey"], "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + self.config.get("primaryKnownHosts", "/etc/cbte-recovery/primary-known-hosts"), "-o", "ConnectTimeout=10", "-p", str(self.config.get("primarySshPort", 34222)), "root@127.0.0.1", command], timeout)

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
        marker = self.config["primaryReadyMarker"]
        commands = ["test -s %s" % marker, "test -s %s" % self.config["primarySnapshotPath"], "systemctl start cbte-admin.service cbte-admin-executor.service cbte-admin-analysis.service cbte-admin-reports.service", "test \"$(systemctl is-active cbte.service)\" = active", "cat /proc/sys/kernel/random/boot_id", "mysql --defaults-file=/etc/mysql/debian.cnf --batch --skip-column-names -e \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='ComebackTwitterEmbed';\"", "mysql --defaults-file=/etc/mysql/debian.cnf --batch --skip-column-names -e \"SELECT COUNT(*) FROM ComebackTwitterEmbed.guilds;\"", "sha256sum %s | awk '{print $1}'" % self.config["primarySnapshotPath"]]
        values = []
        for command in commands:
            values.append(self.ssh(command, timeout=45))
        if values[5] != "39" or not values[6] or not __import__("re").fullmatch(r"[0-9a-f]{64}", values[7]):
            raise FailbackError("Primary snapshot or database validation is incomplete")
        return {"bootId": values[4], "tables": int(values[5]), "guilds": int(values[6]), "snapshotSha256": values[7]}

    def fence_source(self):
        self.runner(["systemctl", "stop", "cbte-recovery-controller.service"], timeout=30)
        self.runner(["systemctl", "stop", "cbte-recovery-workload.service"], timeout=30)
        for unit in ("cbte-recovery-controller.service", "cbte-recovery-workload.service"):
            state = subprocess.run(["systemctl", "is-active", unit], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=10, check=False).stdout.strip()
            if state not in {"inactive", "failed"}:
                raise FailbackError("Source workload is still active")

    def release_source_lease(self):
        lease_path = Path(self.config["sourceLeaseFile"])
        if not lease_path.exists():
            return
        lease = private_json(lease_path)
        if lease.get("state") not in {"active", "renewal_unconfirmed"}:
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
                primary = self.primary_ready()
                notify(self.config["notificationConfig"], "failback-start", authority["epoch"], self.state["operationId"])
                self.save(phase="PRIMARY_PREPARED", primary=primary)
            except Exception as error:
                self.save(lastError=type(error).__name__)
            return self.state
        if phase == "PRIMARY_PREPARED":
            try:
                self.fence_source()
                self.release_source_lease()
                authority = self.authority()
                self.save(phase="SOURCE_FROZEN", sourceEpoch=authority["epoch"])
            except Exception as error:
                self.save(lastError=type(error).__name__)
            return self.state
        if phase == "SOURCE_FROZEN":
            try:
                authority = self.authority()
                primary = self.primary_ready()
                atomic_json(Path(self.config["handoffMarker"]), {"version": 1, "sourceNode": "oci", "sourceEpoch": authority["epoch"], "sourceFenced": True, "createdAt": time.time()})
                self.runner(["systemctl", "restart", "cbte-recovery-authority.service"], timeout=30)
                self.save(phase="OWNERSHIP_COMMITTING", primary=primary)
            except Exception as error:
                self.save(lastError=type(error).__name__)
            return self.state
        if phase == "OWNERSHIP_COMMITTING":
            try:
                authority = self.authority()
                primary = self.primary_ready()
                result = self.failback_authority(authority, primary)
                self.save(phase="PRIMARY_VERIFYING", primary=primary, authority=result)
            except Exception as error:
                self.save(lastError=type(error).__name__)
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
                self.save(lastError=type(error).__name__)
            return self.state
        if phase == "ROUTING_PRIMARY":
            try:
                authority = self.authority()
                self.route(authority["epoch"], self.state.get("primaryInstanceId", ""))
                notify(self.config["notificationConfig"], "primary-active", authority["epoch"], self.state["operationId"])
                self.save(phase="PRIMARY_ACTIVE", lastError=None)
                self.runner(["systemctl", "start", "cbte-recovery-controller.service"], timeout=30)
            except Exception as error:
                self.save(lastError=type(error).__name__)
            return self.state
        return self.state

    def run(self):
        while self.state["phase"] != "PRIMARY_ACTIVE":
            self.step()
            time.sleep(max(15, int(self.config.get("pollSeconds", 30))))
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
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
