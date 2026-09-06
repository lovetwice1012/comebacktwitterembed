"""Bound retired standby ciphertext without removing receipts or live imports.

Only completed single-standby retirement journals authorize a candidate's
ciphertext to become eligible. A newer, fully validated candidate and its
verified ciphertext must exist; the configured retired rollback count is kept.
"""
from __future__ import annotations
import datetime as dt
import hashlib
import os
from pathlib import Path
import re
import time

try:
    from .restore_mysql import atomic_json
    from .standby_retention import regular_path, private_json
except ImportError:
    from restore_mysql import atomic_json
    from standby_retention import regular_path, private_json

IDENTIFIER = re.compile(r"^[0-9a-f]{24}$")
HASH = re.compile(r"^[0-9a-f]{64}$")
AGE_HEADER = b"age-encryption.org/v1\n"


def manifest_identity(config, manifest):
    if not isinstance(manifest, dict):
        raise ValueError("Candidate does not have a complete NAS export manifest")
    source, export = manifest.get("source") or {}, manifest.get("export") or {}
    backup_id, source_hash = source.get("backupId"), source.get("sourceSha256")
    if not isinstance(backup_id, str) or not isinstance(source_hash, str) or not HASH.fullmatch(source_hash):
        raise ValueError("NAS source identity is incomplete")
    expected = hashlib.sha256(("v1\0" + backup_id + "\0" + source_hash + "\0" + config["ociRecipient"]).encode()).hexdigest()
    if manifest.get("schemaVersion") != 1 or manifest.get("scope") != "host-mysql" or manifest.get("backupId") != backup_id or manifest.get("exportId") != expected:
        raise ValueError("NAS export identity is not bound to this source and OCI recipient")
    if export.get("ociRecipient") != config["ociRecipient"] or export.get("recipientFingerprint") != hashlib.sha256(config["ociRecipient"].encode()).hexdigest() or export.get("compression") != "zstd" or export.get("encryption") != "age" or export.get("filename") != "rewrapped.sql.zst.age":
        raise ValueError("NAS export encoding and recipient are unverified")
    if not isinstance(export.get("sha256"), str) or not HASH.fullmatch(export["sha256"]) or type(export.get("bytes")) is not int or export["bytes"] <= len(AGE_HEADER):
        raise ValueError("NAS ciphertext size or checksum is invalid")
    timestamp = dt.datetime.fromisoformat(source["sourceTimestamp"].replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("NAS source time must have a timezone")
    return expected, export, timestamp.timestamp()


def verified_cipher(path, export, deadline):
    regular_path(path, private=True)
    before = path.stat()
    if before.st_size != export["bytes"] or before.st_nlink != 1:
        raise ValueError("Ciphertext size or file ownership changed")
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        if stream.read(len(AGE_HEADER)) != AGE_HEADER:
            raise ValueError("Cache artifact is not recognized age ciphertext")
        stream.seek(0)
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError("Ciphertext retention verification deadline exceeded")
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    after = path.stat()
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
    if identity(before) != identity(after) or digest.hexdigest() != export["sha256"]:
        raise ValueError("Ciphertext changed or failed its saved checksum")
    return identity(after)


def receipt_identity(config, path):
    regular_path(path.parent, directory=True)
    value = private_json(path)
    if not isinstance(value, dict) or not IDENTIFIER.fullmatch(path.parent.name) or value.get("id") != path.parent.name or value.get("directory") != str(path.parent) or value.get("container") != "cbte-dr-" + path.parent.name or value.get("mysqlImage") != config["mysqlImage"]:
        raise ValueError("Candidate receipt ownership could not be verified")
    return value


def retired_proof(config, receipt):
    if receipt.get("phase") != "RETIRED" or any(receipt.get(key) is not None for key in ("epoch", "activationEpoch", "activationUpdatedAt", "activationReason")):
        return False
    journal_path = Path(config["stateDir"]) / "retirements" / (receipt["id"] + ".json")
    if receipt.get("retirementJournal") != str(journal_path):
        return False
    journal = private_json(journal_path)
    original = journal.get("originalReceipt") or {}
    expected = Path(config["stateDir"]) / "ciphertexts" / (receipt["manifest"]["exportId"] + ".sql.zst.age")
    return journal.get("version") == 1 and journal.get("step") == "RETIRED" and journal.get("candidateId") == receipt["id"] and journal.get("originalCiphertext") == str(expected) and original.get("phase") in {"VALIDATED", "QUARANTINED"} and all(original.get(key) == receipt.get(key) for key in ("id", "directory", "container", "mysqlImage", "manifest")) and not any(original.get(key) is not None for key in ("epoch", "activationEpoch", "activationUpdatedAt", "activationReason"))


def prune_validated_cache(config, protected_id):
    keep = config.get("keepRetiredCiphertexts", 1)
    if type(keep) is not int or not 0 <= keep <= 3:
        raise ValueError("keepRetiredCiphertexts must be an integer between 0 and 3")
    state_root = regular_path(config["stateDir"], directory=True, private=True)
    candidate_root = regular_path(config["candidateRoot"], directory=True, private=True)
    cache = regular_path(state_root / "ciphertexts", directory=True, private=True)
    if not isinstance(protected_id, str) or not IDENTIFIER.fullmatch(protected_id):
        raise ValueError("A validated candidate ID is required for ciphertext retention")
    current = receipt_identity(config, candidate_root / protected_id / "receipt.json")
    checks = current.get("checks") or {}
    if current.get("phase") != "VALIDATED" or checks.get("ciphertextVerified") is not True or checks.get("importCompleted") is not True or checks.get("network") != "none" or any(current.get(key) is not None for key in ("epoch", "activationEpoch", "activationUpdatedAt")):
        raise ValueError("A completed, isolated validation is required before retiring cached ciphertext")
    state = private_json(state_root / "state.json")
    prepared = private_json(state_root / "prepared-candidate.json")
    if state.get("phase") != "STANDBY_READY" or (state.get("candidate") or {}).get("id") != protected_id or not isinstance(prepared, dict) or prepared.get("id") != protected_id or prepared.get("manifest") != current.get("manifest"):
        raise ValueError("Current and prepared standby pointers do not identify the validated generation")
    active_path = state_root / "active-candidate.json"
    if (active_path.exists() or active_path.is_symlink()) and private_json(active_path):
        raise ValueError("An active OCI candidate prevents standby cache retirement")
    deadline = time.monotonic() + 30
    current_id, current_export, current_time = manifest_identity(config, current["manifest"])
    verified_cipher(cache / (current_id + ".sql.zst.age"), current_export, deadline)
    references = {}
    for directory in candidate_root.iterdir():
        if not IDENTIFIER.fullmatch(directory.name):
            continue
        if directory.is_symlink() or not directory.is_dir() or not (directory / "receipt.json").is_file():
            raise ValueError("Unknown candidate namespace prevents ciphertext retirement")
        receipt = receipt_identity(config, directory / "receipt.json")
        export_id, export, timestamp = manifest_identity(config, receipt.get("manifest"))
        group = references.setdefault(export_id, {"export": export, "timestamp": timestamp, "receipts": [], "eligible": True})
        if group["export"] != export:
            raise ValueError("Conflicting manifests refer to one cached export")
        group["receipts"].append(receipt)
        group["eligible"] = group["eligible"] and timestamp < current_time and retired_proof(config, receipt)
    eligible = sorted(((key, value) for key, value in references.items() if value["eligible"] and key != current_id), key=lambda item: (item[1]["timestamp"], item[0]), reverse=True)
    protected = {key for key, value in references.items() if not value["eligible"]} | {key for key, _ in eligible[:keep]}
    journal_root = state_root / "cipher-retirements"
    journal_root.mkdir(mode=0o700, exist_ok=True)
    regular_path(journal_root, directory=True, private=True)
    removed, reclaimed, deferred = [], 0, []
    for export_id, group in eligible[keep:]:
        artifact = cache / (export_id + ".sql.zst.age")
        journal_path = journal_root / (export_id + ".json")
        if len(removed) >= 4 or time.monotonic() >= deadline:
            deferred.append(export_id)
            continue
        expected = {"version": 1, "exportId": export_id, "sha256": group["export"]["sha256"], "bytes": group["export"]["bytes"], "reason": "retired_ciphertext_count"}
        journal = private_json(journal_path) if journal_path.exists() else None
        if journal is not None and (any(journal.get(key) != value for key, value in expected.items()) or journal.get("state") not in {"REMOVING", "REMOVED"}):
            raise ValueError("Ciphertext retirement journal does not match the immutable artifact")
        if not artifact.exists():
            if journal and journal["state"] == "REMOVING":
                atomic_json(journal_path, journal | {"state": "REMOVED", "removedAt": time.time()})
            continue
        identity = verified_cipher(artifact, group["export"], deadline)
        # Recheck every authoritative pointer and eligible receipt at the
        # deletion boundary; pending/active/unknown data never becomes eligible.
        if private_json(state_root / "prepared-candidate.json") != prepared or receipt_identity(config, candidate_root / protected_id / "receipt.json") != current or ((active_path.exists() or active_path.is_symlink()) and private_json(active_path)):
            raise ValueError("Validated or active standby pointers changed during cache retention")
        for receipt in group["receipts"]:
            if receipt_identity(config, candidate_root / receipt["id"] / "receipt.json") != receipt or not retired_proof(config, receipt):
                raise ValueError("Retired candidate identity changed during cache retention")
        journal = expected | {"state": "REMOVING", "validatedReplacementId": protected_id, "validatedReplacementExportId": current_id, "retiredCandidateIds": [receipt["id"] for receipt in group["receipts"]], "createdAt": (journal or {}).get("createdAt", time.time())}
        atomic_json(journal_path, journal)
        regular_path(artifact, private=True)
        info = artifact.stat()
        if identity != (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
            raise ValueError("Ciphertext identity changed immediately before deletion")
        artifact.unlink()
        if os.name == "posix":
            descriptor = os.open(cache, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        atomic_json(journal_path, journal | {"state": "REMOVED", "removedAt": time.time()})
        removed.append(export_id)
        reclaimed += group["export"]["bytes"]
    return {"state": "deferred" if deferred else "complete", "keepRetiredRollbackGenerations": keep, "removedExportIds": removed, "reclaimedBytes": reclaimed, "deferredExportIds": deferred, "protectedExportIds": sorted(protected), "receiptsPreserved": True, "checkedAt": time.time()}
