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
ACTIVE_STEPS = {"INTENT", "POINTER_CLEARED", "STOPPING", "REMOVING", "CONTAINER_REMOVED", "DATA_REMOVING", "RETIRED"}


def same_backup_source(left, right):
    return (isinstance(left, dict) and isinstance(right, dict)
            and all(isinstance(left.get(key), str) and left[key] == right.get(key)
                    for key in ("backupId", "sourceSha256", "sourceTimestamp")))


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


def _stale_active_ownership(config, authority, pointer):
    """Prove that an old activated candidate no longer owns OCI.

    An activated candidate is normally immutable and cannot be retired by the
    standby cache path.  During a completed failback, however, the authority
    can have returned to primary while a stopped OCI pointer and its MySQL
    container remain behind.  This narrow proof is the only automatic escape:
    the authority must select primary, its lease and drain windows must be
    over, and the pointer must belong to an older epoch.
    """
    live = authority()
    if not isinstance(live, dict) or live.get("activeNode") != "primary" or type(live.get("epoch")) is not int:
        raise CapacityError("PRIMARY_OWNERSHIP_UNCONFIRMED", "Live authority must still select primary before stale OCI retirement.")
    now = time.time()
    lease = live.get("lease") or {}
    if lease.get("valid") or now < max(float(live.get("quarantineUntil") or 0),
                                       float(live.get("drainUntil") or 0),
                                       float(lease.get("expiresAt") or 0) + 60):
        raise CapacityError("ACTIVE_CANDIDATE_PRESENT", "The OCI lease or drain window has not expired.")
    if not isinstance(pointer, dict) or type(pointer.get("epoch")) is not int or pointer["epoch"] >= live["epoch"]:
        raise CapacityError("ACTIVE_CANDIDATE_PRESENT", "The active OCI candidate does not belong to an older authority epoch.")
    return live


def _active_container_proof(config, directory, pointer, info):
    """Validate the exact host-network container used by an activated pointer."""
    if not isinstance(info, dict):
        return None
    labels = info.get("Config", {}).get("Labels") or {}
    container_id = info.get("Id", "")
    mounts = {value.get("Destination"): value for value in info.get("Mounts", [])}
    if (not re.fullmatch(r"[0-9a-f]{64}", container_id)
            or info.get("Name") != "/" + pointer.get("container", "")
            or labels.get("cbte.recovery") != "true"
            or labels.get("cbte.restore-id") != pointer.get("id")
            or labels.get("cbte.activation-epoch") != str(pointer.get("epoch"))
            or info.get("Config", {}).get("Image") != config["mysqlImage"]
            or info.get("HostConfig", {}).get("NetworkMode") != "host"
            or info.get("HostConfig", {}).get("RestartPolicy", {}).get("Name") != "no"):
        raise CapacityError("UNOWNED_OR_ACTIVE_CONTAINER", "The stale OCI container is not the recorded activated candidate.")
    for destination, name, writable in [
        ("/var/lib/mysql", "data", True),
        ("/run/cbte-secrets", "secrets", False),
    ]:
        mount = mounts.get(destination, {})
        if (mount.get("Type") != "bind" or mount.get("Source") != str(directory / name)
                or mount.get("RW") is not writable):
            raise CapacityError("CANDIDATE_MOUNT_MISMATCH", "The stale OCI container mount differs from its recorded candidate namespace.")
    return container_id


def _active_retirement_paths(config, identifier):
    root = Path(config["stateDir"])
    journals = root / "active-retirements"
    history = root / "active-candidate-history"
    journals.mkdir(mode=0o700, exist_ok=True)
    history.mkdir(mode=0o700, exist_ok=True)
    regular_path(journals, directory=True, private=True)
    regular_path(history, directory=True, private=True)
    return journals / (identifier + ".json"), history / (identifier + ".json")


