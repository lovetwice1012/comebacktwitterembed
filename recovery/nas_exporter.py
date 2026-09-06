#!/usr/bin/env python3
"""Restricted NAS-side export of verified host MySQL backups.

The original age identity stays on the NAS. Only age-rewrapped zstd ciphertext
is written to the export directory or returned to OCI. No SQL is decrypted to
disk, and callers cannot choose paths, commands, images, or recipients.
"""
from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import hmac
import http.server
import errno
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import stat
import subprocess
import threading
import time
from typing import Callable
from urllib.parse import urlsplit
import uuid


AGE_HEADER = b"age-encryption.org/v1\n"
NAS_IDENTITY = "/volume1/docker/mysql-backup-receiver/age/identity.txt"
RESTORE_IMAGE = "local/cbte-recovery-tools:20260906"
BACKUP_ID = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")
EXPORT_ID = re.compile(r"^[0-9a-f]{64}$")
AGE_RECIPIENT = re.compile(r"^age1[0-9a-z]{58}$")
CHUNK = 1024 * 1024


class ExportError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def backup_timestamp(value: str) -> str:
    if not isinstance(value, str) or not BACKUP_ID.fullmatch(value):
        raise ExportError("INVALID_BACKUP_ID", "backupId must be a UTC backup timestamp.")
    try:
        parsed = dt.datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError as error:
        raise ExportError("INVALID_BACKUP_ID", "backupId contains an invalid UTC date.") from error
    if parsed.strftime("%Y%m%dT%H%M%SZ") != value:
        raise ExportError("INVALID_BACKUP_ID", "backupId is not canonical.")
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def plain_path(path: Path, directory: bool = False) -> os.stat_result:
    """Reject links in every existing path component, not only the basename."""
    if not path.is_absolute() or ".." in path.parts:
        raise ExportError("UNSAFE_PATH", "An absolute path without traversal is required.")
    for ancestor in [*reversed(path.parents), path]:
        info = ancestor.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ExportError("UNSAFE_PATH", "Symbolic links are not accepted.")
        if ancestor != path and not stat.S_ISDIR(info.st_mode):
            raise ExportError("UNSAFE_PATH", "A path ancestor is not a directory.")
    info = path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ExportError("UNSAFE_PATH", "Expected a plain directory or regular file.")
    return info


