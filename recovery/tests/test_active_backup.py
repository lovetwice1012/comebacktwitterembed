import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import active_backup as active
import nas_exporter as nas

NAS_RECIPIENT = "age1l8y4rcpcrnmh958848vyjy8vqv8cpscjrdg5hnkns8rj9lq24sasxlgmqf"
OCI_RECIPIENT = "age1tqapt4fs9d0pvhlwf3cg0vv29fu8k9ugqqzpg3qczjvm9t3nqqtqperrzu"
TOKEN = "fixture-private-token-012345678901234567890"


class ActiveBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cbte-active-backup-")
        self.root = Path(self.temp.name)
        self.identifier = "d" * 24
        directory = self.root / "candidates" / self.identifier
        (directory / "data").mkdir(parents=True)
        (directory / "secrets").mkdir()
        self.candidate = {"id": self.identifier, "container": "cbte-dr-" + self.identifier, "directory": str(directory), "epoch": 5, "mysqlImage": "mysql@sha256:" + "b" * 64, "phase": "ACTIVE"}
        self.private(directory / "receipt.json", self.candidate)
        self.private(self.root / "candidate.json", self.candidate)
        self.lease = {"node": "oci", "state": "active", "instanceId": "fixture-instance", "epoch": 5, "validUntilUnixMs": time.time() * 1000 + 60000}
        self.private(self.root / "lease.json", self.lease)
        self.live = {"activeNode": "oci", "epoch": 5, "serverTime": time.time(), "lease": {"node": "oci", "instanceId": "fixture-instance", "expiresAt": time.time() + 90, "valid": True}}
        self.info = {"Config": {"Image": self.candidate["mysqlImage"], "Labels": {"cbte.recovery": "true", "cbte.restore-id": self.identifier}}, "State": {"Running": True}, "HostConfig": {"NetworkMode": "host"}, "Mounts": [{"Source": str(directory / "data"), "Destination": "/var/lib/mysql"}, {"Source": str(directory / "secrets"), "Destination": "/run/cbte-secrets", "RW": False}]}
        self.config = {"candidatePointer": str(self.root / "candidate.json"), "candidateRoot": str(self.root / "candidates"), "leaseFile": str(self.root / "lease.json"), "authorityUrl": "http://127.0.0.1:34210", "authorityToken": TOKEN, "nasUrl": "http://127.0.0.1:33443", "nasToken": TOKEN, "nasRecipient": NAS_RECIPIENT, "spoolRoot": str(self.root / "spool"), "minimumFreeBytes": 0, "maxArtifactBytes": 1048576, "maxSpoolBytes": 8 * 1048576}
        self.dump_calls = []
        archive = self.root / "archive"
        archive.mkdir()
        self.nas = nas.Exporter(nas.Config(token=TOKEN, oci_recipient=OCI_RECIPIENT, archive_root=archive, export_root=self.root / "exports", active_backup_root=self.root / "active-backups", min_free_bytes=0), lambda *args: None)

    def tearDown(self):
        self.temp.cleanup()

    def private(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
        os.chmod(path, 0o600)

    def dump(self, container, recipient, destination, deadline, maximum, minimum_free):
        self.dump_calls.append((container, recipient))
        destination.write_bytes(nas.AGE_HEADER + b"fixture OCI encrypted database" * 20)

    def upload(self, config, receipt, artifact):
        return self.nas.receive_active_backup(receipt["epoch"], receipt["backupId"], receipt["candidateId"], receipt["sha256"], receipt["bytes"], io.BytesIO(artifact.read_bytes()))

    def backup(self, **overrides):
        return active.ActiveBackup(self.config, dump=overrides.get("dump", self.dump), upload=overrides.get("upload", self.upload), authority=lambda *_: copy.deepcopy(self.live), inspect=lambda *_: copy.deepcopy(self.info))

    def test_active_dump_is_cbte_only_encrypted_and_nas_bound_to_epoch(self):
        backup = self.backup()
        result = backup.run_once()
        self.assertIsNotNone(result["created"])
        self.assertFalse(result["failures"])
        self.assertEqual(self.dump_calls, [(self.candidate["container"], NAS_RECIPIENT)])
        manifest = self.nas.latest_active_backup()["backup"]
        self.assertEqual(manifest["epoch"], 5)
        self.assertEqual(manifest["source"], "oci")
        self.assertEqual(manifest["database"], "ComebackTwitterEmbed")
        self.assertFalse(list(Path(self.config["spoolRoot"]).glob("*.sql")))
        commands = active.dump_commands(self.candidate["container"], NAS_RECIPIENT, 60)
        self.assertEqual(commands[0][-2:], ["--databases", "ComebackTwitterEmbed"])
        self.assertNotIn("guacamole_db", commands[0])
        self.assertIn("timeout", commands[0])
        self.assertEqual(commands[2], ["age", "--encrypt", "--recipient", NAS_RECIPIENT])

    def test_standby_never_creates_new_dump(self):
        self.lease["state"] = "standby"
        self.private(Path(self.config["leaseFile"]), self.lease)
        result = self.backup().run_once()
        self.assertIsNone(result["created"])
        self.assertFalse(result["failures"])
        self.assertEqual(self.dump_calls, [])

    def test_pending_ciphertext_upload_survives_lease_loss_without_another_dump(self):
        backup = self.backup()
        created = backup.create()
        self.lease.update(state="stopped", validUntilUnixMs=0)
        self.private(Path(self.config["leaseFile"]), self.lease)
        result = backup.run_once()
        self.assertEqual(result["uploaded"], [created["backupId"]])
        self.assertIsNone(result["created"])
        self.assertEqual(len(self.dump_calls), 1)
        self.assertEqual(self.nas.latest_active_backup()["backup"]["sha256"], created["sha256"])

    def test_wrong_epoch_or_unowned_container_cannot_be_dumped(self):
        self.live["epoch"] = 6
        with self.assertRaises(active.BackupError):
            self.backup().create()
        self.live["epoch"] = 5
        self.info["Config"]["Labels"]["cbte.restore-id"] = "foreign"
        with self.assertRaises(active.BackupError):
            self.backup().create()
        self.assertEqual(self.dump_calls, [])

    def test_dump_failure_discards_only_new_partial_and_is_reported_as_failure(self):
        def failed(container, recipient, path, *args):
            path.write_bytes(nas.AGE_HEADER + b"partial")
            raise active.BackupError("fixture pipeline failed")
        result = self.backup(dump=failed).run_once()
        self.assertTrue(result["failures"])
        self.assertFalse(list(Path(self.config["spoolRoot"]).glob("*.partial")))
        self.assertFalse(list(Path(self.config["spoolRoot"]).glob("*.sql.zst.age")))

    def test_nas_failure_keeps_immutable_pending_artifact(self):
        result = self.backup(upload=lambda *_: (_ for _ in ()).throw(ConnectionError("fixture offline"))).run_once()
        self.assertTrue(result["failures"])
        receipts = list(Path(self.config["spoolRoot"]).glob("*.json"))
        self.assertEqual(len(receipts), 1)
        receipt = json.loads(receipts[0].read_text())
        self.assertEqual(receipt["state"], "PENDING")
        artifact = Path(self.config["spoolRoot"]) / receipt["filename"]
        self.assertEqual(hashlib.sha256(artifact.read_bytes()).hexdigest(), receipt["sha256"])

    def test_uploaded_count_retention_keeps_receipts_and_never_removes_pending_ciphertext(self):
        backup = self.backup()
        payload = nas.AGE_HEADER + b"fixture encrypted retained backup" * 10
        for day in range(1, 6):
            backup_id = f"2026090{day}T173004Z"
            base = f"{backup_id}__oci_5"
            receipt = {"schemaVersion": 1, "state": "UPLOADED" if day < 5 else "PENDING", "source": "oci", "database": "ComebackTwitterEmbed", "epoch": 5, "backupId": backup_id, "candidateId": self.identifier, "filename": base + ".sql.zst.age", "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload), "uploadedAt": time.time()}
            if day < 5:
                receipt["nasManifest"] = {key: receipt[key] for key in ["source", "database", "epoch", "backupId", "candidateId", "sha256", "bytes"]}
            self.private(backup.root / (base + ".json"), receipt)
            (backup.root / receipt["filename"]).write_bytes(payload)
        backup.prune_uploaded()
        old = json.loads((backup.root / "20260901T173004Z__oci_5.json").read_text())
        self.assertEqual(old["state"], "EXPIRED")
        self.assertIn("nasManifest", old)
        self.assertFalse((backup.root / old["filename"]).exists())
        self.assertEqual(len(list(backup.root.glob("*.json"))), 5)
        self.assertEqual(len(list(backup.root.glob("*.sql.zst.age"))), 4, "three uploaded plus one untouched pending")
        pending = backup.pending()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0][1]["backupId"], "20260905T173004Z")
        backup.prune_uploaded()
        self.assertEqual(len(list(backup.root.glob("*.sql.zst.age"))), 4)

    def test_nas_idempotency_conflicts_partial_uploads_and_epoch_order(self):
        payload = nas.AGE_HEADER + b"active encrypted fixture" * 10
        digest = hashlib.sha256(payload).hexdigest()
        first = self.nas.receive_active_backup(5, "20260905T173004Z", self.identifier, digest, len(payload), io.BytesIO(payload))
        again = self.nas.receive_active_backup(5, "20260905T173004Z", self.identifier, digest, len(payload), io.BytesIO(payload))
        self.assertFalse(first["reused"])
        self.assertTrue(again["reused"])
        with self.assertRaises(nas.ExportError) as caught:
            self.nas.receive_active_backup(5, "20260905T173004Z", self.identifier, "e" * 64, len(payload), io.BytesIO(payload))
        self.assertEqual(caught.exception.code, "ACTIVE_BACKUP_CONFLICT")
        with self.assertRaises(nas.ExportError):
            self.nas.receive_active_backup(5, "20260906T173004Z", self.identifier, digest, len(payload), io.BytesIO(payload[:40]))
        self.nas.receive_active_backup(6, "20260904T173004Z", self.identifier, digest, len(payload), io.BytesIO(payload))
        self.assertEqual(self.nas.latest_active_backup()["backup"]["epoch"], 6)
        self.assertEqual(list(self.nas.config.archive_root.iterdir()), [])
        self.assertFalse(list(self.nas.config.active_backup_root.rglob(".incoming-*")))

    def test_real_http_upload_and_receipt_reconciliation_use_existing_tunnel_protocol(self):
        server = nas.server_for(self.nas, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.config["nasUrl"] = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            backup = self.backup(upload=active.upload_ciphertext)
            receipt = backup.create()
            artifact = Path(self.config["spoolRoot"]) / receipt["filename"]
            first = active.upload_ciphertext(self.config, receipt, artifact)
            second = active.upload_ciphertext(self.config, receipt, artifact)
            self.assertTrue(active.receipt_matches(first, receipt))
            self.assertTrue(active.receipt_matches(second, receipt))
            self.assertEqual(self.nas.latest_active_backup()["backup"]["candidateId"], self.identifier)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
