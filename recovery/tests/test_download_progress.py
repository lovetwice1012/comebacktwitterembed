"""Download completion is evidenced by the same ciphertext/restore generation."""
import copy
import io
from pathlib import Path
from unittest import mock

from recovery import controller, restore_mysql
from recovery.tests.test_controller_restore import RecoveryFixture


class DownloadProgressTests(RecoveryFixture):
    def ready_state(self, **changes):
        candidate = copy.deepcopy(self.candidate)
        candidate.update(directory=str(Path(self.config["candidateRoot"]) / candidate["id"]), mysqlImage=self.config["mysqlImage"], validatedAt=self.now - 120)
        candidate["checks"].update(ciphertextVerified=True, importCompleted=True)
        restore_mysql.atomic_json(Path(candidate["directory"]) / "receipt.json", candidate)
        state = {"phase": "STANDBY_READY", "candidate": candidate, "backup": self.source, "pendingBackup": None,
                 "download": {"receivedBytes": 50, "expectedBytes": self.manifest["export"]["bytes"]}}
        state.update(changes)
        restore_mysql.atomic_json(Path(self.config["stateDir"]) / "state.json", state)
        return candidate

    def test_partial_progress_is_completed_after_real_cache_checksum_check(self):
        c = controller.Controller(self.config)
        cached = c.cache / (self.export_id + ".sql.zst.age")
        cached.write_bytes(self.artifact.read_bytes())
        c.update(download={"receivedBytes": 50, "expectedBytes": self.manifest["export"]["bytes"]})
        with mock.patch.object(controller.urllib.request, "build_opener") as network:
            c.download(self.export_id, self.manifest)
        network.assert_not_called()
        progress = c.state["download"]
        self.assertEqual(progress["receivedBytes"], self.artifact.stat().st_size)
        self.assertEqual(progress["expectedBytes"], progress["receivedBytes"])
        self.assertEqual(progress["state"], "verified")
        self.assertEqual(progress["verificationSource"], "cache_checksum_verified")
        self.assertFalse(progress["transferredNow"])

    def test_successful_network_download_always_persists_final_verified_meter(self):
        c = controller.Controller(self.config)
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(self.artifact.read_bytes())
        with mock.patch.object(controller.urllib.request, "build_opener", return_value=opener):
            c.download(self.export_id, self.manifest)
        progress = restore_mysql.read_json(c.state_path)["download"]
        self.assertEqual(progress["state"], "verified")
        self.assertEqual(progress["receivedBytes"], self.manifest["export"]["bytes"])
        self.assertEqual(progress["verificationSource"], "download_checksum_verified")
        self.assertTrue(progress["checksumVerified"])

    def test_legacy_standby_progress_uses_original_receipt_time_without_claiming_new_check(self):
        candidate = self.ready_state()
        with mock.patch.object(controller, "verify_artifact", side_effect=AssertionError("No live checksum was requested")):
            c = controller.Controller(self.config)
        progress = c.state["download"]
        self.assertEqual(progress["state"], "verified")
        self.assertEqual(progress["receivedBytes"], self.manifest["export"]["bytes"])
        self.assertEqual(progress["backupId"], self.source["backupId"])
        self.assertEqual(progress["verificationSource"], "validated_restore_receipt")
        self.assertEqual(progress["verifiedAt"], self.iso(candidate["validatedAt"]))
        self.assertFalse(progress["transferredNow"])
        self.assertIn("normalizedAt", progress)

    def test_missing_or_unverified_receipt_cannot_turn_unknown_progress_into_success(self):
        candidate = self.ready_state(download={"receivedBytes": 0, "expectedBytes": None})
        receipt_path = Path(candidate["directory"]) / "receipt.json"
        receipt_path.unlink()
        c = controller.Controller(self.config)
        self.assertNotEqual(c.state["download"].get("state"), "verified")
        candidate["checks"]["importCompleted"] = False
        restore_mysql.atomic_json(receipt_path, candidate)
        self.assertFalse(c.normalize_validated_download())
        self.assertEqual(c.state["download"]["receivedBytes"], 0)

    def test_new_failed_generation_keeps_its_partial_meter_beside_old_standby(self):
        self.ready_state()
        c = controller.Controller(self.config)
        newest = dict(self.source, backupId="20260906T173004Z", sourceSha256="e" * 64)
        manifest = copy.deepcopy(self.manifest)
        manifest.update(exportId="f" * 64, source=newest)
        c.update(pendingBackup=newest)
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(self.artifact.read_bytes()[:-3])
        with mock.patch.object(controller.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(ValueError): c.download(manifest["exportId"], manifest)
        c.update(phase="STANDBY_READY")
        failed = copy.deepcopy(c.state["download"])
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(failed["backupId"], newest["backupId"])
        self.assertFalse(failed["checksumVerified"])
        self.assertFalse(c.normalize_validated_download())
        self.assertEqual(controller.Controller(self.config).state["download"], failed)

    def test_explicit_different_download_identity_is_not_rewritten_as_old_standby(self):
        progress = {"exportId": "f" * 64, "backupId": "20260906T173004Z", "receivedBytes": 50, "expectedBytes": 100, "state": "failed"}
        self.ready_state(download=progress)
        self.assertEqual(controller.Controller(self.config).state["download"], progress)
