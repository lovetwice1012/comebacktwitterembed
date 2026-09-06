#!/usr/bin/env python3
"""Restore a verified encrypted backup into a new, network-isolated MySQL candidate.

This module never starts a Bot, publishes a port, or restores the fleet authority.
An interrupted import is quarantined; subsequent attempts use a new directory.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import time


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    if os.name != "nt":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_artifact(path, expected_hash, expected_bytes):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Ciphertext must be a regular file, not a symlink")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_hash or ""):
        raise ValueError("Invalid expected SHA256")
    if path.stat().st_size != expected_bytes or sha256(path) != expected_hash:
        raise ValueError("Ciphertext size or SHA256 mismatch")
    with path.open("rb") as source:
        if source.read(22) != b"age-encryption.org/v1\n":
            raise ValueError("Invalid age ciphertext header")


def run(argv, *, input=None, timeout=60):
    result = subprocess.run(argv, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace")[-16000:]
        raise RuntimeError(f"{Path(argv[0]).name} exited {result.returncode}: {detail}")
    return result.stdout.decode("utf-8", "replace")


def mysql(container, sql, timeout=30):
    return run(["docker", "exec", "-i", container, "mysql",
                "--defaults-extra-file=/run/cbte-secrets/client.cnf", "--batch", "--skip-column-names"],
               input=sql.encode(), timeout=timeout)


def stop_pipeline(processes):
    for process in processes:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, AttributeError):
                process.kill()
    for process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass


def stream_import(artifact, identity, container, log_path, disk_root, *, timeout=7200,
                  minimum_free_bytes=4 * 1024**3, progress=lambda _value: None):
    """All three exit statuses are required; never store plaintext SQL on disk."""
    processes = []
    started = time.monotonic()
    try:
        with open(log_path, "ab", buffering=0) as log:
            decrypt = subprocess.Popen(["age", "--decrypt", "--identity", str(identity), str(artifact)],
                                       stdout=subprocess.PIPE, stderr=log, start_new_session=True)
            processes.append(decrypt)
            decompress = subprocess.Popen(["zstd", "--decompress", "--stdout"], stdin=decrypt.stdout,
                                          stdout=subprocess.PIPE, stderr=log, start_new_session=True)
            processes.append(decompress)
            decrypt.stdout.close()
            restore = subprocess.Popen(["docker", "exec", "-i", container, "mysql",
                "--defaults-extra-file=/run/cbte-secrets/client.cnf", "--binary-mode=1"],
                stdin=decompress.stdout, stdout=log, stderr=log, start_new_session=True)
            processes.append(restore)
            decompress.stdout.close()
            last_progress = 0.0
            while any(process.poll() is None for process in processes):
                elapsed = time.monotonic() - started
                free = shutil.disk_usage(disk_root).free
                if elapsed >= timeout:
                    raise TimeoutError("SQL import exceeded its deadline")
                if free < minimum_free_bytes:
                    raise OSError("SQL import stopped before exhausting the recovery filesystem")
                failures = [process.returncode for process in processes if process.poll() not in (None, 0)]
                if failures:
                    raise RuntimeError(f"Restore pipeline failed with exit statuses {failures}; see import.log")
                if elapsed - last_progress >= 15:
                    progress({"phase": "RESTORING_ISOLATED", "elapsedSeconds": round(elapsed), "freeBytes": free})
                    last_progress = elapsed
                time.sleep(1)
            if any(process.returncode != 0 for process in processes):
                raise RuntimeError("Restore pipeline did not complete successfully; see import.log")
    finally:
        stop_pipeline(processes)


def prepare(config, manifest, artifact, progress=lambda _value: None):
    expected_hash = manifest["export"]["sha256"]
    verify_artifact(artifact, expected_hash, int(manifest["export"]["bytes"]))
    root = Path(config["candidateRoot"]).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(root).free < int(config.get("minimumFreeBytes", 4 * 1024**3)):
        raise OSError("Insufficient free space for isolated restoration")
    image = config["mysqlImage"]
    if not re.fullmatch(r"mysql@sha256:[0-9a-f]{64}", image):
        raise ValueError("MySQL image must be pinned by official-image digest")
    restore_id = secrets.token_hex(12)
    candidate = root / restore_id
    candidate.mkdir(mode=0o700)
    data = candidate / "data"
    data.mkdir(mode=0o700)
    secret_dir = candidate / "secrets"
    secret_dir.mkdir(mode=0o700)
    password = secrets.token_hex(32)
    for name, content in {"root-password": password, "client.cnf": f"[client]\nuser=root\npassword={password}\nprotocol=socket\n"}.items():
        fd = os.open(secret_dir / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(content)
    container = "cbte-dr-" + restore_id
    receipt_path = candidate / "receipt.json"
    receipt = {"id": restore_id, "container": container, "directory": str(candidate),
               "manifest": manifest, "mysqlImage": image, "phase": "INITIALIZING", "createdAt": time.time()}
    atomic_json(receipt_path, receipt)
    progress({"phase": "INITIALIZING", "candidate": {"id": restore_id, "container": container,
              "directory": str(candidate), "databaseState": "initializing"}})
    try:
        run(["docker", "run", "-d", "--name", container, "--label", "cbte.recovery=true",
             "--label", "cbte.restore-id=" + restore_id, "--network", "none", "--restart", "no",
             "--memory", str(config.get("mysqlMemory", "8g")), "--cpus", "2", "--pids-limit", "512",
             "--mount", f"type=bind,src={data},dst=/var/lib/mysql",
             "--mount", f"type=bind,src={secret_dir},dst=/run/cbte-secrets,readonly",
             "-e", "MYSQL_ROOT_PASSWORD_FILE=/run/cbte-secrets/root-password",
             "-e", "MYSQL_INITDB_SKIP_TZINFO=1", image, "--event-scheduler=OFF", "--skip-log-bin",
             "--local-infile=OFF", "--max-connections=40", "--innodb-buffer-pool-size=1073741824"], timeout=90)
        ready_deadline = time.monotonic() + 180
        while True:
            try:
                mysql(container, "SELECT 1;", timeout=5)
                break
            except (RuntimeError, subprocess.TimeoutExpired):
                if time.monotonic() >= ready_deadline:
                    raise TimeoutError("Candidate MySQL did not become ready")
                time.sleep(2)
        receipt["phase"] = "IMPORTING"
        atomic_json(receipt_path, receipt)
        progress({"phase": "RESTORING_ISOLATED", "candidate": {"id": restore_id, "databaseState": "importing"}})
        stream_import(artifact, config["ageIdentity"], container, candidate / "import.log", root,
                      timeout=int(config.get("restoreTimeoutSeconds", 7200)),
                      minimum_free_bytes=int(config.get("minimumFreeBytes", 4 * 1024**3)), progress=progress)
        tables = mysql(container, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='ComebackTwitterEmbed' ORDER BY TABLE_NAME;").splitlines()
        required = config.get("requiredTables", ["guilds", "users", "guild_provider_settings", "auto_extract_targets"])
        missing = sorted(set(required) - set(tables))
        if missing:
            raise RuntimeError("Restored CBTE schema is missing required tables: " + ", ".join(missing))
        version = mysql(container, "SELECT VERSION();").strip()
        if not version.startswith("8.0."):
            raise RuntimeError("Restored database engine is not MySQL 8.0")
        scheduler = mysql(container, "SELECT @@GLOBAL.event_scheduler;").strip()
        if scheduler not in ("OFF", "DISABLED"):
            raise RuntimeError("Restored SQL event scheduler is not disabled")
        counts = {}
        for table in required:
            if not re.fullmatch(r"[a-z_]+", table):
                raise ValueError("Invalid required table")
            counts[table] = int(mysql(container, f"SELECT COUNT(*) FROM ComebackTwitterEmbed.`{table}`;", timeout=120).strip())
        mysql(container, "SET GLOBAL read_only=ON; SET GLOBAL super_read_only=ON;")
        receipt.update(phase="VALIDATED", validatedAt=time.time(), databaseState="isolated_read_only",
                       checks={"engine": version, "tableCount": len(tables), "requiredTableCounts": counts,
                               "eventScheduler": scheduler, "ciphertextVerified": True, "importCompleted": True,
                               "network": "none", "savedataMigrated": False})
        atomic_json(receipt_path, receipt)
        return receipt
    except BaseException as error:
        receipt.update(phase="QUARANTINED", error={"type": type(error).__name__, "message": str(error)}, updatedAt=time.time())
        atomic_json(receipt_path, receipt)
        try:
            run(["docker", "stop", "--time", "10", container], timeout=20)
        except Exception:
            pass
        raise
