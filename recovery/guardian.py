#!/usr/bin/env python3
"""Lease-gated systemd workload supervisor, without shell execution.

Usage: python3 guardian.py --config /etc/cbte-recovery/primary-guardian.json
Config: {authorityUrl: "http://127.0.0.1:34210", node: "primary"|"oci",
 token: "...", command: ["/usr/local/bin/node", "/path/index.js"],
 leaseFile: "/run/cbte-recovery/lease.json", workingDirectory: "/path", systemdUnit: "cbte.service",
 enrollment: {systemdUnit: "cbte.service", installationProofPath: "/etc/...json"}}

Primary always validates the actual systemd installation before enrollment.
The public lease file (0644, in a dedicated 0755 runtime directory) excludes
role tokens, lease IDs and command arguments. Config/manifests remain root-only.
Network I/O runs in a daemon thread: a stuck request cannot delay child fencing.
Linux CLOCK_BOOTTIME includes suspension; lease deadlines cannot be extended by
suspending the host. The verified systemd cgroup is fenced before its deadline,
including workers that deliberately created detached process groups.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shlex
import signal
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

try:
    from .authority import Clock, PROOF_DOMAIN, STOP_MARGIN, canonical, load_root_config
except ImportError:
    from authority import Clock, PROOF_DOMAIN, STOP_MARGIN, canonical, load_root_config

RENEW_INTERVAL = 10.0
REQUEST_BUDGET = 5.0
TERM_GRACE = 4.0
KILL_GRACE = 2.0
STOP_BUDGET = 12.0
KILL_SIGNAL = getattr(signal, "SIGKILL", 9)
PRIMARY_COMPANIONS = ("cbte-admin-analysis.service", "cbte-admin-reports.service")


class RemoteError(Exception):
    def __init__(self, code, message="Recovery authority request failed"):
        super().__init__(message)
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AuthorityClient:
    def __init__(self, base, token):
        parsed = urlsplit(base)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("authorityUrl must be a fixed HTTP(S) origin without credentials")
        self.base, self.token = base.rstrip("/"), token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, payload=None):
        body = canonical(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.base + path, data=body, method=method, headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=REQUEST_BUDGET) as response:
                data = response.read(65537)
                if len(data) > 65536:
                    raise RemoteError("RESPONSE_TOO_LARGE")
                value = json.loads(data)
        except urllib.error.HTTPError as error:
            try:
                details = json.loads(error.read(65536)).get("error", {})
                raise RemoteError(details.get("code", "AUTHORITY_REJECTED"), details.get("message", "Authority rejected lease")) from None
            except (ValueError, AttributeError):
                raise RemoteError("AUTHORITY_REJECTED") from None
            finally:
                error.close()
        except (urllib.error.URLError, OSError, ValueError):
            raise RemoteError("AUTHORITY_UNREACHABLE") from None
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise RemoteError("INVALID_AUTHORITY_RESPONSE")
        return value


def command_digest(command):
    return hashlib.sha256(canonical(command).encode()).hexdigest()


def validate_command(config):
    command = config.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(arg, str) and "\x00" not in arg for arg in command):
        raise ValueError("command must be a fixed argv array")
    if not Path(command[0]).is_absolute() or not command[0]:
        raise ValueError("command executable must be an absolute path")
    if Path(command[0]).name.lower() in {"sh", "bash", "dash", "zsh", "ksh", "fish", "cmd.exe", "powershell.exe", "pwsh"}:
        raise ValueError("Shell command handlers are not permitted")
    if config.get("node") not in ("primary", "oci") or not isinstance(config.get("token"), str) or len(config["token"]) < 32:
        raise ValueError("A primary/oci role and its token are required")
    unit = config.get("systemdUnit") or config.get("enrollment", {}).get("systemdUnit")
    if not isinstance(unit, str) or re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", unit) is None:
        raise ValueError("A fixed systemdUnit is required for every workload guardian")
    configured_companions = config.get("companionUnits")
    if configured_companions is not None:
        expected = set(PRIMARY_COMPANIONS) if config["node"] == "primary" else set()
        if not isinstance(configured_companions, list) or set(configured_companions) != expected:
            raise ValueError("Only the fixed primary analysis/reports companion units are permitted")
    return list(command)


def cgroup_directory(group):
    candidates = [Path("/sys/fs/cgroup") / group.lstrip("/"), Path("/sys/fs/cgroup/systemd") / group.lstrip("/")]
    return next((path for path in candidates if (path / "cgroup.procs").is_file()), None)


def trusted_unit_file(path):
    file = Path(path)
    info = file.stat()
    if not file.is_absolute() or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
        raise ValueError("Companion unit files/drop-ins must be root-owned and not writable by other users")
    return hashlib.sha256(file.read_bytes()).hexdigest()


def inspect_companions(config):
    if config["node"] != "primary":
        return []
    results = []
    for unit in PRIMARY_COMPANIONS:
        response = subprocess.run(["/usr/bin/systemctl", "show", unit, "--no-pager", "--property=LoadState,FragmentPath,DropInPaths,KillMode,ControlGroup"], capture_output=True, text=True, timeout=3, check=False)
        fields = dict(line.split("=", 1) for line in response.stdout.splitlines() if "=" in line)
        if fields.get("LoadState") == "not-found":
            results.append({"unit": unit, "installed": False})
            continue
        if response.returncode != 0:
            raise ValueError("Companion unit state could not be verified: " + unit)
        if fields.get("LoadState") != "loaded" or fields.get("KillMode") != "control-group":
            raise ValueError("Installed primary companion must use KillMode=control-group: " + unit)
        paths = [fields.get("FragmentPath", "")] + shlex.split(fields.get("DropInPaths", ""))
        if not paths[0]:
            raise ValueError("Companion unit fragment could not be verified")
        files = [{"path": path, "sha256": trusted_unit_file(path)} for path in paths]
        group = fields.get("ControlGroup", "")
        if group and (group == "/" or ".." in Path(group).parts or not group.endswith("/" + unit)):
            raise ValueError("Companion unit cgroup identity does not match")
        directory = cgroup_directory(group) if group else None
        results.append({"unit": unit, "installed": True, "killMode": "control-group", "files": files, "cgroup": group, "cgroupDirectory": str(directory) if directory else None})
    return results


def cgroup_pid_files(directory):
    """Bounded walk below one verified unit, including delegated sub-cgroups."""
    pending, result = [Path(directory)], []
    while pending:
        current = pending.pop()
        result.append(current / "cgroup.procs")
        if len(result) > 128:
            raise ValueError("Protected unit has too many nested cgroups to verify")
        for path in current.iterdir():
            if path.is_dir() and not path.is_symlink():
                pending.append(path)
    return result


def inspect_guardian_unit(config):
    if os.name != "posix":
        raise ValueError("Workload guardians require Linux/systemd cgroup ownership")
    unit = config.get("systemdUnit") or config.get("enrollment", {}).get("systemdUnit")
    script = Path(__file__).resolve()
    response = subprocess.run(["/usr/bin/systemctl", "show", unit, "--no-pager", "--property=MainPID,KillMode,ExecStart,ControlGroup"], capture_output=True, text=True, timeout=4, check=True)
    fields = dict(line.split("=", 1) for line in response.stdout.splitlines() if "=" in line)
    pid = os.getpid()
    launch_paths = {str(script), str(Path(__file__).absolute())}
    launch_matches = any(re.search(r"(?:^|\s)" + re.escape(path) + r"(?:\s|;|$)", fields.get("ExecStart", "")) for path in launch_paths)
    if fields.get("MainPID") != str(pid) or fields.get("KillMode") != "control-group" or not launch_matches:
        raise ValueError("Guardian must be the actual systemd MainPID and protected ExecStart")
    group = fields.get("ControlGroup", "")
    if not group.startswith("/") or group == "/" or ".." in Path(group).parts or not group.endswith("/" + unit):
        raise ValueError("Invalid systemd control group")
    directory = cgroup_directory(group)
    if directory is None:
        raise ValueError("Cannot verify protected cgroup processes")
    pids = sorted({int(line) for path in cgroup_pid_files(directory) for line in path.read_text().splitlines() if line.strip()})
    if pids != [pid]:
        raise ValueError("Existing workload processes remain in the protected systemd unit")
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    return {"unit": unit, "guardianPid": pid, "mainPid": pid, "killMode": "control-group", "cgroupPids": pids, "cgroup": group, "cgroupDirectory": str(directory), "hostBootId": boot_id, "execStartVerified": True, "execStartSha256": hashlib.sha256(fields["ExecStart"].encode()).hexdigest(), "workloadStarted": False, "companionUnits": inspect_companions(config)}


def installation_proof(config, challenge):
    observed = inspect_guardian_unit(config)
    manifest = load_root_config(config.get("enrollment", {})["installationProofPath"])
    guardian_hash = hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()
    command_hash = command_digest(config["command"])
    expected = {"version": 1, "node": "primary", "unit": observed["unit"], "guardianSha256": guardian_hash, "commandSha256": command_hash}
    if any(manifest.get(key) != value for key, value in expected.items()) or not manifest.get("installationId"):
        raise ValueError("Root-owned installation manifest does not match this guardian/workload")
    return dict(observed, challengeId=challenge["challengeId"], nonce=challenge["nonce"], installationId=manifest["installationId"], guardianSha256=guardian_hash, commandSha256=command_hash)


class SystemdUnitFencer:
    """The fixed verified unit, not the direct child's process group, is fenced.

    Real execution kills this guardian too. Test adapters can observe the exact
    systemctl contract without targeting the test runner's service or cgroup.
    """
    def __init__(self, observation, runner=None, kill_self=None):
        if observation.get("mainPid") != os.getpid() or observation.get("killMode") != "control-group" or not observation.get("execStartVerified"):
            raise ValueError("Own-unit ownership proof is required before installing a fencer")
        self.unit = observation["unit"]
        self.group = observation["cgroup"]
        self.directory = Path(observation["cgroupDirectory"])
        self.companions = observation.get("companionUnits", [])
        if any(value.get("unit") not in PRIMARY_COMPANIONS for value in self.companions):
            raise ValueError("Unknown companion fence target")
        self.runner = runner or subprocess.run
        self.kill_self = kill_self or (lambda: os.kill(os.getpid(), KILL_SIGNAL))
        self.lock = threading.Lock()
        self.started = False

    def fence(self):
        with self.lock:
            if self.started:
                return
            self.started = True
        try:
            # Companion workers are independent systemd services, so fence them
            # before killing this guardian's own unit. Always include the fixed
            # known names even if they were absent during startup verification.
            for unit in [entry["unit"] for entry in self.companions] + [self.unit]:
                try:
                    self.runner(["/usr/bin/systemctl", "kill", "--kill-who=all", "--signal=SIGKILL", unit], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2, check=False)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        finally:
            # If systemctl did not already kill us, stop remaining tasks in the
            # verified unit's cgroup (v1/v2), then die so systemd also cleans up.
            # No authority request or writable status-file operation is needed.
            try:
                scopes = [(self.directory, self.group)] + [(Path(value["cgroupDirectory"]), value["cgroup"]) for value in self.companions if value.get("cgroupDirectory") and value.get("cgroup")]
                for directory, group in scopes:
                    try:
                        files = cgroup_pid_files(directory)
                    except (OSError, ValueError):
                        files = [directory / "cgroup.procs"]
                    for path in files:
                        try:
                            pids = {int(line) for line in path.read_text().splitlines() if line.strip()}
                        except (OSError, ValueError):
                            continue
                        for pid in pids:
                            if pid > 1 and pid != os.getpid() and self._pid_in_scope(pid, group):
                                try:
                                    os.kill(pid, KILL_SIGNAL)
                                except ProcessLookupError:
                                    pass
            finally:
                self.kill_self()

    def _pid_in_scope(self, pid, scope=None):
        scope = scope or self.group
        try:
            for line in Path("/proc/%d/cgroup" % pid).read_text().splitlines():
                _, controllers, group = line.split(":", 2)
                if (controllers == "" or "name=systemd" in controllers.split(",")) and (group == scope or group.startswith(scope + "/")):
                    return True
        except (OSError, ValueError):
            pass
        return False


def signal_group(process, sig):
    if os.name == "posix":
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
    elif process.poll() is None:
        if sig == signal.SIGTERM:
            process.terminate()
        else:
            process.kill()


def group_alive(process):
    if os.name != "posix":
        return process.poll() is None
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_group(process, clock=None):
    """Bound the entire process group, even if the group leader exited first."""
    clock = clock or Clock()
    signal_group(process, signal.SIGTERM)
    deadline = clock.monotonic() + TERM_GRACE
    while group_alive(process) and clock.monotonic() < deadline:
        process.poll()
        time.sleep(0.05)
    signal_group(process, KILL_SIGNAL)
    deadline = clock.monotonic() + KILL_GRACE
    while group_alive(process) and clock.monotonic() < deadline:
        process.poll()
        time.sleep(0.05)
    try:
        process.wait(timeout=0.1)
    except subprocess.TimeoutExpired:
        pass
    return process.poll() is not None


class Guardian:
    def __init__(self, config, client=None, clock=None, proof_builder=installation_proof, process_factory=None, fencer=None):
        self.config = config
        self.command = validate_command(config)
        self.node = config["node"]
        self.instance_id = config.get("instanceIdPrefix", self.node) + ":" + secrets.token_hex(24)
        self.client = client or AuthorityClient(config["authorityUrl"], config["token"])
        self.clock = clock or Clock()
        self.proof_builder = proof_builder
        self.process_factory = process_factory or self._spawn
        self.fencer = fencer
        self.stop_event = threading.Event()
        self.lease = None
        self.local_deadline = None
        self.child = None
        self.fence_event = threading.Event()
        self.child_done = threading.Event()
        self.watchdog = None
        self.pending_thread = None
        self.next_retry = 0.0
        self.status_path = Path(config["leaseFile"])
        self.status_path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        self._lock_file = None

    def _spawn(self):
        environment = {key: value for key, value in os.environ.items() if value != self.config["token"] and key not in {"CBTE_AUTHORITY_TOKEN", "CBTE_RECOVERY_TOKEN", "RECOVERY_PRIMARY_TOKEN", "RECOVERY_OCI_TOKEN", "RECOVERY_CONTROLLER_TOKEN"}}
        environment.update({"CBTE_FLEET_LEASE_FILE": str(self.status_path), "CBTE_FLEET_NODE": self.node, "CBTE_FLEET_EPOCH": str(self.lease["epoch"])})
        return subprocess.Popen(self.command, cwd=self.config.get("workingDirectory"), env=environment, start_new_session=True, close_fds=True)

    def lock(self):
        if os.name != "posix":
            return
        import fcntl
        self._lock_file = open(str(self.status_path) + ".lock", "a+b")
        os.chmod(str(self.status_path) + ".lock", 0o600)
        fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def unlock(self):
        if self._lock_file:
            self._lock_file.close()
            self._lock_file = None

    def publish(self, state, reason=None):
        valid_until = int((self.clock.wall() + max(0, self.local_deadline - self.clock.monotonic())) * 1000) if self.local_deadline is not None and state in ("active", "renewal_unconfirmed") else 0
        value = {"version": 1, "node": self.node, "instanceId": self.instance_id, "state": state, "updatedAt": self.clock.wall(), "epoch": self.lease.get("epoch") if self.lease else None, "expiresAt": self.lease.get("expiresAt") if self.lease else None, "validUntilUnixMs": valid_until, "localStopDeadline": self.local_deadline, "childPid": self.child.pid if self.child else None, "reason": reason}
        temporary = self.status_path.with_name(self.status_path.name + ".tmp-" + secrets.token_hex(8))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        os.chmod(temporary, 0o644)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(canonical(value))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.status_path)
            if os.name == "posix":
                directory = os.open(self.status_path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            if temporary.exists():
                temporary.unlink()

    def call(self, method, path, data=None, deadline=None, allow_stopping=False):
        if self.pending_thread and self.pending_thread.is_alive():
            raise RemoteError("REQUEST_IN_FLIGHT")
        results = queue.Queue(maxsize=1)
        started = self.clock.monotonic()

        def send():
            try:
                results.put((self.client.request(method, path, data), None))
            except Exception as error:
                results.put((None, error))

        self.pending_thread = threading.Thread(target=send, daemon=True)
        self.pending_thread.start()
        bound = min(started + REQUEST_BUDGET, deadline) if deadline is not None else started + REQUEST_BUDGET
        while self.clock.monotonic() < bound:
            if self.stop_event.is_set() and not allow_stopping:
                raise RemoteError("CANCELLED")
            try:
                value, error = results.get(timeout=0.05)
                if error:
                    raise error
                return value, started
            except queue.Empty:
                continue
        raise RemoteError("REQUEST_DEADLINE")

    def enroll_primary(self):
        challenge, _ = self.call("POST", "/v1/primary/enroll/challenge", {"instanceId": self.instance_id})
        proof = self.proof_builder(self.config, challenge)
        signed = PROOF_DOMAIN + canonical({"clusterId": challenge["clusterId"], "instanceId": self.instance_id, "proof": proof}).encode()
        signature = hmac.new(self.config["token"].encode(), signed, hashlib.sha256).hexdigest()
        self.call("POST", "/v1/primary/enroll", {"instanceId": self.instance_id, "proof": proof, "signature": signature})

    def adopt(self, lease, requested_at):
        if self.fence_event.is_set():
            raise RemoteError("LEASE_ALREADY_FENCED")
        if lease.get("node") != self.node or lease.get("instanceId") != self.instance_id or not isinstance(lease.get("leaseId"), str) or type(lease.get("epoch")) is not int:
            raise RemoteError("INVALID_LEASE")
        if self.lease and (lease["epoch"] != self.lease["epoch"] or lease["leaseId"] != self.lease["leaseId"]):
            raise RemoteError("LEASE_IDENTITY_CHANGED")
        ttl = lease.get("ttlSeconds")
        if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not 0 < ttl <= 90:
            raise RemoteError("INVALID_LEASE_DURATION")
        margin = max(STOP_MARGIN, float(lease.get("stopMarginSeconds", STOP_MARGIN)))
        deadline = requested_at + ttl - margin
        if deadline - STOP_BUDGET <= self.clock.monotonic():
            raise RemoteError("LEASE_RESPONSE_TOO_LATE")
        self.lease, self.local_deadline = lease, deadline

    def start_watchdog(self):
        self.child_done.clear()

        def supervise():
            while not self.child_done.is_set():
                if self.stop_event.is_set() or self.clock.monotonic() >= self.local_deadline - STOP_BUDGET:
                    self.fence_event.set()
                    # No disk writes or authority I/O on the deadline path.
                    self.fencer.fence()
                    return
                self.child_done.wait(0.05)

        self.watchdog = threading.Thread(target=supervise, daemon=True)
        self.watchdog.start()

    def lease_body(self):
        return {"node": self.node, "instanceId": self.instance_id, "epoch": self.lease["epoch"], "leaseId": self.lease["leaseId"]}

    def wait(self, seconds):
        self.stop_event.wait(seconds)

    def run(self):
        self.lock()
        enrolled = False
        try:
            self.publish("standby")
            if self.stop_event.is_set():
                return 0
            if self.fencer is None:
                self.fencer = SystemdUnitFencer(inspect_guardian_unit(self.config))
            while not self.stop_event.is_set():
                try:
                    if self.node == "primary" and not enrolled:
                        self.enroll_primary()
                        enrolled = True
                    current, _ = self.call("GET", "/v1/status")
                    acquired, started = self.call("POST", "/v1/lease/acquire", {"node": self.node, "instanceId": self.instance_id, "epoch": current["epoch"]})
                    self.fence_event.clear()
                    self.adopt(acquired, started)
                    if self.stop_event.is_set():
                        break
                    # Node's startup guard can read this grant before any DB writes.
                    self.publish("active")
                    if self.clock.monotonic() >= self.local_deadline - STOP_BUDGET or self.stop_event.is_set():
                        raise RemoteError("LEASE_RESPONSE_TOO_LATE")
                    self.child = self.process_factory()
                    self.start_watchdog()
                    self.publish("active")
                    next_renewal = self.clock.monotonic() + RENEW_INTERVAL
                    while not self.stop_event.is_set() and not self.fence_event.is_set():
                        if self.child.poll() is not None:
                            return self.child.returncode or 0
                        remaining = self.local_deadline - self.clock.monotonic()
                        if remaining <= STOP_BUDGET:
                            self.fence_event.set()
                            break
                        if self.clock.monotonic() >= next_renewal:
                            try:
                                renewed, request_started = self.call("POST", "/v1/lease/renew", self.lease_body(), deadline=self.local_deadline - STOP_BUDGET)
                                self.adopt(renewed, request_started)
                                self.publish("active")
                            except Exception as error:
                                self.publish("renewal_unconfirmed", getattr(error, "code", "AUTHORITY_UNREACHABLE"))
                            next_renewal = self.clock.monotonic() + RENEW_INTERVAL
                        self.wait(min(0.2, max(0.01, self.local_deadline - self.clock.monotonic() - STOP_BUDGET)))
                except Exception as error:
                    self.publish("standby", getattr(error, "code", "INSTALLATION_OR_AUTHORITY_UNAVAILABLE"))
                finally:
                    if self.child is not None:
                        stop_group(self.child, self.clock)
                        # Detached children remain in this systemd unit. Never
                        # reacquire after merely stopping the leader's PG.
                        self.fencer.fence()
                        self.child_done.set()
                        self.child = None
                    if self.lease:
                        try:
                            self.call("POST", "/v1/lease/release", self.lease_body(), allow_stopping=True)
                        except Exception:
                            pass
                        self.lease, self.local_deadline = None, None
                if not self.stop_event.is_set():
                    self.wait(RENEW_INTERVAL)
            return 0
        finally:
            self.publish("stopped")
            self.unlock()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    guardian = Guardian(load_root_config(args.config))
    signal.signal(signal.SIGTERM, lambda *_: guardian.stop_event.set())
    signal.signal(signal.SIGINT, lambda *_: guardian.stop_event.set())
    raise SystemExit(guardian.run())


if __name__ == "__main__":
    main()
