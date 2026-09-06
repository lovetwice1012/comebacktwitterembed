#!/usr/bin/env python3
"""Durable, fail-closed role lease authority (Python standard library only).

Usage: python3 authority.py --config /etc/cbte-recovery/authority.json
Config: {listen: "127.0.0.1:34210", database: "/var/lib/cbte-recovery/authority.db",
 clusterId: "cbte", tokens: {primary: "...", oci: "...", controller: "..."},
 enrollmentPolicy: {unit, installationId, guardianSha256, commandSha256}}

The authority database is control-plane state, NEVER an application restore input.
Every start fences old leases logically and quarantines grants for 150 seconds.
This does not fence an unenrolled legacy primary: OCI promotion is forbidden until
the installed primary guardian supplies the pinned, signed installation proof.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import http.server
import json
import math
import os
from pathlib import Path
import secrets
import signal
import sqlite3
import stat
import threading
import time
from urllib.parse import urlsplit

TTL = 90.0
STOP_MARGIN = 20.0
DRAIN = 60.0
CLOCK_JUMP_TOLERANCE = 5.0
CHALLENGE_TTL = 120.0
PROOF_DOMAIN = b"CBTE_PRIMARY_ENROLLMENT_V1\n"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def boottime():
    if hasattr(time, "CLOCK_BOOTTIME"):
        return time.clock_gettime(time.CLOCK_BOOTTIME)
    return time.monotonic()


class Clock:
    wall = staticmethod(time.time)
    monotonic = staticmethod(boottime)


class AuthorityError(Exception):
    def __init__(self, code, message, status=409, **details):
        super().__init__(message)
        self.code, self.status, self.details = code, status, details


def load_root_config(path):
    path = Path(path)
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or path.is_symlink():
        raise ValueError("Configuration must be a regular, non-symlink file")
    if os.name == "posix" and (st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o077):
        raise ValueError("Configuration must be root-owned and mode 0600 or stricter")
    with path.open("r", encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise ValueError("Configuration must be a JSON object")
    return value


class Authority:
    def __init__(self, config, clock=None):
        self.config = config
        self.clock = clock or Clock()
        self.lock = threading.RLock()
        self.cluster_id = config.get("clusterId", "cbte")
        self.tokens = config.get("tokens", {})
        if set(self.tokens) != {"primary", "oci", "controller"}:
            raise ValueError("Three separate primary, oci and controller tokens are required")
        if any(not isinstance(t, str) or len(t) < 32 for t in self.tokens.values()) or len(set(self.tokens.values())) != 3:
            raise ValueError("Role tokens must be distinct and at least 32 characters")
        database = Path(config["database"])
        database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(str(database), timeout=5, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS authority(
 id INTEGER PRIMARY KEY CHECK(id=1),cluster_id TEXT NOT NULL,epoch INTEGER NOT NULL,
 active_node TEXT NOT NULL,armed INTEGER NOT NULL DEFAULT 0,primary_enrolled INTEGER NOT NULL DEFAULT 0,
 enrollment TEXT,lease_id TEXT,lease_node TEXT,lease_instance TEXT,lease_expires REAL NOT NULL DEFAULT 0,
 drain_until REAL NOT NULL DEFAULT 0,quarantine_until REAL NOT NULL DEFAULT 0,boot_id TEXT NOT NULL,
 last_wall REAL NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ledger(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,at REAL NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,nonce TEXT NOT NULL,expires REAL NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS promotions(idempotency_key TEXT PRIMARY KEY,input_hash TEXT NOT NULL,result TEXT NOT NULL);
""")
        os.chmod(database, 0o600)
        self.boot_id = secrets.token_hex(24)
        self.last_wall, self.last_mono = self.clock.wall(), self.clock.monotonic()
        self.clock_anchor_wall, self.clock_anchor_mono = self.last_wall, self.last_mono
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                previous = self.db.execute("SELECT * FROM authority WHERE id=1").fetchone()
                if previous is not None and previous["cluster_id"] != self.cluster_id:
                    raise ValueError("Authority database belongs to a different cluster")
                quarantine = self.last_wall + TTL + DRAIN
                if previous is None:
                    self.db.execute("INSERT INTO authority(id,cluster_id,epoch,active_node,quarantine_until,boot_id,last_wall) VALUES(1,?,1,'primary',?,?,?)", (self.cluster_id, quarantine, self.boot_id, self.last_wall))
                else:
                    quarantine = max(quarantine, previous["quarantine_until"], previous["lease_expires"] + DRAIN, previous["last_wall"] + TTL + DRAIN)
                    self.db.execute("UPDATE authority SET epoch=epoch+1,lease_id=NULL,lease_node=NULL,lease_instance=NULL,quarantine_until=?,drain_until=MAX(drain_until,?),boot_id=?,last_wall=?,revision=revision+1 WHERE id=1", (quarantine, quarantine, self.boot_id, self.last_wall))
                    if previous["primary_enrolled"]:
                        saved_proof = json.loads(previous["enrollment"])["proof"]
                        policy = self.config.get("enrollmentPolicy", {})
                        if any(saved_proof.get(key) != policy.get(key) for key in ("unit", "installationId", "guardianSha256", "commandSha256")):
                            self.db.execute("UPDATE authority SET primary_enrolled=0,armed=0 WHERE id=1")
                self._event("authority.started", {"bootId": self.boot_id, "quarantineUntil": quarantine})
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def close(self):
        self.db.close()

    def role_for_token(self, token):
        for role, expected in self.tokens.items():
            if hmac.compare_digest(token.encode(), expected.encode()):
                return role
        raise AuthorityError("UNAUTHORIZED", "A recovery role token is required", 401)

    def _event(self, event, value):
        self.db.execute("INSERT INTO ledger(event,at,payload) VALUES(?,?,?)", (event, self.clock.wall(), canonical(value)))

    def _state(self):
        return self.db.execute("SELECT * FROM authority WHERE id=1").fetchone()

    def _check_clock(self):
        if self._state()["boot_id"] != self.boot_id:
            raise AuthorityError("AUTHORITY_REPLACED", "A newer authority process owns this state; stop this instance", 503)
        wall, mono = self.clock.wall(), self.clock.monotonic()
        difference = (wall - self.clock_anchor_wall) - (mono - self.clock_anchor_mono)
        if abs(difference) > CLOCK_JUMP_TOLERANCE or mono < self.last_mono:
            row = self._state()
            quarantine = max(wall + TTL + DRAIN, row["lease_expires"] + DRAIN, row["quarantine_until"], self.last_wall + TTL + DRAIN)
            self.db.execute("UPDATE authority SET epoch=epoch+1,lease_id=NULL,lease_node=NULL,lease_instance=NULL,quarantine_until=?,drain_until=MAX(drain_until,?),revision=revision+1 WHERE id=1", (quarantine, quarantine))
            self._event("authority.clock_quarantine", {"differenceSeconds": difference, "quarantineUntil": quarantine})
            self.clock_anchor_wall, self.clock_anchor_mono = wall, mono
        self.db.execute("UPDATE authority SET last_wall=? WHERE id=1", (wall,))
        self.last_wall, self.last_mono = wall, mono

    def call(self, method, path, role, data=None):
        data = data or {}
        if not isinstance(data, dict):
            raise AuthorityError("INVALID_BODY", "JSON object required", 400)
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self._check_clock()
                result = self._dispatch(method, path, role, data)
                self.db.execute("COMMIT")
                return result
            except AuthorityError:
                # Clock quarantine and one-use enrollment challenge decisions must
                # survive rejected requests, including stale renewals.
                self.db.execute("COMMIT")
                raise
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def _dispatch(self, method, path, role, data):
        if method == "GET" and path == "/v1/status":
            return self.status(role)
        if method != "POST":
            raise AuthorityError("NOT_FOUND", "Unknown recovery endpoint", 404)
        if path == "/v1/lease/acquire":
            return self.acquire(role, data)
        if path == "/v1/lease/renew":
            return self.renew(role, data)
        if path == "/v1/lease/release":
            return self.release(role, data)
        if path == "/v1/primary/enroll/challenge":
            return self.challenge(role, data)
        if path == "/v1/primary/enroll":
            return self.enroll(role, data)
        if path == "/v1/arm":
            return self.arm(role, data)
        if path == "/v1/promote":
            return self.promote(role, data)
        raise AuthorityError("NOT_FOUND", "Unknown recovery endpoint", 404)

    def status(self, role):
        row = self._state()
        return {"ok": True, "clusterId": self.cluster_id, "epoch": row["epoch"], "activeNode": row["active_node"], "armed": bool(row["armed"]), "primaryEnrolled": bool(row["primary_enrolled"]), "authorityBootId": row["boot_id"], "serverTime": self.clock.wall(), "leaseTtlSeconds": TTL, "stopMarginSeconds": STOP_MARGIN, "promotionDrainSeconds": DRAIN, "quarantineUntil": row["quarantine_until"], "drainUntil": row["drain_until"], "lease": {"node": row["lease_node"], "instanceId": row["lease_instance"], "expiresAt": row["lease_expires"], "valid": bool(row["lease_id"]) and row["lease_expires"] > self.clock.wall()}, "revision": row["revision"]}

    def _node(self, role, data):
        node, instance = data.get("node"), data.get("instanceId")
        if role not in ("primary", "oci") or node != role:
            raise AuthorityError("ROLE_MISMATCH", "Node role cannot impersonate another node", 403)
        if not isinstance(instance, str) or not 1 <= len(instance) <= 200:
            raise AuthorityError("INVALID_INSTANCE", "A bounded instanceId is required", 400)
        return node, instance

    def _epoch(self, data, row):
        if type(data.get("epoch", data.get("expectedEpoch"))) is not int or data.get("epoch", data.get("expectedEpoch")) != row["epoch"]:
            raise AuthorityError("STALE_EPOCH", "Reload the current authority epoch", currentEpoch=row["epoch"])

    def _quarantine(self, row):
        if self.clock.wall() < row["quarantine_until"]:
            raise AuthorityError("AUTHORITY_QUARANTINED", "Prior leases are quarantined after authority start or clock change", retryAfterSeconds=math.ceil(row["quarantine_until"] - self.clock.wall()))

    def _lease_response(self, row):
        return {"ok": True, "node": row["lease_node"], "instanceId": row["lease_instance"], "epoch": row["epoch"], "leaseId": row["lease_id"], "expiresAt": row["lease_expires"], "serverTime": self.clock.wall(), "ttlSeconds": max(0, row["lease_expires"] - self.clock.wall()), "stopMarginSeconds": STOP_MARGIN, "authorityBootId": row["boot_id"]}

    def acquire(self, role, data):
        node, instance = self._node(role, data)
        row = self._state()
        self._epoch(data, row)
        self._quarantine(row)
        if node != row["active_node"]:
            raise AuthorityError("NOT_ACTIVE_NODE", "This node is standby", activeNode=row["active_node"])
        if node == "oci" and not row["primary_enrolled"]:
            raise AuthorityError("PRIMARY_NOT_ENROLLED", "Legacy primary has no verified guardian enrollment")
        if row["lease_id"] and row["lease_expires"] > self.clock.wall():
            if row["lease_node"] == node and row["lease_instance"] == instance:
                return self._lease_response(row)
            raise AuthorityError("LEASE_HELD", "Another instance still holds the workload lease")
        if self.clock.wall() < row["drain_until"]:
            raise AuthorityError("LEASE_DRAINING", "Previous lease must expire and drain", retryAfterSeconds=math.ceil(row["drain_until"] - self.clock.wall()))
        expires = self.clock.wall() + TTL
        self.db.execute("UPDATE authority SET lease_id=?,lease_node=?,lease_instance=?,lease_expires=?,drain_until=?,revision=revision+1 WHERE id=1", (secrets.token_hex(32), node, instance, expires, expires + DRAIN))
        self._event("lease.acquired", {"node": node, "instanceId": instance, "epoch": row["epoch"], "expiresAt": expires})
        return self._lease_response(self._state())

    def _holder(self, role, data):
        node, instance = self._node(role, data)
        row = self._state()
        self._epoch(data, row)
        self._quarantine(row)
        supplied = data.get("leaseId", "")
        if node != row["active_node"] or node != row["lease_node"] or instance != row["lease_instance"] or not isinstance(supplied, str) or not row["lease_id"] or not hmac.compare_digest(supplied, row["lease_id"]):
            raise AuthorityError("LEASE_MISMATCH", "Lease identity no longer owns this workload")
        return row

    def renew(self, role, data):
        row = self._holder(role, data)
        if self.clock.wall() >= row["lease_expires"]:
            raise AuthorityError("LEASE_EXPIRED", "An expired lease cannot be renewed")
        expires = self.clock.wall() + TTL
        self.db.execute("UPDATE authority SET lease_expires=?,drain_until=?,revision=revision+1 WHERE id=1", (expires, expires + DRAIN))
        return self._lease_response(self._state())

    def release(self, role, data):
        row = self._holder(role, data)
        # A release cannot shorten the original expiry/drain safety interval.
        self.db.execute("UPDATE authority SET lease_id=NULL,lease_node=NULL,lease_instance=NULL,revision=revision+1 WHERE id=1")
        self._event("lease.released", {"node": role, "instanceId": data["instanceId"], "epoch": row["epoch"], "drainUntil": row["drain_until"]})
        return {"ok": True, "released": True, "drainUntil": row["drain_until"], "epoch": row["epoch"]}

    def challenge(self, role, data):
        if role != "primary":
            raise AuthorityError("PRIMARY_ROLE_REQUIRED", "Only the primary guardian can enroll", 403)
        instance = data.get("instanceId")
        if not isinstance(instance, str) or not 1 <= len(instance) <= 200:
            raise AuthorityError("INVALID_INSTANCE", "instanceId is required", 400)
        policy = self.config.get("enrollmentPolicy", {})
        if not all(isinstance(policy.get(key), str) and policy[key] for key in ("unit", "installationId", "guardianSha256", "commandSha256")):
            raise AuthorityError("ENROLLMENT_NOT_CONFIGURED", "Pinned primary installation policy is required")
        identifier, nonce = secrets.token_hex(24), secrets.token_hex(32)
        expires = self.clock.wall() + CHALLENGE_TTL
        self.db.execute("DELETE FROM challenges WHERE expires<?", (self.clock.wall(),))
        self.db.execute("INSERT INTO challenges(id,instance_id,nonce,expires) VALUES(?,?,?,?)", (identifier, instance, nonce, expires))
        return {"ok": True, "challengeId": identifier, "nonce": nonce, "expiresAt": expires, "clusterId": self.cluster_id}

    def enroll(self, role, data):
        if role != "primary":
            raise AuthorityError("PRIMARY_ROLE_REQUIRED", "Controller and OCI cannot assert primary enrollment", 403)
        proof, instance, signature = data.get("proof"), data.get("instanceId"), data.get("signature", "")
        if not isinstance(proof, dict) or not isinstance(signature, str):
            raise AuthorityError("INVALID_PROOF", "Signed installation proof required", 400)
        row = self.db.execute("SELECT * FROM challenges WHERE id=?", (proof.get("challengeId", ""),)).fetchone()
        if row is None or row["used"] or row["expires"] <= self.clock.wall() or row["instance_id"] != instance or row["nonce"] != proof.get("nonce"):
            raise AuthorityError("INVALID_CHALLENGE", "Enrollment challenge expired, reused or mismatched")
        self.db.execute("UPDATE challenges SET used=1 WHERE id=?", (row["id"],))
        signed = PROOF_DOMAIN + canonical({"clusterId": self.cluster_id, "instanceId": instance, "proof": proof}).encode()
        expected = hmac.new(self.tokens["primary"].encode(), signed, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise AuthorityError("INVALID_SIGNATURE", "Installation proof signature rejected", 403)
        policy = self.config.get("enrollmentPolicy", {})
        if any(proof.get(key) != policy.get(key) or not policy.get(key) for key in ("unit", "installationId", "guardianSha256", "commandSha256")):
            raise AuthorityError("INSTALLATION_MISMATCH", "Proof does not match the pinned primary installation")
        pid = proof.get("guardianPid")
        if type(pid) is not int or pid <= 0 or proof.get("mainPid") != pid or proof.get("killMode") != "control-group" or proof.get("cgroupPids") != [pid] or not proof.get("hostBootId") or not proof.get("execStartVerified") or proof.get("workloadStarted") is not False:
            raise AuthorityError("INCOMPLETE_INSTALLATION_PROOF", "Guardian must be the systemd main process with no existing workload children")
        saved = {"instanceId": instance, "proof": proof, "signature": signature, "enrolledAt": self.clock.wall()}
        self.db.execute("UPDATE authority SET primary_enrolled=1,enrollment=?,revision=revision+1 WHERE id=1", (canonical(saved),))
        self._event("primary.enrolled", {"installationId": proof["installationId"], "instanceId": instance, "guardianSha256": proof["guardianSha256"]})
        return {"ok": True, "primaryEnrolled": True, "installationId": proof["installationId"]}

    def arm(self, role, data):
        if role != "controller":
            raise AuthorityError("CONTROLLER_REQUIRED", "Controller role required", 403)
        row = self._state()
        self._epoch(data, row)
        if type(data.get("armed")) is not bool:
            raise AuthorityError("INVALID_ARMING", "armed must be a boolean", 400)
        if data["armed"] and not row["primary_enrolled"]:
            raise AuthorityError("PRIMARY_NOT_ENROLLED", "Automatic activation cannot be armed for an unenrolled legacy primary")
        self.db.execute("UPDATE authority SET armed=?,revision=revision+1 WHERE id=1", (int(data["armed"]),))
        self._event("authority.armed", {"armed": data["armed"], "epoch": row["epoch"]})
        return self.status(role)

    def promote(self, role, data):
        if role != "controller":
            raise AuthorityError("CONTROLLER_REQUIRED", "Controller role required", 403)
        if data.get("target") != "oci":
            raise AuthorityError("FAILBACK_FORBIDDEN", "This API only promotes OCI; automatic failback is forbidden", 400)
        key = data.get("idempotencyKey")
        if not isinstance(key, str) or not 1 <= len(key) <= 200:
            raise AuthorityError("IDEMPOTENCY_REQUIRED", "A bounded idempotencyKey is required", 400)
        digest = hashlib.sha256(canonical(data).encode()).hexdigest()
        prior = self.db.execute("SELECT * FROM promotions WHERE idempotency_key=?", (key,)).fetchone()
        if prior is not None:
            if prior["input_hash"] != digest:
                raise AuthorityError("IDEMPOTENCY_CONFLICT", "Promotion key belongs to different input")
            return json.loads(prior["result"])
        row = self._state()
        self._epoch(data, row)
        if not row["primary_enrolled"]:
            raise AuthorityError("PRIMARY_NOT_ENROLLED", "Legacy primary has no installed guardian proof; HTTP failure never authorizes promotion")
        if not row["armed"]:
            raise AuthorityError("NOT_ARMED", "Automatic promotion is not armed")
        self._quarantine(row)
        if row["active_node"] != "primary":
            raise AuthorityError("ALREADY_PROMOTED", "OCI is already active; inspect current status")
        if row["lease_id"] and row["lease_expires"] > self.clock.wall():
            raise AuthorityError("PRIMARY_LEASE_ACTIVE", "Primary still holds a valid role lease")
        if self.clock.wall() < max(row["drain_until"], row["lease_expires"] + DRAIN):
            raise AuthorityError("LEASE_DRAINING", "Expired primary lease has not completed the promotion drain")
        epoch = row["epoch"] + 1
        changed = self.db.execute("UPDATE authority SET active_node='oci',epoch=?,lease_id=NULL,lease_node=NULL,lease_instance=NULL,revision=revision+1 WHERE id=1 AND epoch=? AND active_node='primary'", (epoch, row["epoch"])).rowcount
        if changed != 1:
            raise AuthorityError("CAS_CONFLICT", "Authority changed during promotion")
        result = {"ok": True, "activeNode": "oci", "epoch": epoch, "previousEpoch": row["epoch"], "promotedAt": self.clock.wall(), "idempotencyKey": key}
        self.db.execute("INSERT INTO promotions(idempotency_key,input_hash,result) VALUES(?,?,?)", (key, digest, canonical(result)))
        self._event("authority.promoted", result)
        return result


def make_server(authority, listen):
    host, separator, port = listen.rpartition(":")
    if separator != ":" or host != "127.0.0.1" or not port.isdigit():
        raise ValueError("Authority must listen on 127.0.0.1 and an explicit port")

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "CBTERecovery/1"

        def log_message(self, fmt, *args):
            return  # No headers, credentials or payloads in HTTP access logs.

        def respond(self, status, result):
            payload = canonical(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def handle_api(self):
            try:
                self.connection.settimeout(5)
                token = self.headers.get("Authorization", "")
                if not token.startswith("Bearer "):
                    raise AuthorityError("UNAUTHORIZED", "Bearer role token required", 401)
                role = authority.role_for_token(token[7:])
                data = {}
                if self.command == "POST":
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 32768:
                        raise AuthorityError("INVALID_LENGTH", "JSON body must be 1..32768 bytes", 400)
                    data = json.loads(self.rfile.read(length))
                result = authority.call(self.command, urlsplit(self.path).path, role, data)
                self.respond(200, result)
            except AuthorityError as error:
                self.respond(error.status, {"ok": False, "error": {"code": error.code, "message": str(error), **error.details}})
            except (ValueError, TypeError, json.JSONDecodeError):
                self.respond(400, {"ok": False, "error": {"code": "INVALID_REQUEST", "message": "Invalid request body"}})
            except (sqlite3.Error, OSError):
                self.respond(503, {"ok": False, "error": {"code": "AUTHORITY_UNAVAILABLE", "message": "Durable authority state could not be confirmed"}})

        do_GET = handle_api
        do_POST = handle_api

    server = http.server.ThreadingHTTPServer((host, int(port)), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = load_root_config(args.config)
    authority = Authority(config)
    server = make_server(authority, config.get("listen", "127.0.0.1:34210"))
    stopping = threading.Event()

    def stop(signum, frame):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        authority.close()


if __name__ == "__main__":
    main()