def _retire_stale_active(config, authority, update, backend, pointer, journal_path, journal):
    """Resume a durable retirement of a stopped, superseded OCI candidate."""
    if journal.get("step") not in ACTIVE_STEPS or journal.get("version") != 1:
        raise CapacityError("INVALID_ACTIVE_RETIREMENT_JOURNAL", "Unknown stale active-candidate retirement journal.")
    live = _stale_active_ownership(config, authority, pointer)
    identifier = journal.get("candidateId")
    if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
        raise CapacityError("INVALID_RETIREMENT_ID", "A fixed stale candidate identifier is required.")
    root = regular_path(config["candidateRoot"], directory=True)
    directory = regular_path(root / identifier, directory=True)
    receipt = private_json(directory / "receipt.json")
    if (receipt.get("id") != identifier or receipt.get("directory") != str(directory)
            or receipt.get("container") != "cbte-dr-" + identifier
            or receipt.get("mysqlImage") != config["mysqlImage"]):
        raise CapacityError("RETIREMENT_IDENTITY_MISMATCH", "Stale candidate receipt does not match its configured namespace.")
    if receipt.get("phase") not in {"STOPPED", "RETIRED"} or receipt.get("activationEpoch") != pointer.get("epoch"):
        raise CapacityError("STALE_CANDIDATE_UNCONFIRMED", "Only a recorded stopped activation from an older epoch may be retired automatically.")
    if journal.get("pointer") != pointer or journal.get("originalReceipt") != receipt:
        raise CapacityError("ACTIVE_RETIREMENT_RECEIPT_CHANGED", "The stale candidate identity changed during retirement.")

    if journal["step"] == "INTENT":
        prepared_path = Path(config["stateDir"]) / "prepared-candidate.json"
        if prepared_path.exists():
            prepared = private_json(prepared_path)
            if prepared and prepared.get("id") != identifier:
                raise CapacityError("PREPARED_CANDIDATE_CHANGED", "A different prepared candidate must not be invalidated by stale OCI retirement.")
            atomic_json(prepared_path, None)
        atomic_json(journal_path, dict(journal, step="POINTER_CLEARED", updatedAt=time.time()))
        atomic_json(Path(config["stateDir"]) / "active-candidate.json", None)
        update(phase="NO_VALIDATED_STANDBY", candidate=None, backup=None,
               retirement={"candidateId": identifier, "journal": str(journal_path), "state": "retiring"})
        journal = dict(journal, step="POINTER_CLEARED")
    if journal["step"] in {"POINTER_CLEARED", "STOPPING"}:
        info = backend.inspect(receipt["container"])
        if info is not None:
            container_id = _active_container_proof(config, directory, pointer, info)
            if journal["step"] == "POINTER_CLEARED":
                journal = dict(journal, containerId=container_id, step="STOPPING", updatedAt=time.time())
                atomic_json(journal_path, journal)
            _stale_active_ownership(config, authority, pointer)
            if info.get("State", {}).get("Running") is True:
                backend.stop(container_id)
            stopped = backend.inspect(receipt["container"])
            _active_container_proof(config, directory, pointer, stopped)
            if stopped is None or stopped.get("State", {}).get("Running") is not False:
                raise CapacityError("CANDIDATE_STOP_UNCONFIRMED", "The stale OCI container did not confirm a stopped state.")
            _stale_active_ownership(config, authority, pointer)
            backend.remove(container_id)
            if backend.inspect(receipt["container"]) is not None:
                raise CapacityError("CANDIDATE_REMOVAL_UNCONFIRMED", "The stale OCI container could not be removed.")
        journal = dict(journal, step="CONTAINER_REMOVED", updatedAt=time.time())
        atomic_json(journal_path, journal)
    if journal["step"] in {"CONTAINER_REMOVED", "DATA_REMOVING"}:
        _stale_active_ownership(config, authority, pointer)
        data = directory / "data"
        if data.exists() or data.is_symlink():
            regular_path(data, directory=True)
            if data.parent != root / identifier or data.name != "data":
                raise CapacityError("UNSAFE_RETIREMENT_TARGET", "Stale candidate data removal escaped its proven namespace.")
            journal = dict(journal, step="DATA_REMOVING", updatedAt=time.time())
            atomic_json(journal_path, journal)
            backend.remove_data(data)
        retired = dict(receipt, phase="RETIRED", retiredAt=time.time(),
                       retirementJournal=str(journal_path), retirementReason="Superseded OCI activation after primary ownership returned.")
        atomic_json(directory / "receipt.json", retired)
        atomic_json(journal_path, dict(journal, step="RETIRED", updatedAt=time.time()))
        update(phase="NO_VALIDATED_STANDBY", candidate=None, backup=None,
               retirement={"candidateId": identifier, "journal": str(journal_path), "state": "retired"})
    return {"retired": True, "candidateId": identifier, "freeBytes": backend.free_bytes(root)}