def open_plain(path: Path):
    before = plain_path(path)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(path, flags)
    current = os.fstat(descriptor)
    if not stat.S_ISREG(current.st_mode) or (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
        os.close(descriptor)
        raise ExportError("SOURCE_CHANGED", "The validated file changed before opening.", 409)
    return os.fdopen(descriptor, "rb")


def read_small(path: Path, limit: int = 8192) -> bytes:
    with open_plain(path) as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ExportError("INVALID_MANIFEST", "Manifest exceeds its size limit.")
    return data


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.partial")
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            parent = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
    finally:
        temporary.unlink(missing_ok=True)


@dataclasses.dataclass(frozen=True)
class Config:
    token: str
    oci_recipient: str
    archive_root: Path = Path("/volume4/yussy_volume4/MySQL-Backups/archive")
    export_root: Path = Path("/volume4/yussy_volume4/CBTE-Recovery/exports")
    active_backup_root: Path | None = None
    listen: str = "127.0.0.1:34220"
    export_timeout_seconds: int = 1800
    max_source_bytes: int = 64 * 1024**3
    max_export_bytes: int = 65 * 1024**3
    max_cache_bytes: int = 128 * 1024**3
    min_free_bytes: int = 1024**3
    retry_cooldown_seconds: int = 60
    keep_ready_exports: int = 3

    def __post_init__(self):
        if self.active_backup_root is None:
            object.__setattr__(self, "active_backup_root", self.export_root.parent / "active-backups")

    def validate(self) -> None:
        if not isinstance(self.token, str) or len(self.token.encode()) < 32:
            raise ExportError("INVALID_CONFIG", "The bearer token must contain at least 32 bytes.")
        if not AGE_RECIPIENT.fullmatch(self.oci_recipient):
            raise ExportError("INVALID_CONFIG", "A pinned X25519 age public recipient is required.")
        if not re.fullmatch(r"127\.0\.0\.1:[0-9]{1,5}", self.listen) or not 1 <= int(self.listen.rsplit(":", 1)[1]) <= 65535:
            raise ExportError("INVALID_CONFIG", "The listener must be a loopback IPv4 address and valid port.")
        if not self.archive_root.is_absolute() or not self.export_root.is_absolute():
            raise ExportError("INVALID_CONFIG", "Storage roots must be absolute paths.")
        archive, exports = self.archive_root.absolute(), self.export_root.absolute()
        if archive == Path(archive.anchor) or exports == Path(exports.anchor) or archive == exports or archive in exports.parents or exports in archive.parents:
            raise ExportError("INVALID_CONFIG", "The export root must be outside the original archive tree.")
        for value in [self.export_timeout_seconds, self.max_source_bytes, self.max_export_bytes, self.max_cache_bytes]:
            if not isinstance(value, int) or value <= 0:
                raise ExportError("INVALID_CONFIG", "Timeout and capacity limits must be positive integers.")
        if self.export_timeout_seconds > 21600 or self.max_source_bytes > 64 * 1024**3 or self.max_export_bytes > 65 * 1024**3:
            raise ExportError("INVALID_CONFIG", "Configured deadline or artifact limit exceeds the hard limit.")
        if self.min_free_bytes < 0 or self.retry_cooldown_seconds < 0:
            raise ExportError("INVALID_CONFIG", "Reserve and cooldown must not be negative.")
        if type(self.keep_ready_exports) is not int or not 2 <= self.keep_ready_exports <= 100:
            raise ExportError("INVALID_CONFIG", "keepReadyExports must be between 2 and 100 (latest source plus an explicitly rebuilt older export).")
        active = self.active_backup_root
        if not active.is_absolute() or active == Path(active.anchor) or active == archive or archive in active.parents or active in archive.parents or active == exports or exports in active.parents or active in exports.parents:
            raise ExportError("INVALID_CONFIG", "Active OCI backups require a separate archive root.")


def load_config(path: Path) -> Config:
    info = plain_path(path)
    if os.name == "nt" or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise ExportError("INVALID_CONFIG", "Production configuration must be root-owned mode 0600 on the NAS.")
    data = json.loads(read_small(path, 65536))
    allowed = {"token", "ociRecipient", "archiveRoot", "exportRoot", "activeBackupRoot", "listen", "exportTimeoutSeconds", "maxSourceBytes", "maxExportBytes", "maxCacheBytes", "minFreeBytes", "retryCooldownSeconds", "keepReadyExports"}
    if not isinstance(data, dict) or set(data) - allowed:
        raise ExportError("INVALID_CONFIG", "Configuration contains unsupported fields.")
    mapping = {"ociRecipient": "oci_recipient", "archiveRoot": "archive_root", "exportRoot": "export_root", "activeBackupRoot": "active_backup_root", "exportTimeoutSeconds": "export_timeout_seconds", "maxSourceBytes": "max_source_bytes", "maxExportBytes": "max_export_bytes", "maxCacheBytes": "max_cache_bytes", "minFreeBytes": "min_free_bytes", "retryCooldownSeconds": "retry_cooldown_seconds", "keepReadyExports": "keep_ready_exports"}
    values = {mapping.get(key, key): value for key, value in data.items()}
    for key in ["archive_root", "export_root", "active_backup_root"]:
        if key in values:
            values[key] = Path(values[key])
    config = Config(**values)
    config.validate()
    return config


def source_metadata(config: Config, backup_id: str) -> tuple[dict, Path]:
    source_time = backup_timestamp(backup_id)
    directory = config.archive_root / "host-mysql" / backup_id[:4] / backup_id[4:6] / backup_id
    plain_path(directory, directory=True)
    name = f"{backup_id}__host-mysql.sql.zst.age"
    if set(os.listdir(directory)) != {name, f"{name}.sha256", ".verified"}:
        raise ExportError("INVALID_ARCHIVE", "Archive set must contain exactly the ciphertext, checksum and verified marker.")
    cipher = directory / name
    info = plain_path(cipher)
    if not 128 <= info.st_size <= config.max_source_bytes:
        raise ExportError("SOURCE_SIZE_LIMIT", "Source ciphertext size is outside the accepted bounds.")
    manifest = read_small(directory / f"{name}.sha256", 512).decode("ascii")
    matched = re.fullmatch(r"([0-9a-fA-F]{64})  " + re.escape(name) + r"\n", manifest)
    if not matched:
        raise ExportError("INVALID_MANIFEST", "Checksum manifest must contain one exact basename and SHA-256 line.")
    expected_hash = matched.group(1).lower()
    marker = {}
    for line in read_small(directory / ".verified", 4096).decode("utf-8").splitlines():
        key, separator, value = line.partition("=")
        if not separator or key in marker:
            raise ExportError("INVALID_VERIFIED_MARKER", "Verified marker contains a duplicate or invalid field.")
        marker[key] = value
    if set(marker) != {"schema", "filename", "sha256", "size", "verified_at"} or marker["schema"] != "1" or marker["filename"] != name or marker["sha256"].lower() != expected_hash or marker["size"] != str(info.st_size):
        raise ExportError("INVALID_VERIFIED_MARKER", "Verified marker does not match the ciphertext manifest.")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", marker["verified_at"]):
        raise ExportError("INVALID_VERIFIED_MARKER", "Verification timestamp must be UTC.")
    dt.datetime.strptime(marker["verified_at"], "%Y-%m-%dT%H:%M:%SZ")
    with open_plain(cipher) as stream:
        if stream.read(len(AGE_HEADER)) != AGE_HEADER:
            raise ExportError("INVALID_AGE_HEADER", "Ciphertext does not have the age v1 header.")
    return {"backupId": backup_id, "scope": "host-mysql", "sourceTimestamp": source_time, "sourceFilename": name, "sourceSha256": expected_hash, "sourceBytes": info.st_size, "verifiedAt": marker["verified_at"]}, cipher


def verify_stream(path: Path, expected_hash: str, expected_bytes: int, deadline: float, output=None) -> None:
    digest, size = hashlib.sha256(), 0
    with open_plain(path) as stream:
        while True:
            if time.monotonic() >= deadline:
                raise ExportError("EXPORT_DEADLINE", "Ciphertext verification exceeded its deadline.", 504)
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > expected_bytes:
                raise ExportError("SOURCE_CHANGED", "Ciphertext grew while it was being read.", 409)
            digest.update(chunk)
            if output:
                output.write(chunk)
    if size != expected_bytes or not hmac.compare_digest(digest.hexdigest(), expected_hash):
        raise ExportError("CHECKSUM_MISMATCH", "Ciphertext checksum or size does not match its verified manifest.", 409)


def docker_command(source: Path, recipient: str, name: str, timeout_seconds: int = 1800) -> list[str]:
    return ["docker", "run", "--rm", "--pull=never", "--name", name, "--network", "none", "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "128m", "--cpus", "1", "--mount", f"type=bind,src={source},dst=/input/source.age,readonly", "--mount", f"type=bind,src={NAS_IDENTITY},dst=/run/nas-age-identity,readonly", "--entrypoint", "/usr/bin/timeout", RESTORE_IMAGE, "-s", "KILL", str(timeout_seconds), "/bin/sh", "-c", 'set -eu; set -o pipefail; age --decrypt --identity /run/nas-age-identity /input/source.age | age --encrypt --recipient "$1"', "cbte-age-rewrap", recipient]


def docker_rewrap(source: Path, destination: Path, recipient: str, deadline: float, max_bytes: int, min_free_bytes: int = 1024**3) -> None:
    identity = plain_path(Path(NAS_IDENTITY))
    if identity.st_uid != 0 or stat.S_IMODE(identity.st_mode) != 0o600:
        raise ExportError("IDENTITY_PERMISSIONS", "The NAS age identity must remain root-owned mode 0600.", 503)
    name = f"cbte-recovery-export-{uuid.uuid4().hex}"
    process = subprocess.Popen(docker_command(source, recipient, name, max(1, int(deadline - time.monotonic()))), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
    chunks: queue.Queue = queue.Queue(maxsize=8)
    stop = threading.Event()
    stderr = bytearray()

    def read_output():
        try:
            while not stop.is_set():
                chunk = process.stdout.read(65536)
                while not stop.is_set():
                    try:
                        chunks.put(chunk, timeout=0.2)
                        break
                    except queue.Full:
                        pass
                if not chunk:
                    return
        finally:
            process.stdout.close()

    def read_error():
        try:
            while True:
                chunk = process.stderr.read(4096)
                if not chunk:
                    break
                if len(stderr) < 65536:
                    stderr.extend(chunk[:65536 - len(stderr)])
        finally:
            process.stderr.close()

    reader = threading.Thread(target=read_output, daemon=True)
    errors = threading.Thread(target=read_error, daemon=True)
    reader.start(); errors.start()
    completed = False
    try:
        size = 0
        with open(destination, "xb") as stream:
            os.chmod(destination, 0o600)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ExportError("EXPORT_DEADLINE", "NAS age rewrap exceeded its deadline.", 504)
                try:
                    chunk = chunks.get(timeout=min(0.2, remaining))
                except queue.Empty:
                    continue
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise ExportError("EXPORT_SIZE_LIMIT", "Rewrapped ciphertext exceeded its size limit.", 507)
                if shutil.disk_usage(destination.parent).free < min_free_bytes + len(chunk):
                    raise ExportError("EXPORT_DISK_LIMIT", "Filesystem free-space reserve was reached during export.", 507)
                stream.write(chunk)
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
            if code != 0:
                # Do not expose raw subprocess stderr, identities, or secrets.
                raise ExportError("AGE_REWRAP_FAILED", f"NAS decrypt/rewrap pipeline failed with exit code {code}.", 502)
            stream.flush(); os.fsync(stream.fileno())
        completed = True
    except subprocess.TimeoutExpired as error:
        raise ExportError("EXPORT_DEADLINE", "NAS age rewrap exceeded its deadline.", 504) from error
    finally:
        stop.set()
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=2)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if not completed:
            # Killing the docker client does not guarantee container termination.
            try:
                subprocess.run(["docker", "rm", "-f", name], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
            except (OSError, subprocess.TimeoutExpired):
                pass  # In-container timeout still bounds an orphaned pipeline.
        reader.join(timeout=1); errors.join(timeout=1)


class DownloadStream:
    def __init__(self, stream, finished):
        self.stream, self.finished = stream, finished
        self.closed = False

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def close(self):
        if not self.closed:
            self.closed = True
            try:
                self.stream.close()
            finally:
                self.finished()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class Exporter:
    def __init__(self, config: Config, rewrap: Callable = docker_rewrap):
        config.validate()
        self.config, self.rewrap = config, rewrap
        plain_path(config.archive_root, directory=True)
        config.export_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        plain_path(config.export_root, directory=True)
        self.lock = threading.RLock()
        self.active_upload_lock = threading.Lock()
        self.active_id = None
        self.jobs: dict[str, dict] = {}
        self.downloads: dict[str, int] = {}
        self.retention_errors = []
        self.worker = None
        for entry in config.export_root.iterdir():
            if not EXPORT_ID.fullmatch(entry.name):
                continue
            plain_path(entry, directory=True)
            state_file = entry / "state.json"
            if not state_file.exists():
                continue
            state = json.loads(read_small(state_file, 65536))
            if state.get("exportId") != entry.name:
                raise ExportError("INVALID_EXPORT_STATE", "An export state record has an invalid ID.", 503)
            if state.get("state") in {"queued", "running"}:
                state.update(state="interrupted", error={"code": "EXPORT_INTERRUPTED", "message": "Exporter stopped before the ciphertext was committed."}, retryAfterEpoch=time.time())
                atomic_json(state_file, state)
            self.jobs[entry.name] = state
        self.prune_ready_exports()

    def prune_ready_exports(self):
        """Retire only validated, owned completed ciphertext; keep all receipts."""
        with self.lock:
            ready = [state for state in self.jobs.values() if state.get("state") == "ready"]
            if ready:
                newest_source = max(ready, key=lambda state: state["backupId"])["exportId"]
                protected = {newest_source, self.active_id} | {key for key, count in self.downloads.items() if count}
                ordered = sorted(ready, key=lambda state: (state.get("completedAtUnix", 0), state.get("completedAt", ""), state["backupId"]), reverse=True)
                keep = {state["exportId"] for state in ready if state["exportId"] in protected}
                for state in ordered:
                    if len(keep) >= self.config.keep_ready_exports:
                        break
                    keep.add(state["exportId"])
                for state in ready:
                    key = state["exportId"]
                    if key in keep:
                        continue
                    try:
                        _, artifact = self._validate_manifest(key, state, require_current_recipient=False)
                        with open_plain(artifact) as stream:
                            if stream.read(len(AGE_HEADER)) != AGE_HEADER:
                                raise ExportError("INVALID_EXPORT_HEADER", "Retention target is not recognized ciphertext.")
                        expired = state | {"state": "expired", "expiredAt": utc_now(), "expirationReason": "ready_export_retention"}
                        atomic_json(self.config.export_root / key / "state.json", expired)
                        self.jobs[key] = expired
                        artifact.unlink()
                    except (OSError, ValueError, ExportError) as error:
                        self.retention_errors.append({"exportId": key, "code": getattr(error, "code", "RETENTION_FAILED")})
            # Finish a deletion interrupted after its durable expired receipt.
            for state in self.jobs.values():
                key = state["exportId"]
                if state.get("state") != "expired" or state.get("expirationReason") != "ready_export_retention" or self.downloads.get(key) or key == self.active_id:
                    continue
                artifact = self.config.export_root / key / "rewrapped.sql.zst.age"
                try:
                    if artifact.exists():
                        _, checked = self._validate_manifest(key, state, require_current_recipient=False)
                        checked.unlink()
                except (OSError, ValueError, ExportError) as error:
                    self.retention_errors.append({"exportId": key, "code": getattr(error, "code", "RETENTION_FAILED")})
            self.retention_errors = self.retention_errors[-20:]

    def _download_finished(self, key):
        with self.lock:
            self.downloads[key] = max(0, self.downloads.get(key, 0) - 1)
        self.prune_ready_exports()

    def latest(self) -> dict:
        scope = self.config.archive_root / "host-mysql"
        plain_path(scope, directory=True)
        candidates = []
        for year in os.scandir(scope):
            if not re.fullmatch(r"\d{4}", year.name) or not year.is_dir(follow_symlinks=False):
                continue
            for month in os.scandir(year.path):
                if not re.fullmatch(r"\d{2}", month.name) or not month.is_dir(follow_symlinks=False):
                    continue
                for generation in os.scandir(month.path):
                    if generation.is_dir(follow_symlinks=False) and BACKUP_ID.fullmatch(generation.name) and generation.name[:6] == year.name + month.name:
                        candidates.append(generation.name)
        skipped = []
        deadline = time.monotonic() + min(self.config.export_timeout_seconds, 300)
        for candidate in sorted(candidates, reverse=True):
            try:
                metadata, source = source_metadata(self.config, candidate)
                verify_stream(source, metadata["sourceSha256"], metadata["sourceBytes"], deadline)
                return {"backup": {**metadata, "sha256Reverified": True}, "skipped": skipped[:20], "checkedAt": utc_now()}
            except (ExportError, OSError, ValueError, UnicodeError) as error:
                skipped.append({"backupId": candidate, "code": getattr(error, "code", "INVALID_ARCHIVE")})
        raise ExportError("NO_VALID_BACKUP", "No complete, checksum-valid host-mysql backup is available.", 404)

    def _usage(self) -> int:
        total = 0
        for directory, folders, files in os.walk(self.config.export_root, followlinks=False):
            for item in [*folders, *files]:
                info = (Path(directory) / item).lstat()
                if stat.S_ISLNK(info.st_mode):
                    raise ExportError("UNSAFE_EXPORT_PATH", "Export cache contains a symbolic link.", 503)
                if stat.S_ISREG(info.st_mode):
                    total += info.st_size
        return total

    def request_export(self, backup_id: str) -> dict:
        backup_timestamp(backup_id)
        with self.lock:
            for previous in self.jobs.values():
                expected_key = hashlib.sha256(("v1\0" + backup_id + "\0" + previous["source"]["sourceSha256"] + "\0" + self.config.oci_recipient).encode()).hexdigest()
                if previous["backupId"] == backup_id and previous["exportId"] == expected_key and previous["state"] in {"queued", "running", "ready"}:
                    if previous["state"] == "ready":
                        self._validate_manifest(previous["exportId"], previous)
                    return self._public(previous)
        metadata, _ = source_metadata(self.config, backup_id)
        key = hashlib.sha256(("v1\0" + backup_id + "\0" + metadata["sourceSha256"] + "\0" + self.config.oci_recipient).encode()).hexdigest()
        with self.lock:
            existing = self.jobs.get(key)
            if existing and (existing["state"] in {"ready", "queued", "running"} or time.time() < existing.get("retryAfterEpoch", 0)):
                return self._public(existing)
            if self.active_id:
                raise ExportError("EXPORT_BUSY", "Another NAS export is active; poll its receipt before requesting another generation.", 503)
            required = metadata["sourceBytes"] * 2 + 1024 * 1024
            if self._usage() + required > self.config.max_cache_bytes or shutil.disk_usage(self.config.export_root).free < required + self.config.min_free_bytes:
                raise ExportError("EXPORT_DISK_LIMIT", "Export cache quota or filesystem free-space reserve is insufficient.", 507)
            destination = self.config.export_root / key
            destination.mkdir(mode=0o700, exist_ok=True)
            plain_path(destination, directory=True)
            state = {"schemaVersion": 1, "exportId": key, "backupId": backup_id, "state": "queued", "attempt": (existing or {}).get("attempt", 0) + 1, "createdAt": (existing or {}).get("createdAt", utc_now()), "source": metadata}
            atomic_json(destination / "state.json", state)
            self.jobs[key] = state
            self.active_id = key
            self.worker = threading.Thread(target=self._build, args=(key,), daemon=True)
            self.worker.start()
            return self._public(state)

    @staticmethod
    def _public(state: dict) -> dict:
        return {key: value for key, value in state.items() if key != "retryAfterEpoch"} | {"manifestUrl": f"/v1/exports/{state['exportId']}", "dataUrl": f"/v1/exports/{state['exportId']}/data"}

    def _build(self, key: str) -> None:
        destination = self.config.export_root / key
        source_copy = destination / "source.age.partial"
        output = destination / "rewrapped.sql.zst.age.partial"
        ready = destination / "rewrapped.sql.zst.age"
        deadline = time.monotonic() + self.config.export_timeout_seconds
        try:
            with self.lock:
                state = self.jobs[key] | {"state": "running", "startedAt": utc_now()}
                self.jobs[key] = state
                atomic_json(destination / "state.json", state)
            for partial in [source_copy, output]:
                if partial.exists():
                    plain_path(partial); partial.unlink()
            metadata, source = source_metadata(self.config, state["backupId"])
            if metadata != state["source"]:
                raise ExportError("SOURCE_CHANGED", "Archive metadata changed after export was requested.", 409)
            with open(source_copy, "xb") as stream:
                os.chmod(source_copy, 0o600)
                verify_stream(source, metadata["sourceSha256"], metadata["sourceBytes"], deadline, stream)
                stream.flush(); os.fsync(stream.fileno())
            budget = min(self.config.max_export_bytes, self.config.max_cache_bytes - self._usage() - 65536)
            if budget < 128:
                raise ExportError("EXPORT_DISK_LIMIT", "Export cache has insufficient remaining capacity.", 507)
            if self.rewrap is docker_rewrap:
                self.rewrap(source_copy, output, self.config.oci_recipient, deadline, budget, self.config.min_free_bytes)
            else:
                self.rewrap(source_copy, output, self.config.oci_recipient, deadline, budget)
            if time.monotonic() > deadline:
                raise ExportError("EXPORT_DEADLINE", "Export finished after its deadline.", 504)
            info = plain_path(output)
            if not 128 <= info.st_size <= self.config.max_export_bytes:
                raise ExportError("EXPORT_SIZE_LIMIT", "Rewrapped ciphertext has an invalid size.", 507)
            digest = hashlib.sha256()
            with open_plain(output) as stream:
                if stream.read(len(AGE_HEADER)) != AGE_HEADER:
                    raise ExportError("INVALID_EXPORT_HEADER", "Rewrapped output lacks the age v1 header.", 502)
                stream.seek(0)
                while chunk := stream.read(CHUNK):
                    if time.monotonic() > deadline:
                        raise ExportError("EXPORT_DEADLINE", "Export checksum exceeded its deadline.", 504)
                    digest.update(chunk)
            manifest = {"schemaVersion": 1, "exportId": key, "backupId": state["backupId"], "scope": "host-mysql", "source": metadata,
                        "export": {"filename": ready.name, "sha256": digest.hexdigest(), "bytes": info.st_size, "ociRecipient": self.config.oci_recipient, "recipientFingerprint": hashlib.sha256(self.config.oci_recipient.encode()).hexdigest(), "compression": "zstd", "encryption": "age"}, "completedAt": utc_now()}
            os.replace(output, ready)
            atomic_json(destination / "manifest.json", manifest)
            with self.lock:
                state = state | {"state": "ready", "manifest": manifest, "completedAt": manifest["completedAt"], "completedAtUnix": time.time()}
                atomic_json(destination / "state.json", state)
                self.jobs[key] = state
            self.prune_ready_exports()
        except Exception as error:
            with self.lock:
                previous = self.jobs[key]
                disk_full = isinstance(error, OSError) and error.errno == errno.ENOSPC
                state = previous | {"state": "failed", "failedAt": utc_now(), "retryAfterEpoch": time.time() + self.config.retry_cooldown_seconds,
                                    "error": {"code": "EXPORT_DISK_LIMIT" if disk_full else getattr(error, "code", "EXPORT_FAILED"), "message": "Filesystem became full during export." if disk_full else str(error) if isinstance(error, ExportError) else "NAS export failed; inspect the local service state."}}
                self.jobs[key] = state
                try:
                    atomic_json(destination / "state.json", state)
                except OSError:
                    pass  # The persisted running state recovers as interrupted.
        finally:
            for partial in [source_copy, output]:
                try:
                    if partial.exists():
                        plain_path(partial); partial.unlink()
                except (OSError, ExportError):
                    pass
            with self.lock:
                self.active_id = None
            self.prune_ready_exports()

    def status(self, key: str) -> dict:
        if not EXPORT_ID.fullmatch(key):
            raise ExportError("INVALID_EXPORT_ID", "Invalid export ID.")
        with self.lock:
            state = self.jobs.get(key)
            if not state:
                raise ExportError("EXPORT_NOT_FOUND", "Export receipt does not exist.", 404)
            if state["state"] == "ready":
                self._validate_manifest(key, state)
            return self._public(state)

    def _validate_manifest(self, key: str, state: dict, require_current_recipient=True) -> tuple[dict, Path]:
        directory = self.config.export_root / key
        manifest = json.loads(read_small(directory / "manifest.json", 65536))
        expected = state.get("manifest")
        if manifest != expected or manifest.get("exportId") != key or manifest.get("backupId") != state["backupId"] or manifest.get("source") != state["source"]:
            raise ExportError("INVALID_EXPORT_MANIFEST", "Export manifest does not match its committed receipt.", 409)
        artifact = manifest.get("export", {})
        recipient = artifact.get("ociRecipient", "")
        if artifact.get("filename") != "rewrapped.sql.zst.age" or not AGE_RECIPIENT.fullmatch(recipient) or require_current_recipient and recipient != self.config.oci_recipient or artifact.get("recipientFingerprint") != hashlib.sha256(recipient.encode()).hexdigest() or not EXPORT_ID.fullmatch(artifact.get("sha256", "")):
            raise ExportError("INVALID_EXPORT_MANIFEST", "Export recipient or artifact reference does not match configuration.", 409)
        file = directory / artifact["filename"]
        if plain_path(file).st_size != artifact.get("bytes"):
            raise ExportError("EXPORT_CHANGED", "Export ciphertext size does not match its committed manifest.", 409)
        return manifest, file

    def data(self, key: str):
        with self.lock:
            state = self.status(key)
            if state["state"] == "expired":
                raise ExportError("EXPORT_EXPIRED", "Cached ciphertext expired. POST the same backupId to rebuild it if its source archive remains available.", 410)
            if state["state"] != "ready":
                raise ExportError("EXPORT_NOT_READY", "Ciphertext is unavailable until export is committed.", 409)
            manifest, file = self._validate_manifest(key, state)
            stream = open_plain(file)
            self.downloads[key] = self.downloads.get(key, 0) + 1
        try:
            digest = hashlib.sha256()
            if stream.read(len(AGE_HEADER)) != AGE_HEADER:
                raise ExportError("INVALID_EXPORT_HEADER", "Export age header is invalid.", 409)
            stream.seek(0)
            deadline = time.monotonic() + min(300, self.config.export_timeout_seconds)
            while chunk := stream.read(CHUNK):
                if time.monotonic() > deadline:
                    raise ExportError("EXPORT_DEADLINE", "Download verification exceeded its deadline.", 504)
                digest.update(chunk)
            if not hmac.compare_digest(digest.hexdigest(), manifest["export"]["sha256"]):
                raise ExportError("EXPORT_CHECKSUM_MISMATCH", "Export ciphertext checksum failed.", 409)
            stream.seek(0)
            return manifest, DownloadStream(stream, lambda: self._download_finished(key))
        except Exception:
            stream.close(); self._download_finished(key); raise

    def _active_manifest(self, directory: Path) -> dict:
        plain_path(directory, directory=True)
        if set(os.listdir(directory)) != {"backup.sql.zst.age", "manifest.json", ".complete"}:
            raise ExportError("INVALID_ACTIVE_BACKUP", "Active backup is not a committed three-file set.", 409)
        manifest = json.loads(read_small(directory / "manifest.json", 16384))
        complete = json.loads(read_small(directory / ".complete", 4096))
        if manifest.get("source") != "oci" or manifest.get("database") != "ComebackTwitterEmbed" or str(manifest.get("epoch")) != directory.parent.name or manifest.get("backupId") != directory.name or manifest.get("filename") != "backup.sql.zst.age" or not EXPORT_ID.fullmatch(manifest.get("sha256", "")) or type(manifest.get("bytes")) is not int:
            raise ExportError("INVALID_ACTIVE_BACKUP", "Active backup metadata does not match its source and path.", 409)
        backup_timestamp(manifest["backupId"])
        if complete.get("sha256") != manifest["sha256"] or complete.get("bytes") != manifest["bytes"]:
            raise ExportError("INVALID_ACTIVE_BACKUP", "Active backup completion marker does not match.", 409)
        artifact = directory / "backup.sql.zst.age"
        if not 128 <= manifest["bytes"] <= self.config.max_source_bytes or plain_path(artifact).st_size != manifest["bytes"]:
            raise ExportError("INVALID_ACTIVE_BACKUP", "Active backup size is invalid.", 409)
        with open_plain(artifact) as stream:
            if stream.read(len(AGE_HEADER)) != AGE_HEADER:
                raise ExportError("INVALID_AGE_HEADER", "Active backup does not contain age ciphertext.", 409)
        return manifest

    def receive_active_backup(self, epoch: int, backup_id: str, candidate: str, expected_hash: str, size: int, stream) -> dict:
        backup_timestamp(backup_id)
        if type(epoch) is not int or not 1 <= epoch <= 2**63 - 1 or not re.fullmatch(r"[0-9a-f]{24}", candidate or "") or not EXPORT_ID.fullmatch(expected_hash or "") or not 128 <= size <= self.config.max_source_bytes:
            raise ExportError("INVALID_ACTIVE_BACKUP", "Invalid epoch, candidate, size, or SHA-256.")
        if not self.active_upload_lock.acquire(blocking=False):
            raise ExportError("ACTIVE_BACKUP_BUSY", "Another active-backup upload is in progress.", 503)
        stage = None
        try:
            root = self.config.active_backup_root
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            plain_path(root, directory=True)
            parent = root / str(epoch)
            parent.mkdir(mode=0o700, exist_ok=True)
            plain_path(parent, directory=True)
            destination = parent / backup_id
            if destination.exists():
                existing = self._active_manifest(destination)
                if existing["sha256"] != expected_hash or existing["bytes"] != size or existing.get("candidateId") != candidate:
                    raise ExportError("ACTIVE_BACKUP_CONFLICT", "This epoch and backup ID already contain different ciphertext.", 409)
                verify_stream(destination / "backup.sql.zst.age", expected_hash, size, time.monotonic() + self.config.export_timeout_seconds)
                remaining, digest = size, hashlib.sha256()
                deadline = time.monotonic() + self.config.export_timeout_seconds
                while remaining:
                    if time.monotonic() >= deadline:
                        raise ExportError("ACTIVE_BACKUP_DEADLINE", "Duplicate upload exceeded its deadline.", 504)
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        raise ExportError("ACTIVE_BACKUP_INCOMPLETE", "Duplicate upload was incomplete.")
                    digest.update(chunk); remaining -= len(chunk)
                if digest.hexdigest() != expected_hash:
                    raise ExportError("ACTIVE_BACKUP_CHECKSUM", "Duplicate upload content does not match its checksum.", 409)
                return {"stored": True, "reused": True, "manifest": existing}
            if shutil.disk_usage(root).free < size + self.config.min_free_bytes:
                raise ExportError("ACTIVE_BACKUP_DISK_LIMIT", "NAS free-space reserve is insufficient.", 507)
            stage = parent / (".incoming-" + uuid.uuid4().hex)
            stage.mkdir(mode=0o700)
            digest = hashlib.sha256()
            remaining, first = size, True
            deadline = time.monotonic() + self.config.export_timeout_seconds
            with open(stage / "backup.sql.zst.age", "xb") as output:
                os.chmod(output.name, 0o600)
                while remaining:
                    if time.monotonic() >= deadline:
                        raise ExportError("ACTIVE_BACKUP_DEADLINE", "Active backup upload exceeded its deadline.", 504)
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        raise ExportError("ACTIVE_BACKUP_INCOMPLETE", "Upload ended before Content-Length bytes arrived.", 400)
                    if first and len(chunk) < len(AGE_HEADER):
                        chunk += stream.read(min(len(AGE_HEADER) - len(chunk), remaining - len(chunk)))
                    if first and not chunk.startswith(AGE_HEADER):
                        raise ExportError("INVALID_AGE_HEADER", "Upload is not age ciphertext.", 400)
                    first = False
                    if shutil.disk_usage(root).free < self.config.min_free_bytes + len(chunk):
                        raise ExportError("ACTIVE_BACKUP_DISK_LIMIT", "NAS free-space reserve was reached.", 507)
                    digest.update(chunk); output.write(chunk); remaining -= len(chunk)
                output.flush(); os.fsync(output.fileno())
            if not hmac.compare_digest(digest.hexdigest(), expected_hash):
                raise ExportError("ACTIVE_BACKUP_CHECKSUM", "Uploaded ciphertext SHA-256 does not match.", 409)
            manifest = {"schemaVersion": 1, "source": "oci", "database": "ComebackTwitterEmbed", "epoch": epoch, "backupId": backup_id, "sourceTimestamp": backup_timestamp(backup_id), "candidateId": candidate, "filename": "backup.sql.zst.age", "sha256": expected_hash, "bytes": size, "receivedAt": utc_now(), "compression": "zstd", "encryption": "age-nas-recipient"}
            atomic_json(stage / "manifest.json", manifest)
            atomic_json(stage / ".complete", {"sha256": expected_hash, "bytes": size, "committedAt": utc_now()})
            os.rename(stage, destination)
            if os.name != "nt":
                descriptor = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            stage = None
            return {"stored": True, "reused": False, "manifest": manifest}
        finally:
            if stage and stage.exists():
                for entry in stage.iterdir():
                    plain_path(entry); entry.unlink()
                stage.rmdir()
            self.active_upload_lock.release()

    def latest_active_backup(self) -> dict:
        root = self.config.active_backup_root
        if not root.exists():
            return {"backup": None, "source": "oci", "checkedAt": utc_now()}
        plain_path(root, directory=True)
        candidates = []
        for epoch in os.scandir(root):
            if not re.fullmatch(r"[1-9][0-9]{0,18}", epoch.name) or not epoch.is_dir(follow_symlinks=False):
                continue
            for generation in os.scandir(epoch.path):
                if BACKUP_ID.fullmatch(generation.name) and generation.is_dir(follow_symlinks=False):
                    candidates.append((int(epoch.name), generation.name, Path(generation.path)))
        skipped = []
        for epoch, backup_id, directory in sorted(candidates, reverse=True):
            try:
                manifest = self._active_manifest(directory)
                verify_stream(directory / "backup.sql.zst.age", manifest["sha256"], manifest["bytes"], time.monotonic() + self.config.export_timeout_seconds)
                return {"backup": manifest, "source": "oci", "skipped": skipped[:20], "checkedAt": utc_now()}
            except (ExportError, OSError, ValueError) as error:
                skipped.append({"epoch": epoch, "backupId": backup_id, "code": getattr(error, "code", "INVALID_ACTIVE_BACKUP")})
        return {"backup": None, "source": "oci", "skipped": skipped[:20], "checkedAt": utc_now()}


def server_for(exporter: Exporter, port: int | None = None):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, _format, *args):
            pass  # Never log authorization headers or untrusted URL queries.

        def reply(self, status: int, data: dict):
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(body)

        def authenticate(self) -> bool:
            expected = "Bearer " + exporter.config.token
            received = self.headers.get("Authorization", "")
            if not hmac.compare_digest(received.encode(), expected.encode()):
                self.reply(401, {"error": {"code": "UNAUTHORIZED", "message": "Authentication required."}})
                return False
            return True

        def do_GET(self):
            try:
                route = urlsplit(self.path).path
                if route == "/health":
                    self.reply(200, {"ok": True, "service": "cbte-nas-exporter"}); return
                if not self.authenticate():
                    return
                if route == "/v1/backups/latest":
                    self.reply(200, exporter.latest()); return
                if route == "/v1/active-backups/latest":
                    self.reply(200, exporter.latest_active_backup()); return
                active = re.fullmatch(r"/v1/active-backups/([1-9][0-9]{0,18})/([0-9]{8}T[0-9]{6}Z)", route)
                if active:
                    backup_timestamp(active.group(2))
                    directory = exporter.config.active_backup_root / active.group(1) / active.group(2)
                    if not directory.exists():
                        raise ExportError("ACTIVE_BACKUP_NOT_FOUND", "Active backup has not been committed.", 404)
                    manifest = exporter._active_manifest(directory)
                    verify_stream(directory / manifest["filename"], manifest["sha256"], manifest["bytes"], time.monotonic() + exporter.config.export_timeout_seconds)
                    self.reply(200, {"stored": True, "manifest": manifest}); return
                match = re.fullmatch(r"/v1/exports/([0-9a-f]{64})(/data)?", route)
                if not match:
                    raise ExportError("NOT_FOUND", "Unknown endpoint.", 404)
                if not match.group(2):
                    self.reply(200, exporter.status(match.group(1))); return
                manifest, stream = exporter.data(match.group(1))
                with stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(manifest["export"]["bytes"]))
                    self.send_header("ETag", '"' + manifest["export"]["sha256"] + '"')
                    self.send_header("Cache-Control", "private, no-store")
                    self.send_header("Connection", "close")
                    self.end_headers(); self.close_connection = True
                    shutil.copyfileobj(stream, self.wfile, length=65536)
            except ExportError as error:
                self.reply(error.status, {"error": {"code": error.code, "message": str(error)}})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                self.reply(503, {"error": {"code": "NAS_READ_FAILED", "message": "NAS archive or export state could not be read."}})

        def do_POST(self):
            try:
                if not self.authenticate():
                    return
                if urlsplit(self.path).path != "/v1/exports":
                    raise ExportError("NOT_FOUND", "Unknown endpoint.", 404)
                if self.headers.get("Transfer-Encoding") or not self.headers.get("Content-Type", "").startswith("application/json"):
                    raise ExportError("INVALID_REQUEST", "A bounded JSON request is required.")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096:
                    raise ExportError("REQUEST_SIZE_LIMIT", "Request must contain at most 4096 bytes.", 413)
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict) or set(data) != {"backupId"}:
                    raise ExportError("INVALID_REQUEST", "Only backupId may be supplied.")
                state = exporter.request_export(data["backupId"])
                self.reply(200 if state["state"] == "ready" else 202, state)
            except ExportError as error:
                self.reply(error.status, {"error": {"code": error.code, "message": str(error)}})
            except (ValueError, UnicodeError):
                self.reply(400, {"error": {"code": "INVALID_JSON", "message": "Invalid request JSON."}})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                self.reply(503, {"error": {"code": "NAS_EXPORT_UNAVAILABLE", "message": "NAS export could not be accepted."}})

        def do_PUT(self):
            try:
                if not self.authenticate():
                    return
                match = re.fullmatch(r"/v1/active-backups/([1-9][0-9]{0,18})/([0-9]{8}T[0-9]{6}Z)", urlsplit(self.path).path)
                if not match or self.headers.get("Transfer-Encoding"):
                    raise ExportError("INVALID_ACTIVE_BACKUP", "A fixed epoch, UTC backup ID and Content-Length are required.")
                size = int(self.headers.get("Content-Length", "0"))
                result = exporter.receive_active_backup(int(match.group(1)), match.group(2), self.headers.get("X-Backup-Candidate", ""), self.headers.get("X-Backup-SHA256", ""), size, self.rfile)
                self.reply(200 if result["reused"] else 201, result)
            except ExportError as error:
                self.reply(error.status, {"error": {"code": error.code, "message": str(error)}})
            except (ValueError, UnicodeError):
                self.reply(400, {"error": {"code": "INVALID_ACTIVE_BACKUP", "message": "Invalid backup metadata."}})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                self.reply(503, {"error": {"code": "ACTIVE_BACKUP_FAILED", "message": "NAS active-backup storage failed; retry the same immutable artifact."}})

    address = exporter.config.listen.rsplit(":", 1)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", int(address[1]) if port is None else port), Handler)
    server.daemon_threads = True
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/etc/cbte-nas-exporter.json"))
    arguments = parser.parse_args()
    config = load_config(arguments.config)
    config.export_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    plain_path(config.export_root, directory=True)
    # systemd normally provides single-instance execution; also reject an
    # accidental second process before it can touch another process's staging.
    import fcntl
    lock_fd = os.open(config.export_root / ".exporter.lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    exporter = Exporter(config)
    server = server_for(exporter)
    print("NAS recovery exporter listening on loopback.", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        os.close(lock_fd)


if __name__ == "__main__":
    main()
