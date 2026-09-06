import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from recovery import cipher_retention as retention


class CipherRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.candidates = self.root / "candidates"
        self.cache = self.state / "ciphertexts"
        self.cache.mkdir(parents=True, mode=0o700)
        self.candidates.mkdir(mode=0o700)
        self.config = {"stateDir": str(self.state), "candidateRoot": str(self.candidates), "ociRecipient": "age1-fixture-recipient", "mysqlImage": "mysql@sha256:" + "b" * 64}
        self.receipts = {}
        for day in [1, 2, 3]:
            self.make_candidate(day, "RETIRED")
        self.current = self.make_candidate(5, "VALIDATED")
        self.private(self.state / "state.json", {"phase": "STANDBY_READY", "candidate": self.current})
        self.private(self.state / "prepared-candidate.json", self.current)

    def private(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_text(json.dumps(value), encoding="utf-8")
        path.chmod(0o600)

    def make_candidate(self, day, phase, manifest=None):
        identifier = f"{day:024x}"
        directory = self.candidates / identifier
        directory.mkdir(mode=0o700)
        if manifest is None:
            backup_id = f"202609{day:02}T020000Z"
            source_hash = hashlib.sha256(str(day).encode()).hexdigest()
            export_id = hashlib.sha256(("v1\0" + backup_id + "\0" + source_hash + "\0" + self.config["ociRecipient"]).encode()).hexdigest()
            payload = retention.AGE_HEADER + ("fixture ciphertext " + str(day)).encode() * 50
            artifact = self.cache / (export_id + ".sql.zst.age")
            artifact.write_bytes(payload)
            artifact.chmod(0o600)
            manifest = {"schemaVersion": 1, "scope": "host-mysql", "backupId": backup_id, "exportId": export_id,
                "source": {"backupId": backup_id, "sourceSha256": source_hash, "sourceTimestamp": f"2026-09-{day:02}T02:00:00Z"},
                "export": {"filename": "rewrapped.sql.zst.age", "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload), "ociRecipient": self.config["ociRecipient"], "recipientFingerprint": hashlib.sha256(self.config["ociRecipient"].encode()).hexdigest(), "compression": "zstd", "encryption": "age"}}
        original = {"id": identifier, "directory": str(directory), "container": "cbte-dr-" + identifier, "mysqlImage": self.config["mysqlImage"], "phase": "VALIDATED" if phase == "RETIRED" else phase, "manifest": manifest,
                    "checks": {"ciphertextVerified": True, "importCompleted": True, "network": "none"}}
        receipt = dict(original)
        if phase == "RETIRED":
            journal_path = self.state / "retirements" / (identifier + ".json")
            self.private(journal_path, {"version": 1, "step": "RETIRED", "candidateId": identifier, "originalReceipt": original,
                "originalCiphertext": str(self.cache / (manifest["exportId"] + ".sql.zst.age"))})
            receipt.update(phase="RETIRED", retirementJournal=str(journal_path))
        self.private(directory / "receipt.json", receipt)
        self.receipts[day] = receipt
        return receipt

    def artifact(self, day):
        return self.cache / (self.receipts[day]["manifest"]["exportId"] + ".sql.zst.age")

    def prune(self):
        return retention.prune_validated_cache(self.config, self.current["id"])

    def test_retired_cache_is_bounded_after_validation_and_all_metadata_remains(self):
        metadata = {p: p.read_bytes() for p in self.candidates.rglob("receipt.json")}
        metadata.update({p: p.read_bytes() for p in (self.state / "retirements").glob("*.json")})
        result = self.prune()
        self.assertEqual(result["keepRetiredRollbackGenerations"], 1)
        self.assertEqual(set(result["removedExportIds"]), {self.receipts[day]["manifest"]["exportId"] for day in [1, 2]})
        self.assertFalse(self.artifact(1).exists())
        self.assertFalse(self.artifact(2).exists())
        self.assertTrue(self.artifact(3).exists(), "latest retired rollback generation must remain")
        self.assertTrue(self.artifact(5).exists(), "validated current generation must remain")
        self.assertEqual(metadata, {p: p.read_bytes() for p in metadata})
        self.assertEqual(self.prune()["removedExportIds"], [])

    def test_importing_active_unknown_and_unreferenced_ciphertexts_are_protected(self):
        pending = self.make_candidate(4, "IMPORTING")
        active = self.make_candidate(6, "ACTIVE")
        unknown = self.make_candidate(7, "UNCLASSIFIED")
        foreign = self.cache / ("f" * 64 + ".sql.zst.age")
        foreign.write_bytes(b"unknown cache artifact")
        partial = self.cache / "new-generation.partial"
        partial.write_bytes(b"unfinished download")
        self.prune()
        for day in [4, 5, 6, 7]:
            self.assertTrue(self.artifact(day).exists())
        self.assertEqual(foreign.read_bytes(), b"unknown cache artifact")
        self.assertEqual(partial.read_bytes(), b"unfinished download")
        self.assertEqual(pending["phase"], "IMPORTING")
        self.assertEqual(active["phase"], "ACTIVE")
        self.assertEqual(unknown["phase"], "UNCLASSIFIED")

    def test_pending_reference_to_an_old_retired_export_prevents_its_deletion(self):
        self.make_candidate(4, "IMPORTING", self.receipts[1]["manifest"])
        result = self.prune()
        self.assertTrue(self.artifact(1).exists())
        self.assertIn(self.receipts[1]["manifest"]["exportId"], result["protectedExportIds"])

    def test_zero_retired_retention_preserves_current_pending_unknown_and_all_receipts(self):
        self.config["keepRetiredCiphertexts"] = 0
        self.make_candidate(4, "IMPORTING", self.receipts[1]["manifest"])
        self.make_candidate(6, "UNCLASSIFIED")
        unknown = self.cache / ("f" * 64 + ".sql.zst.age")
        unknown.write_bytes(b"unknown artifact")
        metadata = {path: path.read_bytes() for path in self.candidates.rglob("receipt.json")}
        result = self.prune()
        self.assertEqual(result["keepRetiredRollbackGenerations"], 0)
        self.assertEqual(set(result["removedExportIds"]), {self.receipts[day]["manifest"]["exportId"] for day in [2, 3]})
        self.assertTrue(self.artifact(1).exists(), "pending imports protect a shared retired ciphertext")
        self.assertTrue(self.artifact(5).exists(), "current validated ciphertext stays available")
        self.assertTrue(self.artifact(6).exists(), "unknown candidate state is protected")
        self.assertTrue(unknown.exists())
        self.assertEqual(metadata, {path: path.read_bytes() for path in metadata})

    def test_retired_retention_accepts_three_and_rejects_invalid_counts(self):
        self.config["keepRetiredCiphertexts"] = 3
        self.assertEqual(self.prune()["removedExportIds"], [])
        for value in [-1, 4, True, 0.0, "0", None]:
            self.config["keepRetiredCiphertexts"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "keepRetiredCiphertexts"):
                self.prune()
        self.assertTrue(all(self.artifact(day).exists() for day in [1, 2, 3, 5]))

    def test_no_cleanup_before_validation_or_when_active_pointer_exists(self):
        for mutation in ["importing", "active", "bad_current_checksum"]:
            with self.subTest(mutation=mutation):
                self.private(self.state / "state.json", {"phase": "RESTORING_ISOLATED" if mutation == "importing" else "STANDBY_READY", "candidate": self.current})
                if mutation == "active":
                    self.private(self.state / "active-candidate.json", self.current | {"epoch": 1})
                if mutation == "bad_current_checksum":
                    (self.state / "active-candidate.json").unlink(missing_ok=True)
                    self.artifact(5).write_bytes(b"changed")
                with self.assertRaises(ValueError):
                    self.prune()
                self.assertTrue(all(self.artifact(day).exists() for day in [1, 2, 3]))

    def test_checksum_and_retirement_identity_are_required(self):
        self.artifact(2).write_bytes(retention.AGE_HEADER + b"unverified replacement")
        with self.assertRaises(ValueError):
            self.prune()
        self.assertTrue(self.artifact(2).exists())
        self.assertTrue(self.artifact(1).exists())

    def test_unknown_or_activated_retirement_receipt_stays_protected(self):
        receipt = self.receipts[2] | {"epoch": 9}
        self.private(self.candidates / receipt["id"] / "receipt.json", receipt)
        result = self.prune()
        self.assertTrue(self.artifact(2).exists())
        self.assertIn(receipt["manifest"]["exportId"], result["protectedExportIds"])

    def test_crash_after_unlink_keeps_receipt_and_resumes_retirement_journal(self):
        original = retention.atomic_json
        failed = False
        def interrupt(path, value):
            nonlocal failed
            if path.parent.name == "cipher-retirements" and value.get("state") == "REMOVED" and not failed:
                failed = True
                raise OSError("fixture crash after unlink")
            return original(path, value)
        with mock.patch.object(retention, "atomic_json", side_effect=interrupt):
            with self.assertRaises(OSError):
                self.prune()
        path = self.state / "cipher-retirements" / (self.receipts[2]["manifest"]["exportId"] + ".json")
        self.assertEqual(json.loads(path.read_text())["state"], "REMOVING")
        self.assertTrue((self.candidates / self.receipts[2]["id"] / "receipt.json").exists())
        self.prune()
        self.assertEqual(json.loads(path.read_text())["state"], "REMOVED")

    def test_pending_pointer_change_blocks_deletion_at_boundary(self):
        original = retention.verified_cipher
        def changing(path, export, deadline):
            identity = original(path, export, deadline)
            if path == self.artifact(2):
                self.private(self.state / "prepared-candidate.json", self.receipts[3])
            return identity
        with mock.patch.object(retention, "verified_cipher", side_effect=changing):
            with self.assertRaisesRegex(ValueError, "pointers changed"):
                self.prune()
        self.assertTrue(self.artifact(2).exists())


if __name__ == "__main__":
    unittest.main()
