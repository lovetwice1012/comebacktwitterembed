#!/usr/bin/env python3
"""Idempotent, one-way Cloudflare routing for a verified active OCI workload.

Parent integration:
    ensure_routes(load_config('/etc/cbte-recovery/routing.json'), epoch)

Root-only JSON config keys: cloudflared, originCertificate, tunnelId, hostnames,
stateDir, authorityUrl, authorityToken, leaseFile. Hostnames are deployment policy,
never an HTTP request parameter. Public readiness is HTTP 200 JSON with ok=true,
node='oci', matching epoch and current guardian instanceId (top-level or fleet).

No primary route rollback is implemented. Command timeouts are unknown outcomes:
the next call first reconciles public readiness before repeating the SAME pinned
overwrite operation. A successful CLI exit is not proof of healthy public routing.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit

try:
    from .restore_mysql import atomic_json, read_json
except ImportError:
    from restore_mysql import atomic_json, read_json

COMMAND_TIMEOUT = 20.0
PROBE_TIMEOUT = 5.0
MIN_LEASE_REMAINING = 40.0
LOCAL_HEALTH = "http://127.0.0.1:30989/api/health"
MAX_OUTPUT_BYTES = 32768
REQUIRED = {"cloudflared", "originCertificate", "tunnelId", "hostnames", "stateDir", "authorityUrl", "authorityToken", "leaseFile"}
_locks = {}
_locks_guard = threading.Lock()


class RoutingError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class VerifiedConfig(dict):
    def __init__(self, value, path, fingerprint):
        super().__init__(value)
        self.source_path, self.fingerprint = path, fingerprint


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def check_ownership(info, mask, code, message, posix=None):
    if (os.name == "posix" if posix is None else posix) and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) & mask):
        raise RoutingError(code, message)


def private_file(path):
    file = Path(path)
    if not file.is_absolute() or file.is_symlink():
        raise RoutingError("UNTRUSTED_FILE", "Recovery credential/config paths must be absolute regular files")
    info = file.stat()
    if not stat.S_ISREG(info.st_mode):
        raise RoutingError("UNTRUSTED_FILE", "Routing config and origin certificate must be root-owned mode 0600 or stricter")
    check_ownership(info, 0o077, "UNTRUSTED_FILE", "Routing config and origin certificate must be root-owned mode 0600 or stricter")
    return file


def load_config(path):
    file = private_file(path)
    if file.stat().st_size > 65536:
        raise RoutingError("CONFIG_TOO_LARGE", "Routing configuration exceeds its limit")
    source = file.read_bytes()
    value = json.loads(source)
    if not isinstance(value, dict) or set(value) != REQUIRED:
        raise RoutingError("INVALID_CONFIG", "Routing configuration keys are incomplete or unsupported")
    try:
        parsed_id = str(uuid.UUID(value["tunnelId"]))
    except (ValueError, TypeError, AttributeError):
        raise RoutingError("INVALID_TUNNEL", "A pinned tunnel UUID is required") from None
    if parsed_id != value["tunnelId"]:
        raise RoutingError("INVALID_TUNNEL", "Use the canonical lowercase tunnel UUID")
    hostnames = value["hostnames"]
    if not isinstance(hostnames, list) or not 1 <= len(hostnames) <= 10 or len(set(hostnames)) != len(hostnames):
        raise RoutingError("INVALID_HOSTNAMES", "An explicit, unique hostname allowlist is required")
    for hostname in hostnames:
        if not isinstance(hostname, str) or len(hostname) > 253 or hostname != hostname.lower() or "." not in hostname or any(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) is None for label in hostname.split(".")):
            raise RoutingError("INVALID_HOSTNAMES", "Hostname allowlist cannot contain URLs, ports or wildcards")
    for key in ("cloudflared", "originCertificate", "stateDir", "leaseFile"):
        if not isinstance(value[key], str) or not Path(value[key]).is_absolute() or ".." in Path(value[key]).parts:
            raise RoutingError("INVALID_PATH", "Configured paths must be absolute without traversal")
    private_file(value["originCertificate"])
    binary = Path(value["cloudflared"])
    info = binary.stat()
    if binary.name not in ("cloudflared", "cloudflared.exe") or binary.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise RoutingError("UNTRUSTED_EXECUTABLE", "cloudflared must be an installed root-owned executable")
    check_ownership(info, 0o022, "UNTRUSTED_EXECUTABLE", "cloudflared must be an installed root-owned executable")
    authority = urlsplit(value["authorityUrl"])
    if authority.scheme != "http" or authority.hostname not in {"127.0.0.1", "localhost", "::1"} or authority.username is not None or authority.password is not None or authority.query or authority.fragment or authority.path not in ("", "/"):
        raise RoutingError("INVALID_AUTHORITY", "Authority must be an authenticated fixed loopback tunnel")
    if not isinstance(value["authorityToken"], str) or len(value["authorityToken"]) < 32:
        raise RoutingError("INVALID_AUTHORITY_TOKEN", "An authority status role token is required")
    return VerifiedConfig(value, str(file), hashlib.sha256(source).hexdigest())


def revalidate_config(config):
    if not isinstance(config, VerifiedConfig):
        raise RoutingError("CONFIG_NOT_VERIFIED", "Load the root-owned routing configuration with routing.load_config()")
    actual = load_config(config.source_path)
    if actual.fingerprint != config.fingerprint or dict(actual) != dict(config):
        raise RoutingError("CONFIG_CHANGED", "Routing deployment configuration changed; reload and re-evaluate it")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Backend:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def json_get(self, url, token=None):
        headers = {"Cache-Control": "no-cache, no-store"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(url, headers=headers)
        try:
            with self.opener.open(request, timeout=PROBE_TIMEOUT) as response:
                raw = response.read(65537)
                if len(raw) > 65536:
                    return {"status": response.status, "error": "RESPONSE_TOO_LARGE"}
                try:
                    value = json.loads(raw)
                except ValueError:
                    return {"status": response.status, "error": "NON_JSON_RESPONSE"}
                return {"status": response.status, "body": value, "headers": dict(response.headers)}
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            return {"status": status, "error": "HTTP_REJECTED"}
        except (OSError, urllib.error.URLError, http.client.HTTPException):
            return {"status": None, "error": "CONNECTION_OR_TLS_FAILURE"}

    def authority(self, config):
        response = self.json_get(config["authorityUrl"].rstrip("/") + "/v1/status", config["authorityToken"])
        if response.get("status") != 200 or not isinstance(response.get("body"), dict) or response["body"].get("ok") is not True:
            raise RoutingError("AUTHORITY_UNAVAILABLE", "Current authority ownership could not be confirmed")
        return response["body"]

    def probe(self, url):
        separator = "&" if "?" in url else "?"
        return self.json_get(url + separator + "recovery_probe=" + secrets.token_hex(12))

    def route(self, config, hostname):
        argv = [config["cloudflared"], "tunnel", "--origincert", config["originCertificate"], "route", "dns", "--overwrite-dns", config["tunnelId"], hostname]
        started = time.monotonic()
        try:
            process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env={"PATH": os.defpath}, cwd=config["stateDir"])
        except OSError:
            return {"state": "failed", "code": "CLI_START_FAILED", "started": False}
        outputs = {"stdout": bytearray(), "stderr": bytearray()}
        truncated = {"stdout": False, "stderr": False}

        def collect(name, stream):
            try:
                for chunk in iter(lambda: stream.read(4096), b""):
                    outputs[name].extend(chunk)
                    if len(outputs[name]) > MAX_OUTPUT_BYTES:
                        del outputs[name][:-MAX_OUTPUT_BYTES]
                        truncated[name] = True
            finally:
                stream.close()

        readers = [threading.Thread(target=collect, args=(name, getattr(process, name)), daemon=True) for name in outputs]
        for thread in readers:
            thread.start()
        outcome = "failed"
        try:
            code = process.wait(timeout=COMMAND_TIMEOUT)
            outcome = "accepted" if code == 0 else "failed"
        except subprocess.TimeoutExpired:
            outcome, code = "unknown", None
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        finally:
            for thread in readers:
                thread.join(timeout=0.5)
        return {"state": outcome, "started": True, "exitCode": code, "durationSeconds": round(time.monotonic()-started, 3), "stdout": outputs["stdout"].decode("utf-8", "replace"), "stderr": outputs["stderr"].decode("utf-8", "replace"), "truncated": truncated}


def verified_health(response, epoch, instance_id):
    if response.get("status") != 200:
        return False
    body = response.get("body")
    if not isinstance(body, dict) or body.get("ok") is not True:
        return False
    identities = []
    if any(key in body for key in ("node", "epoch", "instanceId")):
        identities.append({key: body.get(key) for key in ("node", "epoch", "instanceId")})
    if "fleet" in body:
        if not isinstance(body["fleet"], dict):
            return False
        identities.append(body["fleet"])
    headers = {str(key).lower(): value for key, value in response.get("headers", {}).items()}
    if any(key in headers for key in ("x-cbte-fleet-node", "x-cbte-fleet-epoch", "x-cbte-fleet-instance-id")):
        try:
            header_epoch = int(headers.get("x-cbte-fleet-epoch", ""))
        except (TypeError, ValueError):
            return False
        identities.append({"node": headers.get("x-cbte-fleet-node"), "epoch": header_epoch, "instanceId": headers.get("x-cbte-fleet-instance-id")})
    return bool(identities) and all(value.get("node") == "oci" and type(value.get("epoch")) is int and value["epoch"] == epoch and value.get("instanceId") == instance_id for value in identities)


def active_lease(config, epoch, backend, now=time.time):
    if type(epoch) is not int or epoch <= 0:
        raise RoutingError("INVALID_EPOCH", "A verified candidate epoch is required")
    file = Path(config["leaseFile"])
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 65536:
        raise RoutingError("INVALID_LOCAL_LEASE", "Guardian lease file is unavailable or invalid")
    check_ownership(file.stat(), 0o022, "UNTRUSTED_LOCAL_LEASE", "Guardian lease must be root-owned and not writable by other users")
    lease = json.loads(file.read_text())
    timestamp = now()
    if lease.get("node") != "oci" or lease.get("state") not in ("active", "renewal_unconfirmed") or type(lease.get("epoch")) is not int or lease["epoch"] != epoch or not isinstance(lease.get("instanceId"), str) or not lease["instanceId"]:
        raise RoutingError("LOCAL_LEASE_MISMATCH", "Candidate epoch and current OCI guardian lease do not match")
    try:
        remaining = float(lease["validUntilUnixMs"]) / 1000 - timestamp
        age = timestamp - float(lease["updatedAt"])
    except (KeyError, TypeError, ValueError):
        raise RoutingError("INVALID_LOCAL_LEASE", "Guardian lease timing metadata is missing") from None
    if not math.isfinite(remaining) or not math.isfinite(age) or not remaining >= MIN_LEASE_REMAINING or not -5 <= age <= 25:
        raise RoutingError("LOCAL_LEASE_NOT_FRESH", "A fresh OCI lease with enough command time is required")
    authority = backend.authority(config)
    remote = authority.get("lease") or {}
    if authority.get("activeNode") != "oci" or type(authority.get("epoch")) is not int or authority["epoch"] != epoch or remote.get("valid") is not True or remote.get("node") != "oci" or remote.get("instanceId") != lease["instanceId"]:
        raise RoutingError("AUTHORITY_LEASE_MISMATCH", "Live authority does not confirm this OCI workload")
    try:
        expiry, server_time = float(remote["expiresAt"]), float(authority["serverTime"])
        if not math.isfinite(expiry) or not math.isfinite(server_time) or expiry <= server_time:
            raise RoutingError("AUTHORITY_LEASE_EXPIRED", "Authority lease has expired")
    except (KeyError, TypeError, ValueError):
        raise RoutingError("AUTHORITY_LEASE_INVALID", "Authority timing proof is incomplete") from None
    return lease


def reconfirm_lease(config, epoch, backend, instance_id, now):
    current = active_lease(config, epoch, backend, now)
    if current["instanceId"] != instance_id:
        raise RoutingError("LEASE_INSTANCE_CHANGED", "Guardian instance changed during routing verification; restart the read checks")
    return current


def ensure_routes(config, epoch, backend=None, now=time.time):
    """Return verified/pending per-record state; never choose another tunnel.

    Backend/clock arguments are dependency-injection hooks for offline tests.
    Production callers must use the root-verified config returned by load_config.
    """
    revalidate_config(config)
    backend = backend or Backend()
    root = Path(config["stateDir"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        raise RoutingError("UNTRUSTED_STATE_DIRECTORY", "Routing receipts require a private root-owned directory")
    check_ownership(root.stat(), 0o077, "UNTRUSTED_STATE_DIRECTORY", "Routing receipts require a private root-owned directory")
    with _locks_guard:
        lock = _locks.setdefault(str(root), threading.Lock())
    if not lock.acquire(blocking=False):
        return {"ok": False, "state": "busy", "epoch": epoch, "records": []}
    lock_file = None
    try:
        lock_file = open(root / "routing.lock", "a+b")
        if os.name == "posix":
            import fcntl
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"ok": False, "state": "busy", "epoch": epoch, "records": []}
        lease = active_lease(config, epoch, backend, now)
        if not verified_health(backend.probe(LOCAL_HEALTH), epoch, lease["instanceId"]):
            raise RoutingError("LOCAL_READINESS_UNVERIFIED", "Local OCI readiness must confirm candidate epoch and instance before public routing")
        binding_path = root / "target-binding.json"
        binding = read_json(binding_path)
        if binding and binding.get("tunnelId") != config["tunnelId"]:
            raise RoutingError("PINNED_TARGET_CHANGED", "Automatic routing cannot replace its pinned OCI tunnel with another target")
        if not binding:
            atomic_json(binding_path, {"tunnelId": config["tunnelId"], "createdAt": now(), "direction": "oci_only"})
        records = []
        for hostname in config["hostnames"]:
            key = hashlib.sha256((str(epoch) + "\0" + hostname).encode()).hexdigest()
            path = root / (key + ".json")
            receipt = read_json(path, {"epoch": epoch, "hostname": hostname, "tunnelId": config["tunnelId"], "state": "not_requested", "attempts": 0, "createdAt": now()})
            if receipt.get("epoch") != epoch or receipt.get("hostname") != hostname or receipt.get("tunnelId") != config["tunnelId"]:
                raise RoutingError("RECEIPT_IDENTITY_MISMATCH", "Routing receipt is bound to a different epoch/hostname/tunnel")
            public = backend.probe("https://" + hostname + "/api/health")
            receipt.update(lastProbe=public, lastProbeAt=now(), expectedInstanceId=lease["instanceId"])
            if verified_health(public, epoch, lease["instanceId"]):
                reconfirm_lease(config, epoch, backend, lease["instanceId"], now)
                receipt.update(state="verified", verifiedAt=now(), updatedAt=now())
                atomic_json(path, receipt)
                records.append(receipt)
                continue
            if now() < float(receipt.get("nextAttemptAt", 0)):
                receipt.update(state="pending_verification", updatedAt=now())
                atomic_json(path, receipt)
                records.append(receipt)
                continue
            # Persist the failed read verification before any idempotent retry.
            receipt.update(state="intent", attempts=receipt["attempts"] + 1, updatedAt=now(), nextAttemptAt=now() + min(300, 15 * 2**min(receipt["attempts"], 5)))
            atomic_json(path, receipt)
            revalidate_config(config)
            lease = active_lease(config, epoch, backend, now)
            if not verified_health(backend.probe(LOCAL_HEALTH), epoch, lease["instanceId"]):
                receipt.update(state="blocked", error={"code":"LOCAL_READINESS_CHANGED"}, updatedAt=now())
                atomic_json(path, receipt)
                records.append(receipt)
                continue
            receipt.update(state="command_running", expectedInstanceId=lease["instanceId"], commandStartedAt=now())
            atomic_json(path, receipt)
            # Persistence/probes may stall; recheck after the last fsync and
            # immediately before the actual DNS side effect.
            reconfirm_lease(config, epoch, backend, lease["instanceId"], now)
            result = backend.route(config, hostname)
            receipt.update(commandResult=result, state="pending_verification" if result["state"] == "accepted" else result["state"], updatedAt=now())
            atomic_json(path, receipt)
            # Route success always means fresh public identity verification.
            public = backend.probe("https://" + hostname + "/api/health")
            receipt.update(lastProbe=public, lastProbeAt=now())
            if verified_health(public, epoch, lease["instanceId"]):
                reconfirm_lease(config, epoch, backend, lease["instanceId"], now)
                receipt.update(state="verified", verifiedAt=now())
            receipt["updatedAt"] = now()
            atomic_json(path, receipt)
            records.append(receipt)
        verified = bool(records) and all(value["state"] == "verified" for value in records)
        return {"ok": verified, "state": "verified" if verified else "pending", "epoch": epoch, "tunnelId": config["tunnelId"], "records": records}
    finally:
        if lock_file:
            lock_file.close()
        lock.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--epoch", type=int, required=True)
    args = parser.parse_args()
    try:
        print(canonical(ensure_routes(load_config(args.config), args.epoch)))
    except RoutingError as error:
        print(canonical({"ok":False,"state":"blocked","error":{"code":error.code,"message":str(error)}}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
