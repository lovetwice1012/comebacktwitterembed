#!/usr/bin/env python3
"""Opt-in replacement of one proven, never-activated isolated standby.

Only a candidate's data subdirectory may be removed. Ciphertext, original
validation evidence, credentials and the retirement journal are retained.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import time

try:
    from .restore_mysql import atomic_json, read_json, run, verify_artifact
except ImportError:
    from restore_mysql import atomic_json, read_json, run, verify_artifact

GIB = 1024 ** 3
IDENTIFIER = re.compile(r"[0-9a-f]{24}")
STEPS = {"INTENT", "POINTER_CLEARED", "STOPPING", "REMOVING", "CONTAINER_REMOVED", "DATA_REMOVING", "RETIRED"}


class CapacityError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(code + ": " + message)


def regular_path(path, *, directory=False, private=False):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise CapacityError("UNTRUSTED_RETIREMENT_PATH", "Absolute paths without traversal are required.")
    for entry in [*reversed(path.parents), path]:
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise CapacityError("UNTRUSTED_RETIREMENT_PATH", "Retirement paths must not contain symbolic links.")
    info = path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise CapacityError("UNTRUSTED_RETIREMENT_PATH", "Unexpected retirement file type.")
    if private and os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077):
        raise CapacityError("UNTRUSTED_RETIREMENT_METADATA", "Retirement metadata must be private and root-owned.")
    return path


def private_json(path):
    regular_path(path, private=True)
    if Path(path).stat().st_size > 2 * 1024 * 1024:
        raise CapacityError("RETIREMENT_METADATA_LIMIT", "Retirement metadata exceeds its size limit.")
    return read_json(path)


class Backend:
    def free_bytes(self, directory):
        return shutil.disk_usage(directory).free

    def allocated_bytes(self, directory):
        regular_path(directory, directory=True)
        if os.path.ismount(directory):
            raise CapacityError("UNBOUNDED_CANDIDATE_DATA", "Candidate data must not itself be a mount point.")
        total, entries = 0, 0
        device = directory.stat().st_dev
        for parent, directories, files in os.walk(directory, followlinks=False):
            for name in directories + files:
                entry = Path(parent) / name
                info = entry.lstat()
                entries += 1
                if entries > 1000000 or info.st_dev != device:
                    raise CapacityError("UNBOUNDED_CANDIDATE_DATA", "Candidate data contains an unexpected mount or too many files.")
                total += getattr(info, "st_blocks", math.ceil(info.st_size / 512)) * 512
        return total

    def inspect(self, container):
        # A successful empty listing distinguishes absence from a Docker
        # failure; an unsuccessful inspect alone never proves absence.
        ids = run(["docker", "ps", "--all", "--no-trunc", "--filter", "name=^/" + container + "$", "--format", "{{.ID}}"], timeout=15).splitlines()
        if not ids:
            return None
        if len(ids) != 1 or not re.fullmatch(r"[0-9a-f]{64}", ids[0]):
            raise CapacityError("UNKNOWN_CANDIDATE_CONTAINER", "Container identity could not be uniquely verified.")
        values = json.loads(run(["docker", "inspect", ids[0]], timeout=15))
        if not isinstance(values, list) or len(values) != 1:
            raise CapacityError("UNKNOWN_CANDIDATE_CONTAINER", "Unexpected Docker inspection response.")
        return values[0]

    def stop(self, container_id):
        run(["docker", "stop", "--time", "10", container_id], timeout=25)

    def remove(self, container_id):
        run(["docker", "rm", container_id], timeout=20)

    def remove_data(self, directory):
        regular_path(directory, directory=True)
        if os.path.ismount(directory):
            raise CapacityError("UNSAFE_RETIREMENT_TARGET", "A mounted data directory cannot be removed.")
        self.allocated_bytes(directory)  # Recheck nested mounts at the deletion boundary.
        shutil.rmtree(directory)


def _receipt(config, identifier, allowed_phases=None):
    if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
        raise CapacityError("INVALID_RETIREMENT_ID", "A fixed candidate identifier is required.")
    root = regular_path(config["candidateRoot"], directory=True)
    directory = regular_path(root / identifier, directory=True)
    receipt = private_json(directory / "receipt.json")
    if not isinstance(receipt, dict) or receipt.get("id") != identifier or receipt.get("directory") != str(directory) or receipt.get("container") != "cbte-dr-" + identifier or receipt.get("mysqlImage") != config["mysqlImage"]:
        raise CapacityError("RETIREMENT_IDENTITY_MISMATCH", "Candidate receipt does not match its configured namespace and image.")
    if receipt.get("phase") not in (allowed_phases or {"VALIDATED", "QUARANTINED", "RETIRED"}) or any(receipt.get(key) is not None for key in ("epoch", "activationEpoch", "activationUpdatedAt", "activationReason")):
        raise CapacityError("CANDIDATE_WAS_ACTIVATED", "An activated or unclassified candidate may never be retired automatically.")
    return directory, receipt


def quarantine_interrupted_candidate(config, candidate, authority, backend=None):
    """Preserve a restart-interrupted candidate only after proving its stop."""
    backend = backend or Backend()
    if not isinstance(candidate, dict) or any(candidate.get(key) is not None for key in ("epoch", "activationEpoch", "activationUpdatedAt")):
        raise CapacityError("INTERRUPTED_CANDIDATE_UNVERIFIED", "Interrupted state does not identify a never-activated candidate.")
    directory, receipt = _receipt(config, candidate.get("id"), {"INITIALIZING", "IMPORTING", "VALIDATED", "QUARANTINED"})
    _authority_primary(config, authority)
    info = backend.inspect(receipt["container"])
    container_id = _container_proof(config, directory, receipt, info)
    # The full immutable identity is checked again after the stop; an exit
    # status alone cannot turn unknown database state into a deletion permit.
    _authority_primary(config, authority)
    backend.stop(container_id)
    stopped = backend.inspect(receipt["container"])
    _container_proof(config, directory, receipt, stopped, container_id)
    if stopped.get("State", {}).get("Running") is not False:
        raise CapacityError("CANDIDATE_STOP_UNCONFIRMED", "Interrupted import container did not confirm a stopped state.")
    quarantined = dict(receipt, phase="QUARANTINED", updatedAt=time.time(),
                       error={"type": "RESTORE_INTERRUPTED", "message": "Controller restart interrupted the import; owned isolated container is confirmed stopped."})
    atomic_json(directory / "receipt.json", quarantined)
    return quarantined


def _authority_primary(config, authority):
    live = authority()
    if not isinstance(live, dict) or live.get("activeNode") != "primary" or type(live.get("epoch")) is not int:
        raise CapacityError("PRIMARY_OWNERSHIP_UNCONFIRMED", "Live authority must still select primary before standby retirement.")
    pointer_path = Path(config["stateDir"]) / "active-candidate.json"
    if pointer_path.exists() and private_json(pointer_path):
        raise CapacityError("ACTIVE_CANDIDATE_PRESENT", "An OCI active-candidate pointer forbids standby retirement.")
    return live


def _container_proof(config, directory, receipt, info, expected_id=None):
    if not isinstance(info, dict):
        raise CapacityError("UNKNOWN_CANDIDATE_CONTAINER", "An existing owned container is required before a new retirement.")
    labels = info.get("Config", {}).get("Labels") or {}
    container_id = info.get("Id", "")
    mounts = {value.get("Destination"): value for value in info.get("Mounts", [])}
    if not re.fullmatch(r"[0-9a-f]{64}", container_id) or (expected_id and expected_id != container_id) or info.get("Name") != "/" + receipt["container"] or labels.get("cbte.recovery") != "true" or labels.get("cbte.restore-id") != receipt["id"] or "cbte.activation-epoch" in labels or info.get("Config", {}).get("Image") != config["mysqlImage"] or info.get("HostConfig", {}).get("NetworkMode") != "none" or info.get("HostConfig", {}).get("RestartPolicy", {}).get("Name") != "no":
        raise CapacityError("UNOWNED_OR_ACTIVE_CONTAINER", "Container labels, image, immutable ID and isolated network must match the never-activated candidate.")
    for destination, name, writable in [("/var/lib/mysql", "data", True), ("/run/cbte-secrets", "secrets", False)]:
        mount = mounts.get(destination, {})
        if mount.get("Type") != "bind" or mount.get("Source") != str(directory / name) or mount.get("RW") is not writable:
            raise CapacityError("CANDIDATE_MOUNT_MISMATCH", "Container bind mounts differ from the candidate namespace.")
    return container_id


def _verified_cipher(config, manifest, artifact):
    export = manifest.get("export") or {}
    if export.get("ociRecipient") != config["ociRecipient"] or not isinstance(manifest.get("source"), dict):
        raise CapacityError("UNVERIFIED_REPLACEMENT_CIPHER", "Replacement ciphertext must be bound to this OCI recipient and backup source.")
    regular_path(artifact)
    verify_artifact(artifact, export.get("sha256"), export.get("bytes"))


def _checkpoint(path, journal, step):
    journal.update(step=step, updatedAt=time.time())
    atomic_json(path, journal)


def _retire(config, journal_path, journal, authority, update, backend):
    if journal.get("step") not in STEPS or journal.get("version") != 1:
        raise CapacityError("INVALID_RETIREMENT_JOURNAL", "Unknown retirement journal format.")
    directory, receipt = _receipt(config, journal.get("candidateId"))
    original = journal.get("originalReceipt")
    if not isinstance(original, dict) or (receipt != original and not (receipt.get("phase") == "RETIRED" and receipt.get("retirementJournal") == str(journal_path))):
        raise CapacityError("RETIREMENT_RECEIPT_CHANGED", "Candidate receipt changed after retirement was reserved.")
    if journal["step"] == "RETIRED":
        return
    _verified_cipher(config, journal["replacementManifest"], Path(journal["replacementCiphertext"]))
    # Retain and verify the old encrypted generation before relinquishing the
    # only restored copy. It remains available for a future isolated import.
    old_export = original["manifest"]["export"]
    verify_artifact(journal["originalCiphertext"], old_export["sha256"], old_export["bytes"])
    _authority_primary(config, authority)
    prepared_path = Path(config["stateDir"]) / "prepared-candidate.json"
    if prepared_path.exists():
        prepared = private_json(prepared_path)
        if prepared and prepared.get("id") != journal["candidateId"]:
            raise CapacityError("PREPARED_CANDIDATE_CHANGED", "Another prepared candidate must not be invalidated by this retirement.")
    # Null is durable and already treated as absent by controller recovery.
    atomic_json(prepared_path, None)
    update(phase="NO_VALIDATED_STANDBY", candidate=None, backup=None,
           retirement={"candidateId": journal["candidateId"], "journal": str(journal_path), "backup": original["manifest"]["source"], "state": "retiring"})
    if journal["step"] == "INTENT":
        _checkpoint(journal_path, journal, "POINTER_CLEARED")
    info = backend.inspect(original["container"])
    if info is not None:
        container_id = _container_proof(config, directory, original, info, journal["containerId"])
        _checkpoint(journal_path, journal, "STOPPING")
        _authority_primary(config, authority)
        backend.stop(container_id)
        stopped = backend.inspect(original["container"])
        _container_proof(config, directory, original, stopped, container_id)
        if stopped.get("State", {}).get("Running") is not False:
            raise CapacityError("CANDIDATE_STOP_UNCONFIRMED", "Container must be stopped before its data is retired.")
        _checkpoint(journal_path, journal, "REMOVING")
        _authority_primary(config, authority)
        backend.remove(container_id)
        if backend.inspect(original["container"]) is not None:
            raise CapacityError("CANDIDATE_REMOVAL_UNCONFIRMED", "Container removal could not be confirmed.")
        _checkpoint(journal_path, journal, "CONTAINER_REMOVED")
    elif journal["step"] not in {"REMOVING", "CONTAINER_REMOVED", "DATA_REMOVING"}:
        raise CapacityError("UNKNOWN_CANDIDATE_CONTAINER", "Absent container has no preceding durable removal intent.")
    _checkpoint(journal_path, journal, "DATA_REMOVING")
    _authority_primary(config, authority)
    data = directory / "data"
    if data.exists() or data.is_symlink():
        regular_path(data, directory=True)
        if data.parent != Path(config["candidateRoot"]) / journal["candidateId"] or data.name != "data":
            raise CapacityError("UNSAFE_RETIREMENT_TARGET", "Deletion is restricted to the proven candidate data directory.")
        backend.remove_data(data)
    retired = dict(original, phase="RETIRED", retiredAt=time.time(), retirementJournal=str(journal_path))
    atomic_json(directory / "receipt.json", retired)
    _checkpoint(journal_path, journal, "RETIRED")
    update(phase="NO_VALIDATED_STANDBY", candidate=None, backup=None,
           retirement={"candidateId": journal["candidateId"], "journal": str(journal_path), "backup": original["manifest"]["source"], "state": "retired"})


def ensure_capacity(config, artifact, manifest, candidate, authority, update, backend=None):
    """Return only when another isolated import fits its configured reserve."""
    backend = backend or Backend()
    mode = config.get("standbyReplacement")
    if mode not in (None, "single"):
        raise CapacityError("INVALID_STANDBY_REPLACEMENT", "standbyReplacement must be omitted or explicitly 'single'.")
    _verified_cipher(config, manifest, Path(artifact))
    root = Path(config["candidateRoot"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    regular_path(root, directory=True)
    # If startup could not reach the authority, quarantine can be retried
    # here once it recovers. The retained identity prevents an orphan import
    # from silently consuming all space on every subsequent attempt.
    if candidate and isinstance(candidate.get("id"), str) and IDENTIFIER.fullmatch(candidate["id"]):
        receipt_path = root / candidate["id"] / "receipt.json"
        if receipt_path.exists() and (private_json(receipt_path) or {}).get("phase") in {"INITIALIZING", "IMPORTING"}:
            candidate = quarantine_interrupted_candidate(config, candidate, authority, backend)
            update(phase="PREPARATION_INTERRUPTED", candidate=candidate, backup=None)
    journals = Path(config["stateDir"]) / "retirements"
    journals.mkdir(mode=0o700, exist_ok=True)
    regular_path(journals, directory=True, private=True)
    previous_bytes = 0
    for path in sorted(journals.glob("*.json")):
        journal = private_json(path)
        if not isinstance(journal, dict) or path.stem != journal.get("candidateId") or not IDENTIFIER.fullmatch(path.stem):
            raise CapacityError("INVALID_RETIREMENT_JOURNAL", "Journal identity differs from its filename.")
        if type(journal.get("allocatedDataBytes")) is not int or journal["allocatedDataBytes"] < 0:
            raise CapacityError("INVALID_RETIREMENT_JOURNAL", "Retirement journal has no valid prior data-allocation measurement.")
        previous_bytes = max(previous_bytes, journal["allocatedDataBytes"])
        if journal.get("step") != "RETIRED":
            if mode != "single":
                raise CapacityError("RETIREMENT_PAUSED", "An interrupted single-standby retirement requires that mode to remain explicitly enabled.")
            _retire(config, path, journal, authority, update, backend)
            candidate = None
    reserve = int(config.get("minimumFreeBytes", 4 * GIB))
    configured = config.get("restoreCapacityBytes")
    if candidate and isinstance(candidate.get("id"), str) and IDENTIFIER.fullmatch(candidate["id"]):
        data = root / candidate["id"] / "data"
        if data.exists():
            previous_bytes = backend.allocated_bytes(data)
    import_bytes = int(configured) if configured is not None else max(16 * GIB, math.ceil(previous_bytes * 1.15)) if previous_bytes else 32 * GIB
    if import_bytes < 0 or reserve < 0:
        raise CapacityError("INVALID_RESTORE_CAPACITY", "Restore capacity and free-space reserve must not be negative.")
    required, free = import_bytes + reserve, backend.free_bytes(root)
    if free >= required:
        return {"freeBytes": free, "requiredBytes": required, "retired": False}
    if mode != "single":
        raise CapacityError("STANDBY_REPLACEMENT_DISABLED", f"Another isolated import needs {required} free bytes (including {reserve} reserve), but only {free} are available. Existing standby data was preserved; single-standby replacement is not enabled.")
    _authority_primary(config, authority)
    if not candidate:
        raise CapacityError("NO_RETIRABLE_STANDBY", f"Need {required} free bytes, have {free}; no current validated standby is available for verified replacement.")
    directory, original = _receipt(config, candidate.get("id"))
    if original.get("phase") == "RETIRED" or any(candidate.get(key) is not None for key in ("epoch", "activationEpoch", "activationUpdatedAt")):
        raise CapacityError("CANDIDATE_WAS_ACTIVATED", "Only a never-activated current standby can release its data.")
    allocated = backend.allocated_bytes(directory / "data")
    if free + allocated < required:
        raise CapacityError("RETIREMENT_INSUFFICIENT_SPACE", f"Even retiring the standby would provide only {free + allocated} of {required} required bytes. Existing standby data was preserved.")
    info = backend.inspect(original["container"])
    container_id = _container_proof(config, directory, original, info)
    old_manifest = original.get("manifest") or {}
    old_id = old_manifest.get("exportId", "")
    if not re.fullmatch(r"[0-9a-f]{64}", old_id):
        raise CapacityError("OLD_CIPHERTEXT_UNAVAILABLE", "The old restore receipt does not identify its encrypted archive.")
    old_cipher = Path(config["stateDir"]) / "ciphertexts" / (old_id + ".sql.zst.age")
    regular_path(old_cipher)
    verify_artifact(old_cipher, old_manifest["export"]["sha256"], old_manifest["export"]["bytes"])
    journal = {"version": 1, "candidateId": original["id"], "containerId": container_id, "originalReceipt": original, "originalCiphertext": str(old_cipher), "replacementCiphertext": str(artifact), "replacementManifest": manifest, "allocatedDataBytes": allocated, "requiredFreeBytes": required, "createdAt": time.time()}
    journal_path = journals / (original["id"] + ".json")
    if journal_path.exists():
        raise CapacityError("RETIREMENT_JOURNAL_CONFLICT", "A different retirement already uses this immutable candidate ID.")
    _checkpoint(journal_path, journal, "INTENT")
    _retire(config, journal_path, journal, authority, update, backend)
    free = backend.free_bytes(root)
    if free < required:
        raise CapacityError("RETIREMENT_INSUFFICIENT_SPACE", f"Standby data was retired, but {free} free bytes remain below {required}; import has not started.")
    return {"freeBytes": free, "requiredBytes": required, "retired": True}
