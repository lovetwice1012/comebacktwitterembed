#!/usr/bin/env python3
"""Keep OCI's active database backed up to NAS without exporting NAS identities.

Already encrypted pending artifacts may be uploaded after lease loss. A new
mysqldump is permitted only while live authority confirms the active OCI lease.
Only ComebackTwitterEmbed is dumped; primary host-mysql archives are untouched.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import http.client
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

try:
    from .start_workload import plain, read_json, read_lease, atomic_json, NoRedirect
except ImportError:
    from start_workload import plain, read_json, read_lease, atomic_json, NoRedirect

AGE_HEADER = b"age-encryption.org/v1\n"
RECEIPT_NAME = re.compile(r"^([0-9]{8}T[0-9]{6}Z)__oci_([1-9][0-9]{0,18})\.json$")


class BackupError(Exception):
    pass


class NotActive(BackupError):
    pass


def validate_config(config):
    required = {"candidatePointer", "candidateRoot", "leaseFile", "authorityUrl", "authorityToken", "nasUrl", "nasToken", "nasRecipient", "spoolRoot"}
    optional = {"dumpTimeoutSeconds", "uploadTimeoutSeconds", "maxArtifactBytes", "maxSpoolBytes", "minimumFreeBytes", "uploadedRetentionDays", "keepUploadedBackups"}
    if not isinstance(config, dict) or required - set(config) or set(config) - required - optional:
        raise BackupError("Active-backup configuration is incomplete or has unsupported keys.")
    for key in ["candidatePointer", "candidateRoot", "leaseFile", "spoolRoot"]:
        path = Path(config[key])
        if not path.is_absolute() or path == Path(path.anchor) or ".." in path.parts:
            raise BackupError("Active-backup paths must be absolute and non-root.")
    for key in ["authorityUrl", "nasUrl"]:
        url = urlsplit(config[key])
        if url.username or url.password or url.query or url.fragment or not url.hostname or not (url.scheme == "https" or url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"}):
            raise BackupError("Backup endpoints must use HTTPS or loopback HTTP.")
    if not re.fullmatch(r"age1[0-9a-z]{58}", config["nasRecipient"]):
        raise BackupError("A pinned NAS public age recipient is required.")
    if any(not isinstance(config[key], str) or len(config[key]) < 32 for key in ["authorityToken", "nasToken"]):
        raise BackupError("Backup and authority tokens must be configured.")
    for key in ["dumpTimeoutSeconds", "uploadTimeoutSeconds", "maxArtifactBytes", "maxSpoolBytes", "uploadedRetentionDays"]:
        if key in config and (type(config[key]) is not int or config[key] <= 0):
            raise BackupError("Backup deadlines, quotas and retention must be positive integers.")
    if type(config.get("minimumFreeBytes", 0)) is not int or config.get("minimumFreeBytes", 0) < 0:
        raise BackupError("minimumFreeBytes must be a nonnegative integer.")
    if type(config.get("keepUploadedBackups", 3)) is not int or not 1 <= config.get("keepUploadedBackups", 3) <= 100:
        raise BackupError("keepUploadedBackups must be between 1 and 100.")


def checked_hash(path, expected_size=None, deadline=None):
    plain(path)
    digest, size = hashlib.sha256(), 0
    with open(path, "rb") as stream:
        if stream.read(len(AGE_HEADER)) != AGE_HEADER:
            raise BackupError("Pending artifact is not age ciphertext.")
        stream.seek(0)
        while chunk := stream.read(1024 * 1024):
            if deadline and time.monotonic() > deadline:
                raise BackupError("Ciphertext verification exceeded its deadline.")
            size += len(chunk); digest.update(chunk)
            if expected_size is not None and size > expected_size:
                raise BackupError("Ciphertext size changed during verification.")
    if expected_size is not None and size != expected_size:
        raise BackupError("Ciphertext size does not match its receipt.")
    return digest.hexdigest(), size


def dump_commands(container, recipient, timeout):
    return [["docker", "exec", "-i", container, "timeout", "-s", "KILL", str(timeout), "mysqldump", "--defaults-extra-file=/run/cbte-secrets/client.cnf", "--single-transaction", "--quick", "--routines", "--events", "--triggers", "--hex-blob", "--no-tablespaces", "--set-gtid-purged=OFF", "--databases", "ComebackTwitterEmbed"], ["zstd", "-q", "-6", "-T2"], ["age", "--encrypt", "--recipient", recipient]]


def encrypted_dump(container, recipient, destination, deadline, maximum_bytes, minimum_free):
    processes = []
    chunks = queue.Queue(maxsize=8)
    stopped = threading.Event()
    reader = None
    log_path = destination.with_suffix(".log")
    try:
        with open(log_path, "ab", buffering=0) as log:
            os.chmod(log_path, 0o600)
            commands = dump_commands(container, recipient, max(1, int(deadline - time.monotonic())))
            dump = subprocess.Popen(commands[0], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
            processes.append(dump)
            compress = subprocess.Popen(commands[1], stdin=dump.stdout, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
            processes.append(compress); dump.stdout.close()
            encrypt = subprocess.Popen(commands[2], stdin=compress.stdout, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
            processes.append(encrypt); compress.stdout.close()
            def collect():
                try:
                    while not stopped.is_set():
                        chunk = encrypt.stdout.read(65536)
                        while not stopped.is_set():
                            try:
                                chunks.put(chunk, timeout=0.2); break
                            except queue.Full:
                                pass
                        if not chunk:
                            return
                finally:
                    encrypt.stdout.close()
            reader = threading.Thread(target=collect, daemon=True); reader.start()
            with open(destination, "xb") as output:
                os.chmod(destination, 0o600)
                size = 0
                while True:
                    if time.monotonic() >= deadline:
                        raise BackupError("Encrypted dump exceeded its deadline.")
                    if any(process.poll() not in (None, 0) for process in processes):
                        raise BackupError("Dump/compression/encryption pipeline failed; no backup was committed.")
                    try:
                        chunk = chunks.get(timeout=0.2)
                    except queue.Empty:
                        continue
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > maximum_bytes or shutil.disk_usage(destination.parent).free < minimum_free + len(chunk):
                        raise BackupError("Encrypted dump reached its artifact or disk capacity limit.")
                    output.write(chunk)
                for process in processes:
                    if process.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
                        raise BackupError("Dump pipeline did not finish successfully.")
                output.flush(); os.fsync(output.fileno())
    finally:
        stopped.set()
        for process in processes:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, AttributeError):
                    process.kill()
        for process in processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        if reader:
            reader.join(timeout=1)


def remote_json(url, token):
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
        raw = response.read(65537)
        if len(raw) > 65536:
            raise BackupError("Remote receipt exceeded its size limit.")
        return json.loads(raw)


def receipt_matches(remote, receipt):
    manifest = remote.get("manifest") or {}
    return remote.get("stored") is True and all(manifest.get(key) == receipt[key] for key in ["epoch", "backupId", "candidateId", "sha256", "bytes"]) and manifest.get("source") == "oci" and manifest.get("database") == "ComebackTwitterEmbed"


def upload_ciphertext(config, receipt, artifact):
    route = f"/v1/active-backups/{receipt['epoch']}/{receipt['backupId']}"
    base = config["nasUrl"].rstrip("/")
    try:
        existing = remote_json(base + route, config["nasToken"])
        if not receipt_matches(existing, receipt):
            raise BackupError("NAS already has a conflicting active-backup receipt.")
        return existing
    except urllib.error.HTTPError as error:
        error.close()
        if error.code != 404:
            raise BackupError("NAS receipt lookup failed; encrypted pending backup is retained.") from error
    url = urlsplit(base)
    connection_type = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(url.hostname, url.port, timeout=15)
    deadline = time.monotonic() + int(config.get("uploadTimeoutSeconds", 1800))
    try:
        connection.putrequest("PUT", url.path.rstrip("/") + route)
        for key, value in {"Authorization": "Bearer " + config["nasToken"], "Content-Type": "application/octet-stream", "Content-Length": str(receipt["bytes"]), "X-Backup-SHA256": receipt["sha256"], "X-Backup-Candidate": receipt["candidateId"]}.items():
            connection.putheader(key, value)
        connection.endheaders()
        with open(artifact, "rb") as stream:
            while chunk := stream.read(65536):
                if time.monotonic() >= deadline:
                    raise BackupError("NAS upload exceeded its deadline; immutable backup remains pending.")
                connection.send(chunk)
        response = connection.getresponse()
        raw = response.read(65537)
        if response.status not in {200, 201} or len(raw) > 65536:
            raise BackupError("NAS did not confirm the complete active-backup upload.")
        result = json.loads(raw)
        if not receipt_matches(result, receipt):
            raise BackupError("NAS confirmation does not match the uploaded ciphertext.")
        return result
    finally:
        connection.close()


class ActiveBackup:
    def __init__(self, config, dump=encrypted_dump, upload=upload_ciphertext, authority=remote_json, inspect=None):
        validate_config(config)
        self.config, self.dump, self.upload, self.authority = config, dump, upload, authority
        self.inspect = inspect or self.inspect_container
        self.root = Path(config["spoolRoot"])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        plain(self.root, directory=True)

    @staticmethod
    def inspect_container(container):
        result = subprocess.run(["docker", "inspect", container], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=False)
        if result.returncode:
            raise BackupError("Owned OCI MySQL container is unavailable.")
        return json.loads(result.stdout)[0]

    def active_candidate(self):
        try:
            lease = read_lease(Path(self.config["leaseFile"]))
        except FileNotFoundError as error:
            raise NotActive("OCI guardian has not acquired a lease; encrypted pending backups may still upload.") from error
        if lease.get("node") != "oci" or lease.get("state") not in {"active", "renewal_unconfirmed"} or type(lease.get("epoch")) is not int or float(lease.get("validUntilUnixMs", 0)) <= time.time() * 1000 + 3000:
            raise NotActive("No live OCI lease; only existing encrypted artifacts may be uploaded.")
        live = self.authority(self.config["authorityUrl"].rstrip("/") + "/v1/status", self.config["authorityToken"])
        remote = live.get("lease") or {}
        if live.get("activeNode") != "oci" or live.get("epoch") != lease["epoch"] or remote.get("node") != "oci" or remote.get("instanceId") != lease.get("instanceId") or remote.get("valid") is not True or float(remote.get("expiresAt", 0)) <= float(live.get("serverTime", time.time())):
            raise NotActive("Authority does not confirm this active OCI lease.")
        candidate = read_json(Path(self.config["candidatePointer"]), private=True)
        identifier = candidate.get("id", "")
        if not re.fullmatch(r"[0-9a-f]{24}", identifier) or candidate.get("epoch") != lease["epoch"] or candidate.get("container") != "cbte-dr-" + identifier:
            raise BackupError("Candidate and active epoch do not match.")
        directory = Path(candidate.get("directory", ""))
        if directory != Path(self.config["candidateRoot"]) / identifier:
            raise BackupError("Candidate path escapes its configured root.")
        plain(directory, directory=True)
        restored = read_json(directory / "receipt.json", private=True)
        if restored.get("phase") != "ACTIVE" or any(restored.get(key) != candidate.get(key) for key in ["id", "container", "directory", "mysqlImage"]):
            raise BackupError("Candidate has not completed OCI activation.")
        info = self.inspect(candidate["container"])
        labels = info.get("Config", {}).get("Labels") or {}
        mounts = {row.get("Destination"): row for row in info.get("Mounts", [])}
        if labels.get("cbte.recovery") != "true" or labels.get("cbte.restore-id") != identifier or info.get("Config", {}).get("Image") != candidate["mysqlImage"] or info.get("HostConfig", {}).get("NetworkMode") != "host" or info.get("State", {}).get("Running") is not True:
            raise BackupError("Docker ownership, image or active network does not match.")
        if mounts.get("/var/lib/mysql", {}).get("Source") != str(directory / "data") or mounts.get("/run/cbte-secrets", {}).get("Source") != str(directory / "secrets") or mounts.get("/run/cbte-secrets", {}).get("RW") is not False:
            raise BackupError("Docker mounts differ from the validated OCI candidate.")
        return candidate, lease

    def pending(self):
        records = []
        for path in sorted(self.root.iterdir()):
            match = RECEIPT_NAME.fullmatch(path.name)
            if not match:
                continue
            value = read_json(path, private=True)
            if value.get("backupId") != match.group(1) or str(value.get("epoch")) != match.group(2) or value.get("source") != "oci" or value.get("database") != "ComebackTwitterEmbed" or value.get("filename") != path.stem + ".sql.zst.age":
                raise BackupError("Invalid encrypted backup receipt.")
            if value.get("state") == "PENDING":
                records.append((path, value))
        return records

    def upload_pending(self):
        uploaded, failures = [], []
        for path, receipt in self.pending():
            artifact = self.root / receipt["filename"]
            try:
                digest, _ = checked_hash(artifact, receipt["bytes"], time.monotonic() + 300)
                if digest != receipt["sha256"]:
                    raise BackupError("Encrypted pending backup checksum failed.")
                response = self.upload(self.config, receipt, artifact)
                if not receipt_matches(response, receipt):
                    raise BackupError("NAS upload receipt mismatch.")
                receipt.update(state="UPLOADED", uploadedAt=time.time(), nasManifest=response["manifest"])
                atomic_json(path, receipt)
                uploaded.append(receipt["backupId"])
            except Exception as error:
                failures.append({"backupId": receipt["backupId"], "error": str(error) if isinstance(error, BackupError) else "NAS upload failed; encrypted pending data is retained."})
        return uploaded, failures

    def create(self):
        candidate, lease = self.active_candidate()
        identifier = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        base = f"{identifier}__oci_{lease['epoch']}"
        artifact = self.root / (base + ".sql.zst.age")
        receipt_path = self.root / (base + ".json")
        if artifact.exists() or receipt_path.exists():
            raise BackupError("A generation already exists for this UTC second; it will not be overwritten.")
        partial = self.root / (".creating-" + base + "-" + secrets.token_hex(6) + ".partial")
        maximum = min(int(self.config.get("maxArtifactBytes", 64 * 1024**3)), 64 * 1024**3)
        used = sum(path.stat().st_size for path in self.root.iterdir() if path.is_file())
        spool_remaining = int(self.config.get("maxSpoolBytes", 128 * 1024**3)) - used
        maximum = min(maximum, spool_remaining)
        minimum_free = int(self.config.get("minimumFreeBytes", 4 * 1024**3))
        if maximum < 128 or shutil.disk_usage(self.root).free < minimum_free + 128:
            raise BackupError("Active-backup spool or filesystem reserve is insufficient.")
        deadline = time.monotonic() + min(21600, int(self.config.get("dumpTimeoutSeconds", 1800)))
        try:
            self.dump(candidate["container"], self.config["nasRecipient"], partial, deadline, maximum, minimum_free)
            digest, size = checked_hash(partial, deadline=deadline)
            if not 128 <= size <= maximum:
                raise BackupError("New encrypted artifact exceeds its limits.")
            os.chmod(partial, 0o400)
            os.replace(partial, artifact)
            receipt = {"schemaVersion": 1, "state": "PENDING", "source": "oci", "database": "ComebackTwitterEmbed", "epoch": lease["epoch"], "backupId": identifier, "candidateId": candidate["id"], "filename": artifact.name, "sha256": digest, "bytes": size, "nasRecipient": self.config["nasRecipient"], "createdAt": time.time(), "leaseInstanceId": lease["instanceId"], "compression": "zstd", "encryption": "age"}
            atomic_json(receipt_path, receipt)
            return receipt
        finally:
            if partial.exists():
                plain(partial); partial.unlink()

    def prune_uploaded(self):
        uploaded, expired = [], []
        for path in self.root.iterdir():
            if not RECEIPT_NAME.fullmatch(path.name):
                continue
            receipt = read_json(path, private=True)
            if receipt.get("state") == "UPLOADED":
                uploaded.append((path, receipt))
            elif receipt.get("state") == "EXPIRED" and receipt.get("expirationReason") == "uploaded_backup_retention":
                expired.append((path, receipt))
        # Retain the newest confirmed OCI epochs/generations even across a long
        # inactive period. The old day setting remains accepted for configuration
        # compatibility; the tighter count bound controls local ciphertext.
        uploaded.sort(key=lambda item: (int(item[1]["epoch"]), item[1]["backupId"], item[1].get("uploadedAt", 0)), reverse=True)
        for path, receipt in uploaded[int(self.config.get("keepUploadedBackups", 3)):]:
            if not receipt_matches({"stored": True, "manifest": receipt.get("nasManifest")}, receipt):
                raise BackupError("Uploaded ciphertext lacks a matching NAS completion receipt.")
            expected = path.stem + ".sql.zst.age"
            if receipt.get("filename") != expected:
                raise BackupError("Unexpected uploaded-backup filename.")
            artifact = self.root / expected
            if artifact.exists():
                plain(artifact)
                with open(artifact, "rb") as stream:
                    if stream.read(len(AGE_HEADER)) != AGE_HEADER:
                        raise BackupError("Retention target is not recognized ciphertext.")
            receipt = receipt | {"state": "EXPIRED", "expiredAt": time.time(), "expirationReason": "uploaded_backup_retention"}
            atomic_json(path, receipt)
            expired.append((path, receipt))
        for path, receipt in expired:
            if not receipt_matches({"stored": True, "manifest": receipt.get("nasManifest")}, receipt):
                continue
            expected = path.stem + ".sql.zst.age"
            if receipt.get("filename") != expected:
                raise BackupError("Unexpected uploaded-backup filename.")
            artifact = self.root / expected
            if artifact.exists():
                plain(artifact); artifact.unlink()

    def run_once(self, create_new=True):
        uploaded, failures = self.upload_pending()
        self.prune_uploaded()
        created, skipped = None, None
        if not create_new:
            return {"created": None, "uploaded": uploaded, "failures": failures,
                    "newDumpSkipped": "Pending transfer retry only", "checkedAt": time.time()}
        try:
            created = self.create()["backupId"]
        except NotActive as error:
            skipped = str(error)
        except Exception as error:
            skipped = str(error) if isinstance(error, BackupError) else "OCI backup could not start or finish; existing pending ciphertext is preserved."
            failures.append({"stage": "new_dump", "error": skipped})
        newly_uploaded, later_failures = self.upload_pending()
        self.prune_uploaded()
        return {"created": created, "uploaded": uploaded + newly_uploaded, "failures": failures + later_failures, "newDumpSkipped": skipped, "checkedAt": time.time()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--retry-only", action="store_true")
    args = parser.parse_args()
    if os.name != "posix" or os.getuid() != 0:
        raise SystemExit("Active database backup requires a root-owned Linux service configuration.")
    config = read_json(args.config, private=True)
    backup = ActiveBackup(config)
    import fcntl
    descriptor = os.open(backup.root / ".backup.lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        print(json.dumps({"skipped": "Another backup or transfer is already running"}))
        return
    try:
        result = backup.run_once(create_new=not args.retry_only)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        raise SystemExit(1 if result["failures"] else 0)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    main()
