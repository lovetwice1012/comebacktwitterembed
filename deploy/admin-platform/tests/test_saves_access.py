"""Offline ACL planning/checkpoint tests; real libacl uses temporary files only."""
import errno
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import time
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("saves_access", Path(__file__).resolve().parents[1] / "prepare-saves-access.py")
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class AclPlanTests(unittest.TestCase):
    def test_mask_expansion_preserves_every_other_principals_effective_rights(self):
        original = "user::rw-\nuser:2000:rw-\ngroup::rwx\ngroup:3000:rwx\nmask::r--\nother::---\n"
        for default in [False, True]:
            changed = access.repair_acl(original, 1000, 6, 0, 0, {1000}, default)
            before, after = access.parse_acl(original), access.parse_acl(changed)
            for key in [("user", "2000"), ("group", ""), ("group", "3000")]:
                self.assertEqual(before[key] & before[("mask", "")], after[key] & after[("mask", "")])
            self.assertEqual(after[("user", "")], before[("user", "")])
            self.assertEqual(after[("other", "")], before[("other", "")])
            self.assertEqual(after[("user", "1000")] & after[("mask", "")], 6)

    def test_minimal_file_acl_never_gains_execute_and_second_pass_has_no_write(self):
        original = "user::rw-\ngroup::r--\nother::---\n"
        changed = access.repair_acl(original, 1000, 6, 0, 0, {1000})
        result = access.parse_acl(changed)
        self.assertEqual(result[("mask", "")], 6)
        self.assertEqual(result[("user", "1000")], 6)
        self.assertIsNone(access.repair_acl(changed, 1000, 6, 0, 0, {1000}))

    def test_sufficient_group_access_is_not_rewritten_and_owner_mode_is_not_weakened(self):
        original = "user::rwx\ngroup::rwx\nother::---\n"
        self.assertIsNone(access.repair_acl(original, 1000, 7, 0, 1000, {1000}))
        self.assertIsNone(access.repair_acl(original, 1000, 7, 1000, 0, {1000}))
        with self.assertRaisesRegex(ValueError, "admin_owner_mode_insufficient"):
            access.repair_acl("user::r--\ngroup::---\nother::---\n", 1000, 6, 1000, 0, {1000})

    def test_first_default_acl_is_never_created_implicitly(self):
        self.assertIsNone(access.repair_acl("", 1000, 7, 0, 0, {1000}, default=True))
        with self.assertRaises(ValueError): access.parse_acl("user::rwx\nmask:123:rwx\n")


class FakeFiles:
    name = "nt"  # Ownership/mode enforcement itself is tested on native Linux.
    O_DIRECTORY = O_NOFOLLOW = O_NONBLOCK = 0
    def __init__(self):
        self.descriptors, self.serial, self.acls, self.scans = {}, 10000, {}, 0
    def __getattr__(self, key): return getattr(os, key)
    def open(self, filename, flags, dir_fd=None):
        filename = Path(filename)
        if dir_fd is not None: filename = self.descriptors[dir_fd] / filename
        if filename.is_symlink(): raise OSError(errno.ELOOP, "symlink")
        filename.stat()
        self.serial += 1; self.descriptors[self.serial] = filename
        return self.serial
    def close(self, descriptor): self.descriptors.pop(descriptor)
    def dup(self, descriptor): return self.open(self.descriptors[descriptor], 0)
    def fstat(self, descriptor):
        filename = self.descriptors[descriptor]
        value = filename.stat()
        mode = 0o750 if filename.is_dir() else 0o640
        if (filename, False) in self.acls:
            entries = access.parse_acl(self.acls[(filename, False)])
            mode = entries[("user", "")] << 6 | entries.get(("mask", ""), entries[("group", "")]) << 3 | entries[("other", "")]
        return types.SimpleNamespace(st_mode=(stat.S_IFDIR if filename.is_dir() else stat.S_IFREG) | mode, st_uid=0, st_gid=0,
                                     st_dev=value.st_dev, st_ino=value.st_ino, st_ctime_ns=value.st_ctime_ns, st_nlink=value.st_nlink)
    def scandir(self, descriptor):
        self.scans += 1
        return os.scandir(self.descriptors[descriptor])


class FakeAcl:
    def __init__(self, filesystem): self.filesystem, self.reads, self.writes = filesystem, [], []
    def read(self, descriptor, default=False):
        file = self.filesystem.descriptors[descriptor]
        self.reads.append((file, default))
        return self.filesystem.acls.get((file, default), "" if default else "user::rwx\ngroup::r-x\nother::---\n" if file.is_dir() else "user::rw-\ngroup::r--\nother::---\n")
    def write(self, descriptor, text, default=False):
        file = self.filesystem.descriptors[descriptor]
        self.writes.append((file, default))
        self.filesystem.acls[(file, default)] = text


