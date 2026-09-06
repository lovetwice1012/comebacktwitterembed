#!/usr/bin/env python3
"""Activate only a validated OCI recovery candidate under a live guardian lease.

This program never imports a backup or starts the primary. It runs as the
guardian's workload process and keeps all direct children in that process group.
The guardian is the final cgroup fencing authority for descendants.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import queue
import re
import secrets
import shlex
import signal
import socket
import stat
import subprocess
import threading
import time
import urllib.request
from urllib.parse import quote, urlsplit


class ActivationError(Exception):
    pass


PUBLIC_MEDIA_ROOT = Path("/var/lib/cbte-recovery")
LOG_CHUNK_BYTES = 64 * 1024
LOG_QUEUE_CHUNKS = 8
LOG_DEFAULT_BYTES = 16 * 1024 * 1024
LOG_MAX_BYTES = 32 * 1024 * 1024
LOG_MAX_FILES = 8


def plain(path: Path, directory: bool = False, private: bool = False):
    if not path.is_absolute() or ".." in path.parts:
        raise ActivationError("An absolute path without traversal is required.")
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ActivationError("Recovery paths must not contain symbolic links.")
        if item != path and not stat.S_ISDIR(info.st_mode):
            raise ActivationError("A recovery path ancestor is not a directory.")
    info = path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ActivationError("Expected a regular recovery file or directory.")
    if private and os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
        raise ActivationError("Recovery configuration and credentials must be root-owned mode 0600.")
    return info


def read_json(path: Path, private: bool = False):
    plain(path, private=private)
    if path.stat().st_size > 1024 * 1024:
        raise ActivationError("Recovery JSON exceeds its size limit.")
    return json.loads(path.read_text(encoding="utf-8"))


def read_lease(path: Path):
    info = plain(path)
    if os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022):
        raise ActivationError("Guardian lease must be root-owned and not writable by other users.")
    return read_json(path)


def atomic_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    plain(path.parent, directory=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name == "posix":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    plain(path, private=True)
    if path.stat().st_size > 256 * 1024:
        raise ActivationError("Environment file exceeds its size limit.")
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, raw = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key.strip()):
            raise ActivationError("Invalid environment-file assignment.")
        parts = shlex.split(raw, comments=False, posix=True)
        if len(parts) > 1:
            raise ActivationError("Environment values containing spaces must be quoted.")
        values[key.strip()] = parts[0] if parts else ""
    return values


def validate_config(config: dict):
    required = {"candidatePointer", "candidateRoot", "releaseDir", "nodePath", "botConfigPath", "authorityUrl", "authorityToken", "leaseFile", "adminBinary", "adminConfigDir", "publicUrl"}
    optional = {"runtimeRoot", "mysqlMemory", "startupTimeoutSeconds", "externalAdminCore", "publicMediaLink", "childLogMaxBytes", "childLogFileCount"}
    if not isinstance(config, dict) or required - set(config) or set(config) - required - optional:
        raise ActivationError("Activation configuration is incomplete or has unsupported keys.")
    if type(config.get("externalAdminCore", False)) is not bool:
        raise ActivationError("externalAdminCore must be a boolean.")
    log_bytes, log_files = config.get("childLogMaxBytes", LOG_DEFAULT_BYTES), config.get("childLogFileCount", 4)
    if type(log_bytes) is not int or not LOG_CHUNK_BYTES <= log_bytes <= LOG_MAX_BYTES or type(log_files) is not int or not 1 <= log_files <= LOG_MAX_FILES:
        raise ActivationError("Child logs require 64 KiB..32 MiB per file and 1..8 retained files per child.")
    for key in required - {"authorityUrl", "authorityToken", "publicUrl"}:
        value = config[key]
        if not isinstance(value, str) or not Path(value).is_absolute() or ".." in Path(value).parts:
            raise ActivationError(f"Invalid configured path: {key}")
    if not isinstance(config["authorityToken"], str) or len(config["authorityToken"]) < 32:
        raise ActivationError("An OCI authority token is required.")
    authority = urlsplit(config["authorityUrl"])
    if authority.username or authority.password or authority.query or authority.fragment or (authority.scheme != "https" and not (authority.scheme == "http" and authority.hostname in {"127.0.0.1", "localhost", "::1"})):
        raise ActivationError("Authority must be HTTPS or loopback HTTP without credentials in its URL.")
    public = urlsplit(config["publicUrl"])
    if public.scheme != "https" or not public.hostname or public.username or public.password:
        raise ActivationError("The public workload URL must be HTTPS.")
    runtime = Path(config.get("runtimeRoot", "/var/lib/cbte-recovery/workload"))
    if not runtime.is_absolute() or runtime == Path(runtime.anchor) or ".." in runtime.parts:
        raise ActivationError("Invalid OCI runtime-state root.")
    if "publicMediaLink" in config:
        value = config["publicMediaLink"]
        link = Path(value) if isinstance(value, str) else Path()
        if not link.is_absolute() or ".." in link.parts or link == PUBLIC_MEDIA_ROOT or not link.is_relative_to(PUBLIC_MEDIA_ROOT):
            raise ActivationError("The public media link must be an absolute descendant of /var/lib/cbte-recovery.")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ActivationError("Authority redirects are not permitted.")


class RotatingChildLog:
    """A bounded pipe drain independent of disk speed, with fixed owned paths."""
    def __init__(self, filename, max_bytes=LOG_DEFAULT_BYTES, file_count=4):
        self.path = Path(filename)
        if not self.path.is_absolute() or ".." in self.path.parts or self.path.name not in {"bot.log", "interactive.log", "reports.log", "core.log"}:
            raise ActivationError("Unexpected child diagnostic log path.")
        if type(max_bytes) is not int or not LOG_CHUNK_BYTES <= max_bytes <= LOG_MAX_BYTES or type(file_count) is not int or not 1 <= file_count <= LOG_MAX_FILES:
            raise ActivationError("Invalid child diagnostic log limits.")
        self.max_bytes, self.file_count = max_bytes, file_count
        self.closed = False
        self._fd, self._size = None, 0
        self._queue = queue.Queue(maxsize=LOG_QUEUE_CHUNKS)
        self._closing, self._reader_done = threading.Event(), threading.Event()
        self._lock = threading.Lock()
        self._enqueue_lock = threading.Lock()
        self._reader = self._writer = self._pipe = None
        self._retry_at = 0
        self._health = {"name": self.path.name, "maxBytesPerFile": max_bytes, "fileCount": file_count,
                        "receivedBytes": 0, "writtenBytes": 0, "droppedBytes": 0, "trimmedBytes": 0,
                        "rotations": 0, "writeError": None, "readError": None}
        try:
            self._open()
        except Exception as error:
            self._failed(error)

    def _archive(self, index):
        return self.path if index == 0 else self.path.with_name(f"{self.path.name}.{index}")

    def _owned(self, filename):
        try:
            info = filename.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(info.st_mode) or (os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600)):
            raise ActivationError("An existing child log is not a root-owned private regular file.")
        return info

    @staticmethod
    def _write_all(descriptor, data):
        offset = 0
        while offset < len(data):
            count = os.write(descriptor, data[offset:])
            if count <= 0:
                raise OSError("Diagnostic log write made no progress.")
            offset += count

    def _cap_existing(self, filename, size):
        if size <= self.max_bytes:
            return
        # Preserve the most recent tail in-place, using constant-sized buffers.
        # This also works on a full disk without creating another large file.
        descriptor = os.open(filename, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
        try:
            read_offset, write_offset = size - self.max_bytes, 0
            while write_offset < self.max_bytes:
                os.lseek(descriptor, read_offset, os.SEEK_SET)
                chunk = os.read(descriptor, min(LOG_CHUNK_BYTES, self.max_bytes - write_offset))
                if not chunk:
                    raise OSError("Diagnostic log changed while its tail was retained.")
                os.lseek(descriptor, write_offset, os.SEEK_SET)
                self._write_all(descriptor, chunk)
                read_offset += len(chunk)
                write_offset += len(chunk)
            os.ftruncate(descriptor, self.max_bytes)
        finally:
            os.close(descriptor)
        with self._lock:
            self._health["trimmedBytes"] += size - self.max_bytes

    def _open(self):
        info = plain(self.path.parent, directory=True)
        if os.name == "posix" and info.st_uid != 0:
            raise ActivationError("The diagnostic log directory is not owned by root.")
        existing = [(self._archive(index), self._owned(self._archive(index))) for index in range(LOG_MAX_FILES)]
        # Check every owned slot before modifying any, and leave unrelated names
        # untouched. Reconfiguration cannot leave older excess archives growing.
        for index, (filename, info) in enumerate(existing):
            if info is None:
                continue
            if index >= self.file_count:
                filename.unlink()
            else:
                self._cap_existing(filename, info.st_size)
        self._fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), 0o600)
        self._size = os.fstat(self._fd).st_size
        with self._lock:
            self._health["writeError"] = None
        self._retry_at = 0

    def _close_fd(self):
        descriptor, self._fd = self._fd, None
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass

    def _failed(self, error):
        self._close_fd()
        self._retry_at = time.monotonic() + 30
        message = f"{type(error).__name__}:{getattr(error, 'errno', None) or 'log_write_failed'}"
        with self._lock:
            changed = self._health["writeError"] != message
            self._health["writeError"] = message
        if changed:
            try:
                os.write(2, f"Child log {self.path.name} unavailable ({message}); output is drained with bounded loss accounting.\n".encode())
            except OSError:
                pass

    def _drop(self, count):
        with self._lock:
            self._health["droppedBytes"] += count

    def _rotate(self):
        self._close_fd()
        for index in range(LOG_MAX_FILES):
            self._owned(self._archive(index))
        last = self._archive(self.file_count - 1)
        last.unlink(missing_ok=True)
        for index in range(self.file_count - 2, -1, -1):
            current = self._archive(index)
            if current.exists():
                os.replace(current, self._archive(index + 1))
        self._open()
        with self._lock:
            self._health["rotations"] += 1

    def _write(self, chunk):
        offset = 0
        try:
            if self._fd is None:
                if time.monotonic() < self._retry_at:
                    self._drop(len(chunk))
                    return
                self._open()
            while offset < len(chunk):
                if self._size >= self.max_bytes:
                    self._rotate()
                size = min(len(chunk) - offset, self.max_bytes - self._size)
                written = os.write(self._fd, chunk[offset:offset + size])
                if written <= 0:
                    raise OSError("Diagnostic log write made no progress.")
                self._size += written
                offset += written
                with self._lock:
                    self._health["writtenBytes"] += written
        except Exception as error:
            self._drop(len(chunk) - offset)
            self._failed(error)

    def _offer(self, chunk):
        with self._enqueue_lock:
            if self._closing.is_set():
                self._drop(len(chunk))
                return
            try:
                self._queue.put_nowait(chunk)
            except queue.Full:
                # Keep the newest diagnostic tail during a log storm. The
                # pipe reader never waits for the disk writer to catch up.
                try:
                    stale = self._queue.get_nowait()
                    self._queue.task_done()
                    self._drop(len(stale))
                except queue.Empty:
                    pass
                try:
                    self._queue.put_nowait(chunk)
                except queue.Full:
                    self._drop(len(chunk))

    def _drain(self):
        try:
            while True:
                chunk = self._pipe.read(LOG_CHUNK_BYTES)
                if not chunk:
                    break
                with self._lock:
                    self._health["receivedBytes"] += len(chunk)
                self._offer(chunk)
        except Exception as error:
            with self._lock:
                self._health["readError"] = type(error).__name__
        finally:
            self._reader_done.set()
            self._pipe.close()

    def _persist(self):
        try:
            while not ((self._closing.is_set() or self._reader_done.is_set()) and self._queue.empty()):
                try:
                    chunk = self._queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                try:
                    self._write(chunk)
                finally:
                    self._queue.task_done()
        finally:
            self._close_fd()

    def attach(self, pipe):
        if self._reader is not None or self.closed:
            raise ActivationError("A child log drain cannot be attached twice.")
        self._pipe = pipe
        self._writer = threading.Thread(target=self._persist, name=f"{self.path.name}-writer", daemon=True)
        self._reader = threading.Thread(target=self._drain, name=f"{self.path.name}-reader", daemon=True)
        self._writer.start()
        self._reader.start()

    def snapshot(self):
        with self._lock:
            return dict(self._health, queuedChunks=self._queue.qsize(), queueCapacityBytes=LOG_QUEUE_CHUNKS * LOG_CHUNK_BYTES,
                        readerRunning=bool(self._reader and self._reader.is_alive()), writerRunning=bool(self._writer and self._writer.is_alive()))

    def close(self, timeout=1):
        deadline = time.monotonic() + max(0, timeout)
        # Give an already-exited process's pipe a bounded opportunity to drain
        # before discarding further output. Descendants can keep a pipe open;
        # those daemon reader threads must not delay the guardian's final fence.
        if self._reader:
            self._reader.join(timeout=max(0, deadline - time.monotonic()))
        with self._enqueue_lock:
            self._closing.set()
        if self._writer:
            self._writer.join(timeout=max(0, deadline - time.monotonic()))
        else:
            self._close_fd()
        self.closed = True


class Backend:
    def run(self, argv, *, input=None, timeout=30, optional=False):
        result = subprocess.run(argv, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        if result.returncode:
            if optional:
                return None
            # SQL input may contain new credentials; never include it or child
            # stderr in public wrapper errors.
            raise ActivationError(f"{Path(argv[0]).name} command failed with exit code {result.returncode}.")
        return result.stdout.decode("utf-8", "replace")

    def authority(self, url, token):
        request = urllib.request.Request(url.rstrip("/") + "/v1/status", headers={"Authorization": "Bearer " + token})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=5) as response:
            value = response.read(65537)
            if len(value) > 65536:
                raise ActivationError("Authority response exceeds its limit.")
            return json.loads(value)

    def port_open(self, port):
        with socket.socket() as connection:
            connection.settimeout(0.3)
            return connection.connect_ex(("127.0.0.1", port)) == 0

    def spawn(self, argv, cwd, environment, log):
        child = subprocess.Popen(argv, cwd=cwd, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, bufsize=0, start_new_session=False, close_fds=True)
        log.attach(child.stdout)
        return child

    def health(self, url, token=None):
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token} if token else {})
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return 200 <= response.status < 300
        except Exception:
            return False

    def admin_events(self, token):
        request = urllib.request.Request("http://127.0.0.1:30988/v1/events?kind=heartbeat&limit=1", headers={"X-Admin-Agent-Token": token})
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(request, timeout=2) as response:
            value = response.read(262145)
            if not 200 <= response.status < 300 or len(value) > 262144:
                raise ActivationError("Management heartbeat response is invalid or exceeds its limit.")
            return json.loads(value)


class Workload:
    def __init__(self, config: dict, backend=None, environment=None):
        validate_config(config)
        self.config = config
        self.backend = backend or Backend()
        self.environment = dict(os.environ if environment is None else environment)
        self.stop_event = threading.Event()
        self.children = []
        self.logs = []
        self.candidate = None
        self.runtime = None
        self.owned_container = False
        self.activated = False
        self.bot_spawned_at = None
        self.gateway_proof = None
        self.application_health_evidence = {}
        self.reporting_degraded = False
        self.observability_degraded = False
        self.last_receipt_write_at = 0
        self.bootstrap_verified = False

    def guardian_lease_check(self, minimum_remaining_ms=0):
        lease = read_lease(Path(self.config["leaseFile"]))
        epoch = lease.get("epoch")
        if lease.get("node") != "oci" or lease.get("state") not in ("active", "renewal_unconfirmed") or type(epoch) is not int or not lease.get("instanceId"):
            raise ActivationError("The guardian has no active OCI lease.")
        if self.environment.get("CBTE_FLEET_NODE") != "oci" or self.environment.get("CBTE_FLEET_EPOCH") != str(epoch) or self.environment.get("CBTE_FLEET_LEASE_FILE") != self.config["leaseFile"]:
            raise ActivationError("Guardian environment does not match the lease file.")
        valid_until = float(lease.get("validUntilUnixMs", 0))
        if not math.isfinite(valid_until) or valid_until <= time.time() * 1000 + minimum_remaining_ms:
            raise ActivationError("The local guardian lease is expired or too close to its stop deadline.")
        if self.candidate and self.candidate.get("epoch") != epoch:
            raise ActivationError("The selected candidate belongs to a different authority epoch.")
        return lease

    def authority_check(self):
        lease = self.guardian_lease_check(minimum_remaining_ms=3000)
        epoch = lease["epoch"]
        live = self.backend.authority(self.config["authorityUrl"], self.config["authorityToken"])
        remote = live.get("lease") or {}
        if live.get("activeNode") != "oci" or live.get("epoch") != epoch or remote.get("node") != "oci" or remote.get("instanceId") != lease["instanceId"] or remote.get("valid") is not True:
            raise ActivationError("Live authority does not confirm this OCI guardian lease.")
        if float(remote.get("expiresAt", 0)) <= float(live.get("serverTime", time.time())):
            raise ActivationError("The authority lease has expired.")
        return lease

    def load_candidate(self):
        pointer = read_json(Path(self.config["candidatePointer"]), private=True)
        identifier = pointer.get("id")
        if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{24}", identifier):
            raise ActivationError("Invalid candidate identifier.")
        root = Path(self.config["candidateRoot"])
        plain(root, directory=True)
        directory = Path(pointer.get("directory", ""))
        if directory != root / identifier:
            raise ActivationError("Candidate directory is outside its configured root.")
        plain(directory, directory=True)
        original = read_json(directory / "receipt.json", private=True)
        for key in ["id", "container", "directory", "mysqlImage", "manifest", "checks"]:
            if original.get(key) != pointer.get(key):
                raise ActivationError("Candidate pointer does not match its restore receipt.")
        if pointer.get("phase") not in {"VALIDATED", "ACTIVE"} or original.get("phase") not in {"VALIDATED", "ACTIVATING", "ACTIVE", "STOPPED", "ACTIVATION_FAILED"}:
            raise ActivationError("Only validated recovery candidates may be activated.")
        checks = pointer.get("checks") or {}
        if checks.get("ciphertextVerified") is not True or checks.get("importCompleted") is not True or not str(checks.get("engine", "")).startswith("8.0.") or checks.get("eventScheduler") not in {"OFF", "DISABLED"}:
            raise ActivationError("Candidate validation evidence is incomplete.")
        if pointer.get("container") != "cbte-dr-" + identifier or not re.fullmatch(r"mysql@sha256:[0-9a-f]{64}", pointer.get("mysqlImage", "")):
            raise ActivationError("Candidate Docker identity is invalid.")
        plain(directory / "data", directory=True)
        plain(directory / "secrets", directory=True)
        plain(directory / "secrets" / "client.cnf", private=True)
        plain(directory / "secrets" / "root-password", private=True)
        self.candidate = pointer
        return pointer

    def container_info(self):
        raw = self.backend.run(["docker", "inspect", self.candidate["container"]], timeout=10, optional=True)
        if raw is None:
            return None
        rows = json.loads(raw)
        if not isinstance(rows, list) or len(rows) != 1:
            raise ActivationError("Unexpected Docker inspection response.")
        info = rows[0]
        labels = info.get("Config", {}).get("Labels") or {}
        if labels.get("cbte.recovery") != "true" or labels.get("cbte.restore-id") != self.candidate["id"] or info.get("Config", {}).get("Image") != self.candidate["mysqlImage"]:
            raise ActivationError("Docker container ownership or pinned image does not match the candidate.")
        expected = {"/var/lib/mysql": str(Path(self.candidate["directory"]) / "data"), "/run/cbte-secrets": str(Path(self.candidate["directory"]) / "secrets")}
        mounts = {mount.get("Destination"): mount for mount in info.get("Mounts", [])}
        for destination, source in expected.items():
            if mounts.get(destination, {}).get("Type") != "bind" or mounts[destination].get("Source") != source:
                raise ActivationError("Docker data or credential mount differs from the validated candidate.")
        if mounts["/run/cbte-secrets"].get("RW") is not False:
            raise ActivationError("Candidate root credentials must be mounted read-only.")
        if info.get("HostConfig", {}).get("NetworkMode") not in {"none", "host"}:
            raise ActivationError("Unexpected candidate Docker network mode.")
        self.owned_container = True
        return info

    def mysql(self, sql, timeout=10):
        if not self.owned_container:
            raise ActivationError("Cannot access a database whose ownership is unverified.")
        return self.backend.run(["docker", "exec", "-i", self.candidate["container"], "mysql", "--defaults-extra-file=/run/cbte-secrets/client.cnf", "--batch", "--skip-column-names"], input=sql.encode(), timeout=timeout)

    def active_container_command(self):
        directory = Path(self.candidate["directory"])
        return ["docker", "run", "-d", "--pull=never", "--name", self.candidate["container"], "--label", "cbte.recovery=true", "--label", "cbte.restore-id=" + self.candidate["id"], "--label", "cbte.activation-epoch=" + str(self.candidate["epoch"]), "--network", "host", "--restart", "no", "--memory", str(self.config.get("mysqlMemory", "8g")), "--cpus", "2", "--pids-limit", "512", "--mount", f"type=bind,src={directory / 'data'},dst=/var/lib/mysql", "--mount", f"type=bind,src={directory / 'secrets'},dst=/run/cbte-secrets,readonly", "-e", "MYSQL_ROOT_PASSWORD_FILE=/run/cbte-secrets/root-password", "-e", "MYSQL_INITDB_SKIP_TZINFO=1", self.candidate["mysqlImage"], "--bind-address=127.0.0.1", "--port=3306", "--mysqlx=OFF", "--event-scheduler=OFF", "--skip-log-bin", "--local-infile=OFF", "--max-connections=64", "--innodb-buffer-pool-size=1073741824", "--read-only=ON", "--super-read-only=ON"]

    def activate_database(self):
        self.authority_check()
        info = self.container_info()
        current_host = info and info.get("HostConfig", {}).get("NetworkMode") == "host"
        if self.backend.port_open(3306) and not (current_host and info.get("State", {}).get("Running") is True):
            raise ActivationError("OCI port 3306 belongs to another database; it will not be touched.")
        required = {"--bind-address": "127.0.0.1", "--port": "3306", "--mysqlx": "OFF", "--event-scheduler": "OFF"}
        supplied = {item.partition("=")[0]: item.partition("=")[2] for item in (info or {}).get("Config", {}).get("Cmd", []) if "=" in item}
        reusable = current_host and all(supplied.get(key) == value for key, value in required.items())
        if not reusable:
            self.write_phase("ACTIVATING", "Changing only the owned candidate from isolated to loopback host networking.")
            if info:
                self.backend.run(["docker", "stop", "--time", "10", self.candidate["container"]], timeout=20)
                self.backend.run(["docker", "rm", self.candidate["container"]], timeout=15)
            self.authority_check()
            self.backend.run(self.active_container_command(), timeout=90)
        elif info.get("State", {}).get("Running") is not True:
            self.backend.run(["docker", "start", self.candidate["container"]], timeout=30)
        self.container_info()
        deadline = time.monotonic() + 120
        while not self.stop_event.is_set():
            try:
                self.mysql("SELECT 1;", timeout=3)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise ActivationError("Owned candidate MySQL did not become ready.")
                self.stop_event.wait(1)
        if self.stop_event.is_set():
            raise ActivationError("Activation was stopped.")
        self.mysql("SET GLOBAL event_scheduler=OFF; SET GLOBAL read_only=ON; SET GLOBAL super_read_only=ON;")
        return self.provision_database_user()

    def prepare_runtime(self):
        root = Path(self.config.get("runtimeRoot", "/var/lib/cbte-recovery/workload"))
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        plain(root, directory=True)
        self.runtime = root / self.candidate["id"]
        self.runtime.mkdir(mode=0o700, exist_ok=True)
        marker = self.runtime / "oci-state-origin.json"
        if marker.exists():
            if read_json(marker, private=True).get("candidateId") != self.candidate["id"]:
                raise ActivationError("OCI runtime state belongs to another candidate.")
        else:
            if list(self.runtime.iterdir()):
                raise ActivationError("Refusing unmarked or copied administrator state.")
            atomic_json(marker, {"candidateId": self.candidate["id"], "origin": "fresh-oci-state", "createdAt": time.time(), "savedataMigrated": False})
        for name in ["admin", "interactive", "reports", "support", "saves", "logs", "telemetry", "bootstrap"]:
            directory = self.runtime / name
            directory.mkdir(mode=0o700, exist_ok=True)
            plain(directory, directory=True)

    def prepare_public_media(self):
        configured = self.config.get("publicMediaLink")
        if not configured:
            return
        self.authority_check()
        link = Path(configured)
        root = Path(self.config.get("runtimeRoot", "/var/lib/cbte-recovery/workload"))
        saves = self.runtime / "saves"
        for directory in [link.parent, root, self.runtime, saves]:
            info = plain(directory, directory=True)
            if info.st_uid != 0:
                raise ActivationError("Public media paths must be managed by root.")
        if os.name == "posix" and stat.S_IMODE(link.parent.stat().st_mode) & 0o022:
            raise ActivationError("The public media link parent must not be writable by other users.")
        try:
            existing = link.lstat()
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if not stat.S_ISLNK(existing.st_mode) or existing.st_uid != 0:
                raise ActivationError("An existing public media path is not an owned symlink and will not be replaced.")
            previous = Path(os.readlink(link))
            if (not previous.is_absolute() or ".." in previous.parts or not previous.is_relative_to(root)
                    or len(previous.relative_to(root).parts) != 2 or previous.name != "saves"
                    or not re.fullmatch(r"[0-9a-f]{24}", previous.parent.name)):
                raise ActivationError("The existing public media symlink points outside managed candidate saves.")
            try:
                if plain(previous, directory=True).st_uid != 0 or plain(previous.parent, directory=True).st_uid != 0:
                    raise ActivationError("The previous media target is not managed by root.")
                marker = read_json(previous.parent / "oci-state-origin.json", private=True)
            except (FileNotFoundError, NotADirectoryError, json.JSONDecodeError) as cause:
                raise ActivationError("The existing public media symlink has no readable candidate ownership receipt.") from cause
            if marker.get("candidateId") != previous.parent.name or marker.get("origin") != "fresh-oci-state" or marker.get("savedataMigrated") is not False:
                raise ActivationError("The existing public media symlink has no valid candidate ownership receipt.")
        # Traverse only the two state ancestors; do not grant directory listing
        # or access to sibling administrator, bootstrap, log, or credential data.
        self.backend.run(["setfacl", "-m", "u:www-data:--x", "--", str(root), str(self.runtime)], timeout=10)
        self.backend.run(["setfacl", "-R", "-P", "-m", "u:www-data:rX", "--", str(saves)], timeout=60)
        self.backend.run(["find", str(saves), "-type", "d", "-exec", "setfacl", "-m", "d:u:www-data:r-x", "--", "{}", "+"], timeout=60)
        self.guardian_lease_check()
        temporary = link.with_name(f".{link.name}.{secrets.token_hex(8)}.tmp")
        try:
            os.symlink(str(saves), temporary, target_is_directory=True)
            created = temporary.lstat()
            if not stat.S_ISLNK(created.st_mode) or created.st_uid != 0:
                raise ActivationError("The new public media link is not owned by root.")
            os.replace(temporary, link)
            if os.name == "posix":
                descriptor = os.open(link.parent, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)

    def provision_database_user(self):
        credentials_file = self.runtime / "database-user.json"
        if credentials_file.exists():
            credentials = read_json(credentials_file, private=True)
            if credentials.get("candidateId") != self.candidate["id"] or credentials.get("user") != "cbte_oci" or not re.fullmatch(r"[0-9a-f]{64}", credentials.get("password", "")):
                raise ActivationError("Invalid OCI database-user receipt.")
        else:
            credentials = {"candidateId": self.candidate["id"], "user": "cbte_oci", "password": secrets.token_hex(32)}
            atomic_json(credentials_file, credentials)
        self.authority_check()
        password = credentials["password"]
        # The production Node driver is mysql@2.18.1, whose authentication
        # switch handler supports mysql_native_password, not MySQL 8's default
        # caching_sha2_password. Pin this account's plugin on creation AND on
        # reentry; the candidate engine is separately constrained to MySQL 8.0.
        self.mysql("SET GLOBAL super_read_only=OFF; SET GLOBAL read_only=OFF;\n"
                   f"CREATE USER IF NOT EXISTS 'cbte_oci'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY '{password}';\n"
                   f"ALTER USER 'cbte_oci'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY '{password}';\n"
                   "GRANT ALL PRIVILEGES ON ComebackTwitterEmbed.* TO 'cbte_oci'@'127.0.0.1';\n", timeout=15)
        return credentials

    def environments(self, credentials):
        directory = Path(self.config["adminConfigDir"])
        plain(directory, directory=True)
        common = env_file(directory / "common.env")
        configs = {name: common | env_file(directory / file) for name, file in {"core": "core.env", "interactive": "analysis.env", "reports": "reports.env", "bot": "bot.env"}.items()}
        tokens = {values.get("ADMIN_AGENT_TOKEN") for values in configs.values() if values.get("ADMIN_AGENT_TOKEN")}
        owners = {values.get("ADMIN_OWNER_ID") for values in configs.values() if values.get("ADMIN_OWNER_ID")}
        if len(tokens) != 1 or len(next(iter(tokens), "")) < 32 or len(owners) != 1:
            raise ActivationError("OCI service environment files must agree on one management token and owner.")
        token, owner = next(iter(tokens)), next(iter(owners))
        if not re.fullmatch(r"[0-9]{16,22}", owner):
            raise ActivationError("The OCI administrator must be an explicit Discord user ID.")
        clean = {key: value for key, value in self.environment.items() if value != self.config["authorityToken"] and key not in {"CBTE_AUTHORITY_TOKEN", "RECOVERY_OCI_TOKEN", "RECOVERY_CONTROLLER_TOKEN", "RECOVERY_PRIMARY_TOKEN"}}
        public = self.config["publicUrl"].rstrip("/")
        shared = {"NODE_ENV": "production", "DB_HOST": "127.0.0.1", "DB_USER": credentials["user"], "DB_PASSWORD": credentials["password"], "DB_DATABASE": "ComebackTwitterEmbed", "DB_CHARSET": "utf8mb4", "DATABASE_URL": f"mysql://{quote(credentials['user'], safe='')}:{quote(credentials['password'], safe='')}@127.0.0.1:3306/ComebackTwitterEmbed?connection_limit=8", "ADMIN_AGENT_TOKEN": token, "ADMIN_OWNER_ID": owner, "ADMIN_AGENT_URL": "http://127.0.0.1:30988", "ADMIN_AGENT_WORKER_URL": "http://127.0.0.1:30990/execute", "ADMIN_AGENT_REPORT_WORKER_URL": "http://127.0.0.1:30991/execute", "ADMIN_AGENT_WORKER": str(Path(self.config["releaseDir"]) / "src/adminSupport/worker.js"), "ADMIN_AGENT_WORKER_DIR": self.config["releaseDir"], "ADMIN_AGENT_NODE": self.config["nodePath"], "ADMIN_SUPPORT_DATA_DIR": str(self.runtime / "support"), "SAVES_DIR": str(self.runtime / "saves"), "ADMIN_TELEMETRY_DIR": str(self.runtime / "telemetry"), "ADMIN_QUERY_REGISTRY_DIR": str(self.runtime / "support/report-queries"), "ADMIN_PROVIDER_OVERRIDE_FILE": str(self.runtime / "support/provider-source-overrides.json"), "CBTE_FLEET_LEASE_FILE": self.config["leaseFile"], "CBTE_FLEET_NODE": "oci", "CBTE_FLEET_EPOCH": str(self.candidate["epoch"]), "CBTE_RECOVERY_SAVEDATA_MIGRATED": "false", "NEXTAUTH_URL": public, "DASHBOARD_BASE_URL": public, "DASHBOARD_PORT": "30989", "PORT": "30989", "DASHBOARD_INTEGRATED_MEDIA_SERVER": "true", "MEDIA_DELIVERY_PUBLIC_BASE_URL": public, "ADMIN_AGENT_LOCAL_HEALTH_URL": "http://127.0.0.1:30989/api/health", "ADMIN_AGENT_STATE_DIR": str(self.runtime / "admin")}
        result = {name: clean | values | shared for name, values in configs.items()}
        for environment in result.values():
            environment.pop("CBTE_RECOVERY_BOOTSTRAP_ID", None)
            environment.pop("CBTE_RECOVERY_BOOTSTRAP_DIR", None)
            environment.update(ADMIN_ANALYSIS_NODE=self.config["nodePath"], ADMIN_ANALYSIS_WORKER=shared["ADMIN_AGENT_WORKER"], ADMIN_ANALYSIS_WORKER_DIR=self.config["releaseDir"], ADMIN_AGENT_PUBLIC_URL=configs["core"].get("ADMIN_AGENT_PUBLIC_URL", public + "/manager"), ADMIN_AGENT_BASE_PATH=configs["core"].get("ADMIN_AGENT_BASE_PATH", "/manager"), ADMIN_AGENT_BOT_UNIT="cbte-recovery-workload.service")
        result["core"]["ADMIN_AGENT_LISTEN"] = "127.0.0.1:30988"
        result["core"]["ADMIN_AGENT_PUBLIC_URL"] = configs["core"].get("ADMIN_AGENT_PUBLIC_URL", public + "/manager")
        result["core"]["ADMIN_AGENT_BASE_PATH"] = configs["core"].get("ADMIN_AGENT_BASE_PATH", "/manager")
        result["core"].update(ADMIN_AGENT_WORKER_TIMEOUT_SECONDS="120", ADMIN_AGENT_REPORT_TIMEOUT_SECONDS="900")
        result["interactive"].update(ADMIN_ANALYSIS_LISTEN="127.0.0.1:30990", ADMIN_ANALYSIS_STATE_DIR=str(self.runtime / "interactive"), ADMIN_WORKER_DEADLINE_MS="110000")
        result["reports"].update(ADMIN_ANALYSIS_LISTEN="127.0.0.1:30991", ADMIN_ANALYSIS_STATE_DIR=str(self.runtime / "reports"), ADMIN_ANALYSIS_ACTIONS="reports.build", ADMIN_WORKER_DEADLINE_MS="780000")
        result["interactive"].pop("ADMIN_ANALYSIS_ACTIONS", None)
        result["bot"].update(DASHBOARD_DISABLED="false", DISABLE_DASHBOARD="false",
                             # OCI backups belong exclusively to the encrypted
                             # active-backup timer; never run legacy plain gzip dumps.
                             DB_DUMP_DISABLED="true", DB_DUMP_RUN_ON_START="false",
                             CBTE_RECOVERY_BOOTSTRAP_ID=self.candidate["id"],
                             CBTE_RECOVERY_BOOTSTRAP_DIR=str(self.runtime / "bootstrap"))
        return result

    def install_bot_config(self, credentials):
        release = Path(self.config["releaseDir"])
        plain(release, directory=True)
        for relative in ["index.js", "src/adminSupport/worker.js", "src/recoveryBootstrap.js", "admin-agent/analysis-server.cjs", "dashboard/package.json"]:
            plain(release / relative)
        plain(Path(self.config["nodePath"]))
        plain(Path(self.config["adminBinary"]))
        config = read_json(Path(self.config["botConfigPath"]), private=True)
        if not isinstance(config, dict) or not isinstance(config.get("token"), str) or not config["token"]:
            raise ActivationError("The OCI Bot configuration has no Discord credential.")
        config["db"] = {"host": "127.0.0.1", "user": credentials["user"], "password": credentials["password"], "database": "ComebackTwitterEmbed", "charset": "utf8mb4"}
        config["dashboard"] = (config.get("dashboard") or {}) | {"enabled": True, "port": 30989, "publicBaseUrl": self.config["publicUrl"].rstrip("/")}
        atomic_json(release / "config.json", config)

    def write_phase(self, phase, reason=None):
        if not self.candidate:
            return
        record = dict(self.candidate)
        record.update(phase=phase, activationUpdatedAt=time.time(), activationEpoch=self.candidate["epoch"], savedataMigrated=False, activationReason=reason)
        # Only this process's verified heartbeat can authorize its activation;
        # do not carry a prior activation proof out of a reused pointer.
        for key in ["gatewayReadyAt", "botPid", "bootId", "botSpawnedAt", "gatewayProofVerifiedAt"]:
            record.pop(key, None)
        proof = self.gateway_proof or {}
        log_health = [log.snapshot() for log in self.logs]
        record.update(proof, observabilityDegraded=self.observability_degraded, reportingDegraded=self.reporting_degraded,
                      applicationHealth=self.application_health_evidence, bootstrapComplete=self.bootstrap_verified, childLogs=log_health)
        atomic_json(Path(self.candidate["directory"]) / "receipt.json", record)
        if self.runtime:
            atomic_json(self.runtime / "activation.json", {"candidateId": self.candidate["id"], "container": self.candidate["container"], "phase": phase, "epoch": self.candidate["epoch"], "updatedAt": time.time(), "savedataMigrated": False, "reason": reason, "observabilityDegraded": self.observability_degraded, "reportingDegraded": self.reporting_degraded, "applicationHealth": self.application_health_evidence, "bootstrapComplete": self.bootstrap_verified, "childLogs": log_health, **proof, "children": [{"name": name, "pid": process.pid} for name, process in self.children]})
        self.last_receipt_write_at = time.time()

    def start_children(self, environments):
        release = Path(self.config["releaseDir"])
        commands = [("interactive", [self.config["nodePath"], str(release / "admin-agent/analysis-server.cjs")]), ("reports", [self.config["nodePath"], str(release / "admin-agent/analysis-server.cjs")]), ("core", [self.config["adminBinary"]]), ("bot", [self.config["nodePath"], str(release / "index.js")])]
        ports = [30988, 30989, 30990, 30991]
        if self.config.get("externalAdminCore", False):
            commands = [(name, command) for name, command in commands if name != "core"]
            ports.remove(30988)
        for port in ports:
            if self.backend.port_open(port):
                raise ActivationError(f"OCI workload port {port} is already occupied; an existing process will not be replaced.")
        self.authority_check()
        for name, command in commands:
            if self.stop_event.is_set():
                raise ActivationError("Activation was stopped before all child processes started.")
            log = RotatingChildLog(self.runtime / "logs" / f"{name}.log",
                                   self.config.get("childLogMaxBytes", LOG_DEFAULT_BYTES), self.config.get("childLogFileCount", 4))
            self.logs.append(log)
            if name == "bot":
                self.bot_spawned_at = time.time()
            child = self.backend.spawn(command, str(release), environments[name], log)
            self.children.append((name, child))

    def gateway_readiness(self, token, now=None):
        """Return proof from this Bot instance, never from a stale restored event."""
        bot = next((child for name, child in self.children if name == "bot"), None)
        if bot is None or bot.poll() is not None or self.bot_spawned_at is None:
            return None
        try:
            response = self.backend.admin_events(token)
            now = time.time() if now is None else now
            items = response.get("items") if isinstance(response, dict) else None
            if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
                return None
            item = items[0]
            payload = item.get("payload") or {}
            details = payload.get("details") or {}
            if (item.get("kind") != "heartbeat" or details.get("ready") is not True
                    or type(details.get("pid")) is not int or details["pid"] != bot.pid
                    or payload.get("fleet_node") != "oci"
                    or type(payload.get("fleet_epoch")) not in (str, int)
                    or str(payload["fleet_epoch"]) != str(self.candidate["epoch"])):
                return None
            boot_id = payload.get("boot_id")
            if not isinstance(boot_id, str) or not boot_id or len(boot_id) > 128:
                return None
            occurred = item.get("occurredAt")
            stamp = datetime.fromisoformat(occurred.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                return None
            occurred_at = stamp.timestamp()
            if occurred_at < self.bot_spawned_at or not 0 <= now - occurred_at <= 45:
                return None
            return {"gatewayReadyAt": occurred, "botPid": bot.pid, "bootId": boot_id,
                    "botSpawnedAt": datetime.fromtimestamp(self.bot_spawned_at, timezone.utc).isoformat(),
                    "gatewayProofVerifiedAt": now}
        except Exception:
            # A core outage or a missing event is an observation gap, not proof
            # that an already-activated independent Bot has failed.
            return None

    def application_health(self):
        endpoints = {"interactive": self.backend.health("http://127.0.0.1:30990/health"),
                     "reports": self.backend.health("http://127.0.0.1:30991/health"),
                     "dashboard": self.backend.health("http://127.0.0.1:30989/api/health")}
        try:
            database_ready = self.mysql("SELECT 1;", timeout=3).strip() == "1"
        except Exception:
            database_ready = False
        reports = next((child for name, child in self.children if name == "reports"), None)
        report_exit = reports.poll() if reports is not None else None
        self.reporting_degraded = not endpoints["reports"] or report_exit is not None
        self.application_health_evidence = {"observedAt": time.time(), **endpoints, "database": database_ready,
                                           "reportsRequiredForInitialActivation": not self.activated, "reportProcessExitCode": report_exit}
        # Report computation/response delivery is not a prerequisite for an
        # already verified Bot to keep serving. Initial activation still waits
        # for the complete service group; interactive/dashboard/DB remain required.
        return endpoints["interactive"] and endpoints["dashboard"] and database_ready and (self.activated or not self.reporting_degraded)

    def bootstrap_ready(self):
        try:
            directory = self.runtime / "bootstrap"
            state = read_json(directory / "bootstrap.json", private=True)
            return (isinstance(state, dict) and state.get("version") == 1
                    and state.get("candidateId") == self.candidate["id"]
                    and state.get("directory") == str(directory)
                    and state.get("complete") is True
                    and all((state.get("tables", {}).get(kind) or {}).get("complete") is True
                            for kind in ["autoextract_targets", "deregister_pending", "error_incidents"]))
        except Exception:
            return False

    def fence_database(self):
        if not self.owned_container:
            return
        try:
            self.mysql("SET GLOBAL event_scheduler=OFF; SET GLOBAL read_only=ON; SET GLOBAL super_read_only=ON;", timeout=3)
        except Exception:
            try:
                self.backend.run(["docker", "stop", "--time", "1", self.candidate["container"]], timeout=3)
            except Exception:
                pass

    def shutdown(self):
        self.stop_event.set()
        self.fence_database()
        for _, child in self.children:
            if child.poll() is None:
                try:
                    child.terminate()
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 3
        for _, child in self.children:
            if child.poll() is None:
                try:
                    child.wait(timeout=max(0.01, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    child.kill()
        log_deadline = time.monotonic() + 1
        for log in self.logs:
            log.close(timeout=max(0, log_deadline - time.monotonic()))
        # The guardian then kills every remaining descendant in its verified
        # systemd cgroup, including any per-action worker process groups.

    def run(self):
        try:
            self.load_candidate()
            self.authority_check()
            self.prepare_runtime()
            self.prepare_public_media()
            credentials = self.activate_database()
            environments = self.environments(credentials)
            self.install_bot_config(credentials)
            self.authority_check()
            self.start_children(environments)
            started = time.monotonic()
            startup_limit = min(900, max(30, int(self.config.get("startupTimeoutSeconds", 300))))
            failures = 0
            while not self.stop_event.is_set():
                for name, child in self.children:
                    if child.poll() is not None:
                        if self.activated and name == "reports":
                            continue
                        raise ActivationError(f"OCI workload child exited: {name}.")
                self.guardian_lease_check()
                prior_reporting_degraded = self.reporting_degraded
                healthy = self.application_health()
                reporting_changed = prior_reporting_degraded != self.reporting_degraded
                proof = self.gateway_readiness(environments["core"]["ADMIN_AGENT_TOKEN"])
                self.guardian_lease_check()  # Network/SQL probes must not outlive the lease.
                if proof:
                    self.gateway_proof = proof
                degraded = proof is None
                observation_changed = degraded != self.observability_degraded
                self.observability_degraded = degraded
                if not self.activated:
                    self.bootstrap_verified = self.bootstrap_ready()
                    healthy = healthy and self.bootstrap_verified
                if not self.activated or not self.config.get("externalAdminCore", False):
                    healthy = healthy and proof is not None
                if healthy:
                    failures = 0
                    if not self.activated:
                        self.activated = True
                        self.write_phase("ACTIVE", "A fresh heartbeat confirms this OCI Bot is Gateway-ready; MySQL and workload endpoints are healthy. Saved media was intentionally not migrated.")
                    elif reporting_changed:
                        self.write_phase("ACTIVE", "Report worker health is unconfirmed; the independently verified Bot and required endpoints remain running." if self.reporting_degraded else "Report worker health has recovered without restarting the Bot.")
                    elif observation_changed:
                        self.write_phase("ACTIVE", "Management observation is unavailable; the independently healthy OCI workload remains running." if degraded else "Management observation of the current OCI Bot has recovered.")
                    elif proof and proof["gatewayProofVerifiedAt"] - self.last_receipt_write_at >= 15:
                        self.write_phase("ACTIVE", "The current OCI Bot remains Gateway-ready with a live database and healthy required endpoints; report health is recorded separately.")
                elif self.activated:
                    failures += 1
                    if failures >= 3:
                        failed = [name for name in ("interactive", "dashboard", "database") if self.application_health_evidence.get(name) is False]
                        raise ActivationError("Required OCI application checks failed: " + (", ".join(failed) or "Gateway proof"))
                elif time.monotonic() - started > startup_limit:
                    raise ActivationError("OCI application group did not become healthy before its startup deadline.")
                self.stop_event.wait(2)
            self.write_phase("STOPPED", "Guardian requested workload stop.")
            return 0
        except Exception as error:
            try:
                self.write_phase("ACTIVATION_FAILED", str(error) if isinstance(error, ActivationError) else "Activation failed; inspect private workload logs.")
            except Exception:
                pass
            return 1
        finally:
            self.shutdown()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    if os.name != "posix" or os.getuid() != 0:
        raise SystemExit("OCI activation wrapper requires the root-owned Linux guardian.")
    if os.getpgrp() != os.getpid():
        raise SystemExit("OCI wrapper must be the guardian's isolated workload process-group leader.")
    workload = Workload(read_json(args.config, private=True))
    signal.signal(signal.SIGTERM, lambda *_: workload.stop_event.set())
    signal.signal(signal.SIGINT, lambda *_: workload.stop_event.set())
    raise SystemExit(workload.run())


if __name__ == "__main__":
    main()
