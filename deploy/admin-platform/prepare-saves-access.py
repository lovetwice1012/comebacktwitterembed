#!/usr/bin/env python3
"""Incrementally repair existing saved-data ACLs outside management startup.

Linux/root only. Fixed source and principal; no recursive chmod/chown, shell,
first-time default ACL creation, or saved-data deletion. See SAVES-ACCESS.md.
"""
import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import sqlite3
import stat
import time
if os.name == "posix":
    import fcntl
    import pwd


SOURCE = Path("/root/comebacktwitterembed/saves")
STATE = Path("/var/lib/cbte-admin-saves-acl")


def parse_acl(text):
    entries = {}
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split(":")
        if len(parts) != 3 or parts[0] not in {"user", "group", "mask", "other"} or parts[1] and (parts[0] not in {"user", "group"} or not parts[1].isdigit()):
            raise ValueError("unsupported_acl")
        if len(parts[2]) != 3 or any(char not in (expected, "-") for char, expected in zip(parts[2], "rwx")):
            raise ValueError("invalid_acl_permissions")
        key = (parts[0], parts[1])
        if key in entries:
            raise ValueError("duplicate_acl_entry")
        entries[key] = sum(bit for char, bit in zip(parts[2], (4, 2, 1)) if char != "-")
    if entries and any((kind, "") not in entries for kind in ("user", "group", "other")):
        raise ValueError("incomplete_acl")
    return entries


def effective(entries, uid, owner, group, groups):
    if uid == owner:
        return entries[("user", "")]
    mask = entries.get(("mask", ""), 7)
    if ("user", str(uid)) in entries:
        return entries[("user", str(uid))] & mask
    matched, permissions = False, 0
    if group in groups:
        matched, permissions = True, entries[("group", "")]
    for (kind, identity), value in entries.items():
        if kind == "group" and identity and int(identity) in groups:
            matched, permissions = True, permissions | value
    return permissions & mask if matched else entries[("other", "")]


def repair_acl(text, uid, required, owner, group, groups, default=False):
    entries = parse_acl(text)
    # Creating a first default ACL changes umask inheritance. This conservative
    # repair intentionally never introduces one automatically.
    if not entries:
        return None
    old_mask = entries.get(("mask", ""), 7)
    current = (entries.get(("user", str(uid)), 0) & old_mask) if default else effective(entries, uid, owner, group, groups)
    if current & required == required:
        return None
    if not default and owner == uid:
        raise ValueError("admin_owner_mode_insufficient")
    new_mask = entries.get(("mask", ""), entries[("group", "")]) | required
    result = dict(entries)
    for (kind, identity), value in entries.items():
        if (kind == "group" or kind == "user" and identity) and (kind, identity) != ("user", str(uid)):
            # Preserve the effective access of every other group-class principal
            # before making newly requested mask bits available to this admin.
            result[(kind, identity)] = value & old_mask
    result[("user", str(uid))] = entries.get(("user", str(uid)), 0) | required
    result[("mask", "")] = new_mask
    order = {"user": 0, "group": 1, "mask": 2, "other": 3}
    return "\n".join(f"{kind}:{identity}:" + "".join(char if permissions & bit else "-" for char, bit in zip("rwx", (4, 2, 1)))
                     for (kind, identity), permissions in sorted(result.items(), key=lambda item: (order[item[0][0]], item[0][1]))) + "\n"


