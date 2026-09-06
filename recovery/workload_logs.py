"""Bounded read-only tails from the root-verified active OCI runtime."""
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import parse_qsl

COMPONENTS = {"bot", "interactive", "reports"}
MAX_BYTES = 256 * 1024
MAX_LINES = 1000
HEALTH_KEYS = {"name", "maxBytesPerFile", "fileCount", "receivedBytes", "writtenBytes", "droppedBytes", "trimmedBytes", "rotations", "writeError", "readError", "queuedChunks", "queueCapacityBytes", "readerRunning", "writerRunning"}


class WorkloadLogError(Exception):
    def __init__(self, code, message, status=409):
        self.code, self.status = code, status
        super().__init__(message)


def stamp(value=None):
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat() if value is not None else dt.datetime.now(dt.timezone.utc).isoformat()


def options(query):
    try:
        pairs = parse_qsl(query, keep_blank_values=True, strict_parsing=True, max_num_fields=4)
    except ValueError:
        raise WorkloadLogError("INVALID_LOG_QUERY", "Invalid workload log query", 400) from None
    value = dict(pairs)
    if len(value) != len(pairs) or set(value) - {"component", "archive", "bytes", "lines"}:
        raise WorkloadLogError("INVALID_LOG_QUERY", "Only one component, archive, bytes and lines value may be supplied", 400)
    component = value.get("component", "bot")
    if component not in COMPONENTS:
        raise WorkloadLogError("INVALID_LOG_COMPONENT", "Component must be bot, interactive or reports", 400)
    limits = {"archive": ("0", 0, 7), "bytes": (str(64 * 1024), 1, MAX_BYTES), "lines": ("200", 1, MAX_LINES)}
    parsed = {"component": component}
    for key, (default, low, high) in limits.items():
        raw = value.get(key, default)
        if not re.fullmatch(r"[0-9]{1,7}", raw) or not low <= int(raw) <= high:
            raise WorkloadLogError("INVALID_LOG_LIMIT", "Workload log limits are outside the allowed range", 400)
        parsed[key] = int(raw)
    return parsed


def trusted(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise WorkloadLogError("UNTRUSTED_LOG_PATH", "Workload log paths must be physical absolute paths")
    for entry in [*reversed(path.parents), path]:
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise WorkloadLogError("UNTRUSTED_LOG_PATH", "Symbolic links are not allowed in workload log paths")
    info = path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise WorkloadLogError("UNTRUSTED_LOG_FILE", "Expected a private regular workload file")
    if os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077):
        raise WorkloadLogError("UNTRUSTED_LOG_OWNER", "Workload log metadata and files must be private and root-owned")
    return path


def read_metadata(path):
    path = trusted(path)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024 or (os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077)):
            raise WorkloadLogError("INVALID_LOG_METADATA", "Workload metadata is not a bounded private regular file")
        raw = os.read(descriptor, 1024 * 1024 + 1)
        value = json.loads(raw)
        if len(raw) > 1024 * 1024 or not isinstance(value, dict):
            raise ValueError("not a bounded object")
        return value
    except (ValueError, UnicodeError):
        raise WorkloadLogError("INVALID_LOG_METADATA", "Workload metadata could not be parsed") from None
    finally:
        os.close(descriptor)


def redact(text, config, workload):
    values = []
    for source in (config, workload):
        values.extend(value for key, value in source.items() if isinstance(value, str) and (key.lower().endswith("token") or key.lower().endswith("secret")))
    authority = Path(config["workloadConfig"]).parent / "authority.json"
    if authority.exists() or authority.is_symlink():
        values.extend((read_metadata(authority).get("tokens") or {}).values())
    changed = False
    for value in sorted({value for value in values if isinstance(value, str) and len(value) >= 16}, key=len, reverse=True):
        if value in text:
            text = text.replace(value, "[control credential omitted]")
            changed = True
    return text, changed


def tail(path, byte_limit, line_limit):
    path = trusted(path)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or (os.name == "posix" and (before.st_uid != 0 or stat.S_IMODE(before.st_mode) & 0o077)):
            raise WorkloadLogError("UNTRUSTED_LOG_FILE", "Log changed to an untrusted file before reading")
        offset = max(0, before.st_size - byte_limit)
        os.lseek(descriptor, offset, os.SEEK_SET)
        data = os.read(descriptor, min(byte_limit, before.st_size - offset))
        after = os.fstat(descriptor)
        lines = data.splitlines(keepends=True)
        line_cut = len(lines) > line_limit
        if line_cut:
            data = b"".join(lines[-line_limit:])
        try:
            current = path.lstat()
            replaced = (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
        except FileNotFoundError:
            replaced = True
        return {"text": data.decode("utf-8", "replace"), "fileBytes": before.st_size, "returnedBytes": len(data),
                "returnedLines": min(len(lines), line_limit), "omittedBytes": max(0, before.st_size - len(data)),
                "truncated": offset > 0 or line_cut, "firstLinePartial": offset > 0 and not line_cut,
                "fileUpdatedAt": stamp(before.st_mtime), "snapshotChanged": replaced or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns),
                "encoding": "utf-8-with-replacement"}
    finally:
        os.close(descriptor)