def retire_stale_active_candidate(config, authority, update, backend=None):
    """Retire one proven, stopped OCI activation left behind after failback."""
    backend = backend or Backend()
    pointer_path = Path(config["stateDir"]) / "active-candidate.json"
    journals = Path(config["stateDir"]) / "active-retirements"
    if journals.exists():
        for path in sorted(journals.glob("*.json")):
            journal = private_json(path)
            if journal.get("step") != "RETIRED":
                pointer = journal.get("pointer") or private_json(pointer_path)
                return _retire_stale_active(config, authority, update, backend, pointer, path, journal)
    if not pointer_path.exists():
        return None
    pointer = private_json(pointer_path)
    if not pointer:
        return None
    identifier = pointer.get("id")
    if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
        raise CapacityError("ACTIVE_CANDIDATE_PRESENT", "The active OCI candidate identity is invalid.")
    journal_path, history_path = _active_retirement_paths(config, identifier)
    if journal_path.exists():
        journal = private_json(journal_path)
        return _retire_stale_active(config, authority, update, backend, pointer, journal_path, journal)
    _stale_active_ownership(config, authority, pointer)
    root = regular_path(config["candidateRoot"], directory=True)
    directory = regular_path(root / identifier, directory=True)
    receipt = private_json(directory / "receipt.json")
    if receipt.get("phase") != "STOPPED" or receipt.get("activationEpoch") != pointer.get("epoch"):
        raise CapacityError("ACTIVE_CANDIDATE_PRESENT", "The old OCI candidate is not recorded as safely stopped.")
    export_id = (receipt.get("manifest") or {}).get("exportId")
    cipher = Path(config["stateDir"]) / "ciphertexts" / ((export_id or "") + ".sql.zst.age")
    if not isinstance(export_id, str) or not re.fullmatch(r"[0-9a-f]{64}", export_id):
        raise CapacityError("OLD_CIPHERTEXT_UNAVAILABLE", "The stale candidate has no immutable encrypted rollback artifact.")
    regular_path(cipher)
    verify_artifact(cipher, (receipt["manifest"]["export"])["sha256"], (receipt["manifest"]["export"])["bytes"])
    archive = {"version": 1, "candidateId": identifier, "archivedAt": time.time(), "pointer": pointer, "receipt": receipt}
    if history_path.exists():
        existing = private_json(history_path)
        if existing.get("candidateId") != identifier or existing.get("pointer") != pointer or existing.get("receipt") != receipt:
            raise CapacityError("ACTIVE_RETIREMENT_HISTORY_CONFLICT", "Stale candidate history already identifies another pointer.")
    else:
        atomic_json(history_path, archive)
    journal = {"version": 1, "candidateId": identifier, "pointer": pointer, "originalReceipt": receipt,
               "history": str(history_path), "createdAt": time.time(), "step": "INTENT"}
    atomic_json(journal_path, journal)
    return _retire_stale_active(config, authority, update, backend, pointer, journal_path, journal)


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
    stale = None
    pointer_path = Path(config["stateDir"]) / "active-candidate.json"
    if pointer_path.exists():
        pointer = private_json(pointer_path)
        # Keep an activated pointer when it still identifies the same backup;
        # a replacement import must first retire only a stopped, superseded
        # activation whose immutable rollback artifact is verified.
        if pointer and not same_backup_source((pointer.get("manifest") or {}).get("source"), manifest.get("source")):
            stale = retire_stale_active_candidate(config, authority, update, backend)
            if stale:
                candidate = None
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
        return {"freeBytes": free, "requiredBytes": required, "retired": bool(stale),
                **({"retiredCandidateId": stale["candidateId"]} if stale else {})}
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