class NativeAcl:
    """Use pinned descriptors, avoiding pathname check/setfacl symlink races."""
    def __init__(self):
        self.lib = ctypes.CDLL("libacl.so.1", use_errno=True)
        declarations = {"acl_get_fd": ([ctypes.c_int], ctypes.c_void_p), "acl_get_file": ([ctypes.c_char_p, ctypes.c_int], ctypes.c_void_p),
                        "acl_to_any_text": ([ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char, ctypes.c_int], ctypes.c_void_p),
                        "acl_entries": ([ctypes.c_void_p], ctypes.c_int), "acl_from_text": ([ctypes.c_char_p], ctypes.c_void_p),
                        "acl_set_fd": ([ctypes.c_int, ctypes.c_void_p], ctypes.c_int), "acl_set_file": ([ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p], ctypes.c_int),
                        "acl_valid": ([ctypes.c_void_p], ctypes.c_int), "acl_free": ([ctypes.c_void_p], ctypes.c_int)}
        for name, (arguments, result) in declarations.items():
            function = getattr(self.lib, name); function.argtypes = arguments; function.restype = result
    def read(self, descriptor, default=False):
        acl = self.lib.acl_get_file(f"/proc/self/fd/{descriptor}".encode(), 0x4000) if default else self.lib.acl_get_fd(descriptor)
        if not acl:
            raise OSError(ctypes.get_errno(), "acl_read_failed")
        pointer = None
        try:
            if not 0 <= self.lib.acl_entries(acl) <= 2048:
                raise ValueError("acl_too_many_entries")
            pointer = self.lib.acl_to_any_text(acl, None, b'\n', 0x08)  # TEXT_NUMERIC_IDS; never invoke NSS name lookup.
            if not pointer:
                raise ValueError("acl_text_invalid_or_too_large")
            text = ctypes.string_at(pointer)
            if len(text) > 65536: raise ValueError("acl_text_too_large")
            return text.decode("ascii")
        finally:
            if pointer: self.lib.acl_free(pointer)
            self.lib.acl_free(acl)
    def write(self, descriptor, text, default=False):
        acl = self.lib.acl_from_text(text.encode("ascii"))
        if not acl:
            raise ValueError("acl_text_invalid")
        try:
            if self.lib.acl_valid(acl) != 0:
                raise ValueError("acl_validation_failed")
            result = self.lib.acl_set_file(f"/proc/self/fd/{descriptor}".encode(), 0x4000, acl) if default else self.lib.acl_set_fd(descriptor, acl)
            if result != 0:
                raise OSError(ctypes.get_errno(), "acl_write_failed")
        finally:
            self.lib.acl_free(acl)