def read_workload_logs(config, query):
    selected = options(query)
    base = {"ok": True, "available": False, "state": "not_started", "component": selected["component"], "archive": selected["archive"],
            "text": "", "files": [], "observedAt": stamp(), "limits": {"bytes": selected["bytes"], "lines": selected["lines"]}}
    if not config.get("workloadConfig"):
        return base | {"state": "not_configured", "message": "OCI workload configuration is not installed"}
    workload = read_metadata(config["workloadConfig"])
    state_root = trusted(config["stateDir"], directory=True)
    pointer_path = state_root / "active-candidate.json"
    if workload.get("candidatePointer") != str(pointer_path) or workload.get("candidateRoot") != config["candidateRoot"]:
        raise WorkloadLogError("LOG_RUNTIME_MISMATCH", "Workload candidate paths do not match the controller")
    if not pointer_path.exists() and not pointer_path.is_symlink():
        return base | {"message": "OCI has no activated candidate; workload logs have not been created"}
    pointer = read_metadata(pointer_path)
    identifier = pointer.get("id", "")
    if not re.fullmatch(r"[0-9a-f]{24}", identifier) or type(pointer.get("epoch")) is not int or pointer["epoch"] < 1:
        raise WorkloadLogError("INVALID_LOG_CANDIDATE", "Active candidate identity is invalid")
    candidate_root = trusted(config["candidateRoot"], directory=True)
    directory = trusted(candidate_root / identifier, directory=True)
    receipt = read_metadata(directory / "receipt.json")
    if pointer.get("directory") != str(directory) or pointer.get("container") != "cbte-dr-" + identifier or any(receipt.get(key) != pointer.get(key) for key in ["id", "directory", "container", "mysqlImage", "manifest", "checks"]):
        raise WorkloadLogError("LOG_CANDIDATE_MISMATCH", "Active candidate and restore receipt do not identify the same database")
    base.update(candidateId=identifier, pointerEpoch=pointer["epoch"])
    runtime_root = Path(workload.get("runtimeRoot", "/var/lib/cbte-recovery/workload"))
    if not runtime_root.is_absolute() or ".." in runtime_root.parts or runtime_root == Path(runtime_root.anchor):
        raise WorkloadLogError("UNTRUSTED_LOG_PATH", "Runtime root must be a fixed non-root directory")
    runtime = runtime_root / identifier
    if not runtime.exists() and not runtime.is_symlink():
        return base | {"state": "runtime_absent", "message": "The selected OCI candidate has no workload runtime yet"}
    trusted(runtime_root, directory=True)
    trusted(runtime, directory=True)
    origin = read_metadata(runtime / "oci-state-origin.json")
    if origin.get("candidateId") != identifier or origin.get("origin") != "fresh-oci-state":
        raise WorkloadLogError("UNTRUSTED_LOG_RUNTIME", "Runtime origin does not match the selected OCI candidate")
    metadata_path = runtime / "activation.json"
    if metadata_path.exists() or metadata_path.is_symlink():
        activation = read_metadata(metadata_path)
        if activation.get("candidateId") != identifier or activation.get("container") != pointer["container"]:
            raise WorkloadLogError("LOG_ACTIVATION_MISMATCH", "Activation metadata belongs to a different candidate")
        metadata_source = "activation"
    elif receipt.get("activationEpoch"):
        activation = {"epoch": receipt["activationEpoch"], "phase": receipt.get("phase"), "updatedAt": receipt.get("activationUpdatedAt"), "childLogs": receipt.get("childLogs")}
        metadata_source = "candidate_receipt"
    else:
        return base | {"state": "activation_metadata_absent", "message": "Activation metadata is not available; this is not evidence of an empty log"}
    if type(activation.get("epoch")) is not int or not 1 <= activation["epoch"] <= pointer["epoch"]:
        raise WorkloadLogError("LOG_ACTIVATION_MISMATCH", "Activation epoch is invalid for the selected candidate")
    log_health = next((value for value in activation.get("childLogs") or [] if isinstance(value, dict) and value.get("name") == selected["component"] + ".log"), None)
    base.update(activationEpoch=activation["epoch"], currentActivation=activation["epoch"] == pointer["epoch"], phase=activation.get("phase"),
                activationUpdatedAt=activation.get("updatedAt"), metadataSource=metadata_source,
                logHealth={key: value for key, value in (log_health or {}).items() if key in HEALTH_KEYS} if log_health else None)
    logs = runtime / "logs"
    if not logs.exists() and not logs.is_symlink():
        return base | {"state": "logs_absent", "message": "This activation has no child log directory yet"}
    trusted(logs, directory=True)
    count = workload.get("childLogFileCount", 4)
    if type(count) is not int or not 1 <= count <= 8 or selected["archive"] >= count:
        raise WorkloadLogError("INVALID_LOG_ARCHIVE", "Requested archive is outside the configured retention count", 400)
    name = selected["component"] + ".log"
    for index in range(count):
        path = logs / (name if index == 0 else name + "." + str(index))
        if path.exists() or path.is_symlink():
            try:
                info = trusted(path).stat()
                base["files"].append({"archive": index, "name": path.name, "available": True, "bytes": info.st_size, "updatedAt": stamp(info.st_mtime)})
            except WorkloadLogError:
                base["files"].append({"archive": index, "name": path.name, "available": False, "state": "untrusted"})
    selected_path = logs / (name if selected["archive"] == 0 else name + "." + str(selected["archive"]))
    if not selected_path.exists() and not selected_path.is_symlink():
        return base | {"state": "log_absent", "message": "The selected child log file has not been created or retained"}
    result = base | tail(selected_path, selected["bytes"], selected["lines"])
    result["text"], result["controlCredentialsRedacted"] = redact(result["text"], config, workload)
    return result | {"available": True, "state": "available"}