class CheckpointTests(unittest.TestCase):
    def test_small_batches_resume_and_completed_tree_is_not_scanned_on_redeployment(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            root, state = directory / "saves", directory / "state"
            (root / "user" / "tweet").mkdir(parents=True)
            for name in ["data.json", "image.jpg"]: (root / "user" / "tweet" / name).write_text("preserve")
            filesystem = FakeFiles(); acl = FakeAcl(filesystem)
            locking = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
            with mock.patch.object(access, "os", filesystem), mock.patch.object(access, "fcntl", locking, create=True):
                for _ in range(30):
                    result = access.run_batch(root, state, 1000, {1000}, acl, budget=2, max_entries=2, max_writes=1)
                    self.assertLessEqual(result["changed"], 1)
                    if result["state"] == "complete": break
                self.assertEqual(result["state"], "complete")
                self.assertEqual(len(acl.writes), 5)
                self.assertEqual(len(set(acl.writes)), 5)
                self.assertTrue(all(not default for _, default in acl.writes))
                before = (len(acl.reads), len(acl.writes), filesystem.scans)
                self.assertEqual(access.run_batch(root, state, 1000, {1000}, acl)["state"], "complete")
                self.assertEqual((len(acl.reads), len(acl.writes), filesystem.scans), before)
            self.assertEqual((root / "user" / "tweet" / "data.json").read_text(), "preserve")

    def test_private_control_files_are_explicitly_excluded_not_claimed_gid_repaired(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, state = Path(temporary) / "saves", Path(temporary) / "state"
            root.mkdir(); control = root / ".admin-save.lock"; control.write_text("private fixture")
            filesystem = FakeFiles(); acl = FakeAcl(filesystem)
            locking = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
            with mock.patch.object(access, "os", filesystem), mock.patch.object(access, "fcntl", locking, create=True):
                result = access.run_batch(root, state, 1000, {1000}, acl)
            self.assertEqual(result["controlPathsExcluded"], 1)
            self.assertFalse(any(filename == control for filename, _ in acl.writes))
            self.assertEqual(control.read_text(), "private fixture")

    def test_installer_has_no_recursive_acl_dependency_and_job_is_separate(self):
        base = Path(__file__).resolve().parents[1]
        installer = (base / "install-runtime.sh").read_text()
        self.assertNotIn("setfacl -R", installer)
        self.assertNotIn('find "$source_root/saves"', installer)
        unit = (base.parent / "systemd/cbte-admin-saves-acl.service").read_text()
        self.assertIn("Type=oneshot", unit)
        self.assertIn("IOSchedulingClass=idle", unit)
        self.assertIn("TimeoutStartSec=10", unit)
        self.assertNotIn("Requires=cbte-admin", unit)
        self.assertNotIn("[Install]", unit)

    def test_slow_acl_read_does_not_start_a_write_after_the_budget_expired(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, state = Path(temporary) / "saves", Path(temporary) / "state"
            root.mkdir()
            filesystem = FakeFiles(); acl = FakeAcl(filesystem)
            original = acl.read
            def slow(*args): time.sleep(0.08); return original(*args)
            acl.read = slow
            locking = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
            with mock.patch.object(access, "os", filesystem), mock.patch.object(access, "fcntl", locking, create=True):
                result = access.run_batch(root, state, 1000, {1000}, acl, budget=0.05)
            self.assertEqual(result["changed"], 0)
            self.assertEqual(result["state"], "pending")
            self.assertEqual(acl.writes, [])

    def test_root_replacement_does_not_reuse_checkpoint_against_a_different_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            root, state = directory / "saves", directory / "state"
            root.mkdir(); (root / "data.json").write_text("preserve")
            filesystem = FakeFiles(); acl = FakeAcl(filesystem)
            locking = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: None)
            with mock.patch.object(access, "os", filesystem), mock.patch.object(access, "fcntl", locking, create=True):
                access.run_batch(root, state, 1000, {1000}, acl)
                writes = len(acl.writes)
                root.rename(directory / "retained"); root.mkdir()
                with self.assertRaisesRegex(ValueError, "checkpoint_identity_changed"):
                    access.run_batch(root, state, 1000, {1000}, acl)
                self.assertEqual(len(acl.writes), writes)
            self.assertEqual((directory / "retained" / "data.json").read_text(), "preserve")


@unittest.skipUnless(os.name == "posix" and hasattr(os, "getuid") and os.getuid() == 0, "native ACL test needs Linux root on temporary fixture only")
class NativeAclTests(unittest.TestCase):
    def test_native_descriptor_acl_round_trip_and_absent_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "data.json"; file.write_text("fixture"); file.chmod(0o640)
            native = access.NativeAcl()
            descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                changed = access.repair_acl(native.read(descriptor), 12345, 6, 0, 0, {12345})
                native.write(descriptor, changed)
                self.assertIsNone(access.repair_acl(native.read(descriptor), 12345, 6, 0, 0, {12345}))
                self.assertEqual(os.fstat(descriptor).st_mode & 0o111, 0)
            finally: os.close(descriptor)
            descriptor = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY)
            try: self.assertEqual(access.parse_acl(native.read(descriptor, default=True)), {})
            finally: os.close(descriptor)

    def test_native_access_and_default_mask_changes_preserve_other_principals(self):
        with tempfile.TemporaryDirectory() as temporary:
            native = access.NativeAcl()
            for default in [False, True]:
                target = Path(temporary) / ("directory" if default else "data.json")
                if default: target.mkdir()
                else: target.write_text("fixture")
                descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    original = "user::rwx\nuser:22345:rwx\ngroup::rwx\ngroup:32345:rwx\nmask::r--\nother::---\n"
                    native.write(descriptor, original, default)
                    before = access.parse_acl(native.read(descriptor, default))
                    updated = access.repair_acl(native.read(descriptor, default), 12345, 7 if default else 6, 0, 0, {12345}, default)
                    native.write(descriptor, updated, default)
                    after = access.parse_acl(native.read(descriptor, default))
                    for key in [("user", "22345"), ("group", ""), ("group", "32345")]:
                        self.assertEqual(before[key] & before[("mask", "")], after[key] & after[("mask", "")])
                    self.assertIsNone(access.repair_acl(native.read(descriptor, default), 12345, 7 if default else 6, 0, 0, {12345}, default))
                finally: os.close(descriptor)

    def test_native_checkpoint_batches_skip_links_and_controls_and_do_not_rescan_completion(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            root, state, outside = directory / "saves", directory / "state", directory / "outside"
            (root / "user").mkdir(parents=True); outside.mkdir()
            (outside / "keep").write_text("outside fixture")
            (root / "user" / "data.json").write_text("saved fixture")
            (root / "hard1").write_text("hardlink fixture")
            os.link(root / "hard1", root / "hard2")
            (root / "link").symlink_to(outside, target_is_directory=True)
            (root / ".admin-save.lock").write_text("private fixture")
            native = access.NativeAcl()
            with mock.patch.object(native, "read", wraps=native.read) as reads, mock.patch.object(native, "write", wraps=native.write) as writes:
                for _ in range(30):
                    result = access.run_batch(root, state, 12345, {12345}, native, max_entries=4, max_writes=2)
                    self.assertLessEqual(result["changed"], 2)
                    if result["state"] != "pending": break
                self.assertEqual(result["state"], "needs_review")
                self.assertEqual(result["deferredPaths"], 2)
                self.assertEqual(result["controlPathsExcluded"], 1)
                before = (reads.call_count, writes.call_count)
                access.run_batch(root, state, 12345, {12345}, native)
                self.assertEqual((reads.call_count, writes.call_count), before)
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(OSError): access.pin(root_fd, "link/keep")
                with self.assertRaises(ValueError): access.pin(root_fd, "../outside/keep")
            finally: os.close(root_fd)
            self.assertEqual((outside / "keep").read_text(), "outside fixture")
            self.assertEqual((root / ".admin-save.lock").read_text(), "private fixture")

    def test_native_ctime_change_and_expired_budget_prevent_acl_writes(self):
        for mode in ["ctime", "budget"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                root, state = directory / "saves", directory / "state"
                root.mkdir(mode=0o750)
                native = access.NativeAcl()
                read = native.read
                def changed(descriptor, default=False):
                    value = read(descriptor, default)
                    if mode == "ctime": os.fchmod(descriptor, stat.S_IMODE(os.fstat(descriptor).st_mode) ^ 0o010)
                    else: time.sleep(0.08)
                    return value
                with mock.patch.object(native, "read", side_effect=changed), mock.patch.object(native, "write", wraps=native.write) as writes:
                    if mode == "ctime":
                        with self.assertRaisesRegex(ValueError, "inode_changed_during_acl_read"):
                            access.run_batch(root, state, 12345, {12345}, native)
                    else:
                        result = access.run_batch(root, state, 12345, {12345}, native, budget=0.05)
                        self.assertEqual(result["changed"], 0)
                    writes.assert_not_called()


if __name__ == "__main__": unittest.main()
