"""Offline capacity retirement tests; no Docker or network calls are permitted."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

from recovery import standby_retention as retention
from recovery.restore_mysql import atomic_json, read_json


class FakeBackend:
    def __init__(self, fixture):
        self.fixture = fixture
        self.free = 10
        self.calls = []
        self.info = {"Id": "c" * 64, "Name": "/" + fixture.candidate["container"], "Config": {"Image": fixture.config["mysqlImage"], "Labels": {"cbte.recovery": "true", "cbte.restore-id": fixture.identifier}}, "HostConfig": {"NetworkMode": "none", "RestartPolicy": {"Name": "no"}}, "State": {"Running": True}, "Mounts": [{"Type": "bind", "Source": str(fixture.directory / "data"), "Destination": "/var/lib/mysql", "RW": True}, {"Type": "bind", "Source": str(fixture.directory / "secrets"), "Destination": "/run/cbte-secrets", "RW": False}]}
        self.interrupt_remove = False
        self.interrupt_data = False
        self.require_pointer_cleared = True

    def free_bytes(self, directory):
        return self.free

    def allocated_bytes(self, directory):
        return 100

    def inspect(self, container):
        self.calls.append(("inspect", container))
        return copy.deepcopy(self.info)

    def stop(self, identifier):
        if self.require_pointer_cleared:
            self.fixture.assertIsNone(read_json(self.fixture.state / "prepared-candidate.json"))
            self.fixture.assertIsNone(self.fixture.current["candidate"])
            self.fixture.assertEqual(self.fixture.current["phase"], "NO_VALIDATED_STANDBY")
        self.calls.append(("stop", identifier))
        self.info["State"]["Running"] = False

    def remove(self, identifier):
        self.calls.append(("remove", identifier))
        self.info = None
        if self.interrupt_remove:
            self.interrupt_remove = False
            raise RuntimeError("simulated interruption after Docker removed the container")

    def remove_data(self, directory):
        self.calls.append(("remove_data", directory))
        if self.interrupt_data:
            self.interrupt_data = False
            (directory / "one.ibd").unlink()
            raise RuntimeError("simulated interruption during data-directory removal")
        shutil.rmtree(directory)
        self.free += 100


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cbte-standby-retirement-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.candidate_root = self.root / "candidates"
        self.identifier = "a" * 24
        self.directory = self.candidate_root / self.identifier
        (self.directory / "data").mkdir(parents=True)
        (self.directory / "secrets").mkdir()
        (self.directory / "data/one.ibd").write_bytes(b"existing database one")
        (self.directory / "data/two.ibd").write_bytes(b"existing database two")
        (self.directory / "secrets/root-password").write_text("private fixture")
        self.recipient = "age1-fixture"
        self.old_manifest, self.old_cipher = self.cipher("d" * 64, b"old")
        self.new_manifest, self.new_cipher = self.cipher("e" * 64, b"new")
        self.config = {"stateDir": str(self.state), "candidateRoot": str(self.candidate_root), "mysqlImage": "mysql@sha256:" + "f" * 64, "ociRecipient": self.recipient, "restoreCapacityBytes": 100, "minimumFreeBytes": 5, "standbyReplacement": "single"}
        self.candidate = {"id": self.identifier, "directory": str(self.directory), "container": "cbte-dr-" + self.identifier, "mysqlImage": self.config["mysqlImage"], "phase": "VALIDATED", "manifest": self.old_manifest, "checks": {"network": "none", "importCompleted": True}}
        atomic_json(self.directory / "receipt.json", self.candidate)
        atomic_json(self.state / "prepared-candidate.json", self.candidate)
        self.current = {"candidate": self.candidate, "backup": self.old_manifest["source"], "pendingBackup": self.new_manifest["source"]}
        self.backend = FakeBackend(self)
        self.authority = mock.Mock(return_value={"ok": True, "activeNode": "primary", "epoch": 3})
        self.network = mock.patch("socket.create_connection", side_effect=AssertionError("Offline tests may not open network connections"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def cipher(self, export_id, body):
        artifact = self.state / "ciphertexts" / (export_id + ".sql.zst.age")
        artifact.parent.mkdir(parents=True, exist_ok=True)
        payload = b"age-encryption.org/v1\n" + body * 50
        artifact.write_bytes(payload)
        return {"exportId": export_id, "source": {"backupId": "fixture-" + body.decode(), "sourceSha256": hashlib.sha256(body).hexdigest(), "sourceTimestamp": "2026-09-06T00:00:00Z"}, "export": {"sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload), "ociRecipient": self.recipient}}, artifact

    def ensure(self):
        return retention.ensure_capacity(self.config, self.new_cipher, self.new_manifest, self.current.get("candidate"), self.authority, lambda **values: self.current.update(values), self.backend)

    def assert_preserved(self):
        self.assertTrue((self.directory / "data/one.ibd").exists())
        self.assertFalse(any(call[0] in {"stop", "remove", "remove_data"} for call in self.backend.calls))

    def test_default_disabled_reports_required_and_free_without_retiring(self):
        self.config.pop("standbyReplacement")
        with self.assertRaisesRegex(retention.CapacityError, "STANDBY_REPLACEMENT_DISABLED.*105.*10"):
            self.ensure()
        self.assert_preserved()
        self.authority.assert_not_called()

    def test_sufficient_capacity_preserves_standby_without_authority_side_effects(self):
        self.backend.free = 200
        self.assertFalse(self.ensure()["retired"])
        self.assert_preserved()
        self.authority.assert_not_called()

    def test_new_ciphertext_must_verify_before_any_retirement(self):
        self.new_cipher.write_bytes(b"invalid")
        with self.assertRaises(ValueError):
            self.ensure()
        self.assert_preserved()
        self.authority.assert_not_called()

    def test_insufficient_projected_capacity_keeps_existing_standby(self):
        self.config["restoreCapacityBytes"] = 200
        with self.assertRaisesRegex(retention.CapacityError, "RETIREMENT_INSUFFICIENT_SPACE"):
            self.ensure()
        self.assert_preserved()

    def test_active_pointer_epoch_or_nonprimary_authority_forbids_retirement(self):
        for scenario in ("pointer", "epoch", "authority"):
            with self.subTest(scenario=scenario):
                if scenario == "pointer": atomic_json(self.state / "active-candidate.json", self.candidate | {"epoch": 3})
                if scenario == "epoch": self.current["candidate"] = self.candidate | {"epoch": 3}
                if scenario == "authority": self.authority.return_value["activeNode"] = "oci"
                with self.assertRaises(retention.CapacityError): self.ensure()
                self.assert_preserved()
                atomic_json(self.state / "active-candidate.json", None)
                self.current["candidate"] = self.candidate

    def test_unknown_or_host_network_container_is_never_touched(self):
        original = copy.deepcopy(self.backend.info)
        for scenario in ("missing", "label", "image", "mount", "network", "activation_label"):
            with self.subTest(scenario=scenario):
                self.backend.info = copy.deepcopy(original)
                if scenario == "missing": self.backend.info = None
                if scenario == "label": self.backend.info["Config"]["Labels"]["cbte.restore-id"] = "foreign"
                if scenario == "image": self.backend.info["Config"]["Image"] = "mysql:untrusted"
                if scenario == "mount": self.backend.info["Mounts"][0]["Source"] = str(self.root / "foreign-data")
                if scenario == "network": self.backend.info["HostConfig"]["NetworkMode"] = "host"
                if scenario == "activation_label": self.backend.info["Config"]["Labels"]["cbte.activation-epoch"] = "2"
                with self.assertRaises(retention.CapacityError): self.ensure()
                self.assert_preserved()

    def test_retirement_keeps_ciphertexts_secrets_and_original_receipt(self):
        self.assertTrue(self.ensure()["retired"])
        self.assertFalse((self.directory / "data").exists())
        self.assertTrue((self.directory / "secrets/root-password").exists())
        self.assertTrue(self.old_cipher.exists())
        self.assertTrue(self.new_cipher.exists())
        journal = read_json(self.state / "retirements" / (self.identifier + ".json"))
        self.assertEqual(journal["step"], "RETIRED")
        self.assertEqual(journal["originalReceipt"], self.candidate)
        self.assertEqual(read_json(self.directory / "receipt.json")["phase"], "RETIRED")
        self.assertEqual(self.current["pendingBackup"], self.new_manifest["source"])

    def test_interruption_after_container_removal_reconciles_absence(self):
        self.backend.interrupt_remove = True
        with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
            self.ensure()
        journal = self.state / "retirements" / (self.identifier + ".json")
        self.assertEqual(read_json(journal)["step"], "REMOVING")
        self.ensure()
        self.assertEqual(read_json(journal)["step"], "RETIRED")
        self.assertEqual(sum(call[0] == "remove" for call in self.backend.calls), 1)

    def test_interrupted_data_removal_resumes_only_same_proven_namespace(self):
        self.backend.interrupt_data = True
        with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
            self.ensure()
        self.assertTrue((self.directory / "data/two.ibd").exists())
        self.ensure()
        self.assertFalse((self.directory / "data").exists())
        self.assertTrue(self.old_cipher.exists())

    def test_ownership_change_while_retirement_pending_blocks_reconciliation(self):
        self.backend.interrupt_remove = True
        with self.assertRaises(RuntimeError): self.ensure()
        self.authority.return_value["activeNode"] = "oci"
        with self.assertRaisesRegex(retention.CapacityError, "PRIMARY_OWNERSHIP_UNCONFIRMED"):
            self.ensure()
        self.assertTrue((self.directory / "data").exists())

    def test_missing_old_ciphertext_preserves_the_only_restored_copy(self):
        self.old_cipher.unlink()
        with self.assertRaises(FileNotFoundError): self.ensure()
        self.assert_preserved()

    def test_replacement_mode_change_pauses_interrupted_retirement(self):
        self.backend.interrupt_remove = True
        with self.assertRaises(RuntimeError): self.ensure()
        self.config.pop("standbyReplacement")
        with self.assertRaisesRegex(retention.CapacityError, "RETIREMENT_PAUSED"):
            self.ensure()
        self.assertTrue((self.directory / "data").exists())

    def test_interrupted_import_is_quarantined_only_after_verified_container_stop(self):
        interrupted = self.candidate | {"phase": "IMPORTING"}
        atomic_json(self.directory / "receipt.json", interrupted)
        self.backend.require_pointer_cleared = False
        result = retention.quarantine_interrupted_candidate(self.config, {"id": self.identifier}, self.authority, self.backend)
        self.assertEqual(result["phase"], "QUARANTINED")
        self.assertEqual(result["id"], self.identifier)
        self.assertEqual(result["manifest"], interrupted["manifest"])
        self.assertIs(self.backend.info["State"]["Running"], False)
        self.assertTrue((self.directory / "data").exists())
        self.assertFalse(any(call[0] in {"remove", "remove_data"} for call in self.backend.calls))
        self.current["candidate"] = result
        self.backend.require_pointer_cleared = True
        self.assertTrue(self.ensure()["retired"])

    def test_interrupted_import_unknown_container_is_not_marked_quarantined(self):
        interrupted = self.candidate | {"phase": "IMPORTING"}
        atomic_json(self.directory / "receipt.json", interrupted)
        self.backend.info["HostConfig"]["NetworkMode"] = "host"
        with self.assertRaisesRegex(retention.CapacityError, "UNOWNED_OR_ACTIVE_CONTAINER"):
            retention.quarantine_interrupted_candidate(self.config, {"id": self.identifier}, self.authority, self.backend)
        self.assertEqual(read_json(self.directory / "receipt.json")["phase"], "IMPORTING")
        self.assert_preserved()

    def test_pending_quarantine_retries_before_future_import_capacity_check(self):
        atomic_json(self.directory / "receipt.json", self.candidate | {"phase": "IMPORTING"})
        self.current["candidate"] = {"id": self.identifier}
        self.backend.require_pointer_cleared = False
        self.backend.free = 200
        self.ensure()
        self.assertEqual(self.current["candidate"]["phase"], "QUARANTINED")
        self.assertIs(self.backend.info["State"]["Running"], False)


if __name__ == "__main__":
    unittest.main()