def pin(root_fd, relative):
    parts = relative.split("/") if relative else []
    if any(not part or part in (".", "..") or "\x00" in part for part in parts):
        raise ValueError("invalid_checkpoint_path")
    descriptor = os.dup(root_fd)
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if index < len(parts) - 1: flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor); descriptor = child
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def run_batch(root, state_dir, uid, groups, acl, budget=2, max_entries=128, max_writes=16):
    started = time.monotonic()
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = database = None
    status = {"state": "pending", "examined": 0, "changed": 0, "unchanged": 0, "discovered": 0, "skipped": 0}
    try:
        root_info = os.fstat(root_fd)
        state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if state_dir.is_symlink() or os.name == "posix" and (state_dir.stat().st_uid != 0 or stat.S_IMODE(state_dir.stat().st_mode) & 0o077):
            raise ValueError("private_state_directory_required")
        lock = open(state_dir / "lock", "a+b")
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        database = sqlite3.connect(state_dir / "checkpoint.sqlite", timeout=0.1)
        database.execute("CREATE TABLE IF NOT EXISTS metadata(identity TEXT NOT NULL)")
        database.execute("CREATE TABLE IF NOT EXISTS work(path TEXT PRIMARY KEY, acl_done INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, reason TEXT)")
        database.execute("CREATE INDEX IF NOT EXISTS pending_work ON work(done,acl_done,path)")
        identity = json.dumps([str(root), root_info.st_dev, root_info.st_ino, uid, sorted(groups), 1])
        previous = database.execute("SELECT identity FROM metadata").fetchone()
        if previous and previous[0] != identity: raise ValueError("checkpoint_identity_changed")
        if not previous:
            database.execute("INSERT INTO metadata VALUES (?)", (identity,))
            database.execute("INSERT INTO work(path) VALUES ('')")
        while time.monotonic() - started < budget and status["examined"] + status["discovered"] < max_entries and status["changed"] < max_writes:
            task = database.execute("SELECT path,acl_done FROM work WHERE done=0 ORDER BY acl_done,path LIMIT 1").fetchone()
            if not task: break
            relative, acl_done = task
            status["currentPath"] = relative[:512]
            status["examined"] += 1
            try:
                descriptor = pin(root_fd, relative)
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ELOOP, errno.ENOTDIR): raise
                database.execute("UPDATE work SET done=1 WHERE path=?", (relative,)); status["skipped"] += 1
                continue
            try:
                info = os.fstat(descriptor)
                directory = stat.S_ISDIR(info.st_mode)
                if not directory and not stat.S_ISREG(info.st_mode):
                    database.execute("UPDATE work SET done=1 WHERE path=?", (relative,)); status["skipped"] += 1
                    continue
                if not directory and info.st_nlink != 1:
                    database.execute("UPDATE work SET done=1,reason='hardlinked_file' WHERE path=?", (relative,)); status["skipped"] += 1
                    continue
                if not directory and info.st_mode & (stat.S_ISUID | stat.S_ISGID):
                    database.execute("UPDATE work SET done=1,reason='privileged_file_mode' WHERE path=?", (relative,)); status["skipped"] += 1
                    continue
                if relative.split("/")[-1] in {".admin-save.lock", ".admin-save-journal.json"}:
                    # These files now have an explicit shared-GID protocol.
                    # Do not claim that an access ACL alone repairs old ownership.
                    database.execute("UPDATE work SET done=1,reason='control_file_requires_gid_protocol_check' WHERE path=?", (relative,)); status["skipped"] += 1
                    continue
                if not acl_done:
                    finished = True
                    for default in ([False, True] if directory else [False]):
                        if status["changed"] >= max_writes or time.monotonic() - started >= budget:
                            finished = False; break
                        before = os.fstat(descriptor)
                        current = acl.read(descriptor, default)
                        desired = repair_acl(current, uid, 7 if directory or before.st_mode & 0o111 else 6, before.st_uid, before.st_gid, groups, default)
                        if time.monotonic() - started >= budget:
                            finished = False; break
                        if desired is not None:
                            if os.fstat(descriptor).st_ctime_ns != before.st_ctime_ns:
                                raise ValueError("inode_changed_during_acl_read")
                            acl.write(descriptor, desired, default); status["changed"] += 1
                        else:
                            status["unchanged"] += 1
                    if not finished: break
                    database.execute("UPDATE work SET acl_done=1 WHERE path=?", (relative,))
                if not directory:
                    database.execute("UPDATE work SET done=1 WHERE path=?", (relative,))
                    continue
                # Discover one directory at a time. Interrupted discovery may
                # reread its names; queued/completed inodes are not ACL-rewritten.
                complete = True
                with os.scandir(descriptor) as entries:
                    for entry in entries:
                        if time.monotonic() - started >= budget or status["examined"] + status["discovered"] >= max_entries:
                            complete = False; break
                        child = relative + "/" + entry.name if relative else entry.name
                        inserted = database.execute("INSERT OR IGNORE INTO work(path) VALUES (?)", (child,)).rowcount
                        status["discovered"] += inserted
                if complete: database.execute("UPDATE work SET done=1 WHERE path=?", (relative,))
            finally:
                os.close(descriptor)
        database.commit()
        pending, total, deferred, controls = database.execute("SELECT SUM(done=0),COUNT(*),SUM(reason IS NOT NULL AND reason<>'control_file_requires_gid_protocol_check'),SUM(reason='control_file_requires_gid_protocol_check') FROM work").fetchone()
        status.update(state="pending" if pending else "needs_review" if deferred else "complete", pendingPaths=pending or 0, discoveredPaths=total,
                      deferredPaths=deferred or 0, controlPathsExcluded=controls or 0, scope="existing_saved_data_acls",
                      elapsedSeconds=round(time.monotonic() - started, 3))
        return status
    except Exception as error:
        error.repair_progress = dict(status)
        raise
    finally:
        if database:
            database.commit(); database.close()
        if lock: lock.close()
        os.close(root_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--budget-seconds", type=float, default=2)
    parser.add_argument("--max-entries", type=int, default=128)
    parser.add_argument("--max-acl-writes", type=int, default=16)
    args = parser.parse_args()
    if os.name != "posix" or os.getuid() != 0: raise SystemExit("Linux root is required.")
    if not 0 < args.budget_seconds <= 10 or not 1 <= args.max_entries <= 4096 or not 1 <= args.max_acl_writes <= 128: raise SystemExit("Batch limits are outside the supported bounds.")
    os.umask(0o077)
    if SOURCE.resolve(strict=True) != SOURCE: raise SystemExit("The fixed saved-data root must not contain symlinks.")
    try:
        account = pwd.getpwnam("cbte-admin")
        result = run_batch(SOURCE, STATE, account.pw_uid, set(os.getgrouplist(account.pw_name, account.pw_gid)), NativeAcl(), args.budget_seconds, args.max_entries, args.max_acl_writes)
    except Exception as error:
        result = dict(getattr(error, "repair_progress", {}), state="failed", reason=type(error).__name__, code=getattr(error, "errno", None))
        if isinstance(error, ValueError): result["detail"] = str(error)[:100]
    print(json.dumps(result, sort_keys=True), flush=True)
    raise SystemExit(1 if result["state"] == "failed" else 0)


if __name__ == "__main__": main()
