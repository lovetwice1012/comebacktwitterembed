"""Offline controller/restore regression tests; Docker/NAS/authority are mocked."""
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from recovery import controller, restore_mysql


class RecoveryFixture(unittest.TestCase):
    def setUp(self):
        self.network_guard = mock.patch("socket.create_connection", side_effect=AssertionError("Offline recovery tests must not open network connections"))
        self.network_guard.start()
        self.addCleanup(self.network_guard.stop)
        self.temporary = tempfile.TemporaryDirectory(prefix="cbte-recovery-offline-test-")
        self.root = Path(self.temporary.name)
        self.now = 1800000000.0
        self.recipient = "age1-fixture-recipient-never-use-production"
        self.workload = self.root / "workload.json"
        self.workload.write_text("{}", encoding="utf-8")
        self.config = {"stateDir": str(self.root / "controller"), "candidateRoot": str(self.root / "candidates"), "exporterUrl": "http://127.0.0.1:34211", "exporterToken": "exporter-fixture-token-123456789012345", "authorityUrl": "http://127.0.0.1:34210", "authorityControllerToken": "controller-fixture-token-1234567890", "ociRecipient": self.recipient, "workloadConfig": str(self.workload), "mysqlImage": "mysql@sha256:" + "a" * 64, "ageIdentity": str(self.root / "fixture-identity"), "minimumFreeBytes": 0, "maxBackupAgeSeconds": 129600, "autoPrepare": False, "allowMissingSavedata": True, "runtimeReady": True, "routingReady": True}
        self.config["restoreCapacityBytes"] = 0  # Fixture import does not allocate a database.
        self.artifact = self.root / "encrypted.sql.zst.age"
        payload = b"age-encryption.org/v1\n" + b"encrypted-test-payload-not-real-crypto" * 4
        self.artifact.write_bytes(payload)
        self.export_hash = hashlib.sha256(payload).hexdigest()
        self.source = {"backupId": "20260905T173004Z", "scope": "host-mysql", "sourceTimestamp": self.iso(self.now - 3600), "sourceFilename": "fixture-source.sql.zst.age", "sourceSha256": "b" * 64, "sourceBytes": 999, "verifiedAt": self.iso(self.now - 3500)}
        self.export_id = hashlib.sha256(("v1\0" + self.source["backupId"] + "\0" + self.source["sourceSha256"] + "\0" + self.recipient).encode()).hexdigest()
        self.manifest = {"schemaVersion": 1, "exportId": self.export_id, "backupId": self.source["backupId"], "scope": "host-mysql", "source": self.source, "export": {"filename": "rewrapped.sql.zst.age", "sha256": self.export_hash, "bytes": len(payload), "ociRecipient": self.recipient, "recipientFingerprint": hashlib.sha256(self.recipient.encode()).hexdigest(), "compression": "zstd", "encryption": "age"}, "completedAt": self.iso(self.now - 3400)}
        self.candidate = {"id": "d" * 24, "phase": "VALIDATED", "container": "cbte-dr-" + "d" * 24, "manifest": self.manifest, "checks": {"network": "none", "savedataMigrated": False}}

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def iso(timestamp):
        return dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat().replace("+00:00", "Z")

    def authority_state(self, **changes):
        state = {"primaryEnrolled": True, "armed": True, "activeNode": "primary", "epoch": 1, "lease": {"valid": False, "expiresAt": self.now - 300}, "drainUntil": self.now - 240, "quarantineUntil": self.now - 500}
        state.update(changes)
        return state

    @staticmethod
    def fake_mysql(container, sql, timeout=30):
        if sql == "SELECT 1;": return "1\n"
        if "information_schema.TABLES" in sql: return "guilds\nusers\nguild_provider_settings\nauto_extract_targets\n"
        if sql == "SELECT VERSION();": return "8.0.42\n"
        if "event_scheduler" in sql: return "OFF\n"
        if "COUNT(*)" in sql: return "2\n"
        if "SET GLOBAL" in sql: return ""
        raise AssertionError("Unexpected test SQL shape")


class ControllerGateTests(RecoveryFixture):
    def gates(self, authority=None, source=None, config=None):
        with mock.patch.object(controller.time, "time", return_value=self.now):
            intent = {"desiredState": "running", "revision": 1, "fetchedAt": self.iso(self.now), "observationState": "fresh"}
            values = controller.promotion_gates(authority or self.authority_state(), source or self.source, self.candidate, config or self.config, intent, intent)
        return {item["code"]: item["ready"] for item in values}

    def test_valid_candidate_still_cannot_promote_unenrolled_primary(self):
        gates = self.gates(self.authority_state(primaryEnrolled=False))
        self.assertFalse(gates["PRIMARY_ENROLLED"])
        c = controller.Controller(self.config)
        c.update(backup=self.source, candidate=self.candidate, phase="STANDBY_READY")
        with mock.patch.object(c, "authority", return_value=self.authority_state(primaryEnrolled=False)), mock.patch.object(c, "activate") as activate, mock.patch.object(controller.time, "time", return_value=self.now):
            c.tick()
        activate.assert_not_called()
        self.assertFalse(next(gate for gate in c.state["gates"] if gate["code"] == "PRIMARY_ENROLLED")["ready"])

    def test_backup_age_future_timestamp_and_accepted_savedata_constraint(self):
        self.assertTrue(all(self.gates().values()))
        self.assertFalse(self.gates(source=dict(self.source, sourceTimestamp=self.iso(self.now - 129601)))["BACKUP_FRESH"])
        self.assertFalse(self.gates(source=dict(self.source, sourceTimestamp=self.iso(self.now + 301)))["BACKUP_FRESH"])
        self.assertFalse(self.gates(config=dict(self.config, allowMissingSavedata=False))["SAVEDATA_CONSTRAINT"])
        self.assertFalse(self.gates(source=dict(self.source, sourceTimestamp="2026-09-06T00:00:00"))["BACKUP_FRESH"])

    def test_backup_metadata_cannot_make_a_different_candidate_fresh(self):
        for key, value in [("backupId", "20260906T173004Z"), ("sourceSha256", "e" * 64), ("sourceTimestamp", self.iso(self.now - 30))]:
            with self.subTest(key=key):
                gates = self.gates(source=dict(self.source, **{key: value}))
                self.assertFalse(gates["BACKUP_SOURCE_MATCH"])
                self.assertFalse(gates["BACKUP_FRESH"])

    def test_failed_refresh_keeps_old_source_stale_and_retries_export(self):
        stale = dict(self.source, sourceTimestamp=self.iso(self.now - 200000), sourceSha256="f" * 64)
        old = dict(self.candidate, manifest=dict(self.manifest, source=stale))
        c = controller.Controller(dict(self.config, autoPrepare=True))
        c.update(backup=stale, candidate=old, phase="STANDBY_READY")
        def exporter(path, body=None):
            if path == "/v1/backups/latest": return {"backup": self.source}
            raise OSError("NAS export temporarily unavailable")
        with mock.patch.object(c, "authority", return_value=self.authority_state()), mock.patch.object(c, "exporter", side_effect=exporter) as exported, mock.patch.object(c, "activate") as activate, mock.patch.object(controller.time, "time", return_value=self.now):
            c.tick()
            self.assertEqual(c.state["backup"], stale)
            self.assertEqual(c.state["pendingBackup"], self.source)
            self.assertEqual(c.state["candidate"], old)
            self.assertFalse(next(gate for gate in c.state["gates"] if gate["code"] == "BACKUP_FRESH")["ready"])
            c.update(nextPrepareAt=0)
            c.tick()
        activate.assert_not_called()
        self.assertEqual([call.args[0] for call in exported.call_args_list].count("/v1/exports"), 2)

    def test_failed_refresh_does_not_reuse_legacy_misbound_state(self):
        old_source = dict(self.source, sourceSha256="f" * 64)
        old = dict(self.candidate, manifest=dict(self.manifest, source=old_source))
        c = controller.Controller(self.config)
        # A persisted state from an earlier version may already contain the
        # newest source alongside an older validated candidate.
        c.update(backup=self.source, candidate=old, phase="STANDBY_READY")
        with mock.patch.object(c, "exporter", side_effect=[{"backup": self.source}, OSError("export failed")]) as exporter, mock.patch.object(controller.time, "time", return_value=self.now):
            with self.assertRaises(OSError): c.prepare_latest()
        self.assertEqual(exporter.call_count, 2)
        with mock.patch.object(controller.time, "time", return_value=self.now):
            gates = controller.promotion_gates(self.authority_state(), c.state["backup"], c.state["candidate"], self.config)
        self.assertFalse(next(gate for gate in gates if gate["code"] == "BACKUP_SOURCE_MATCH")["ready"])

    def test_expiry_drain_quarantine_and_runtime_are_independent_gates(self):
        self.assertFalse(self.gates(self.authority_state(lease={"valid":False,"expiresAt":self.now+1}))["OLD_LEASE_EXPIRED"])
        self.assertFalse(self.gates(self.authority_state(lease={"valid":True,"expiresAt":self.now-1}))["OLD_LEASE_EXPIRED"])
        self.assertFalse(self.gates(self.authority_state(drainUntil=self.now+1))["LEASE_DRAIN_COMPLETE"])
        self.assertFalse(self.gates(self.authority_state(quarantineUntil=self.now+1))["LEASE_DRAIN_COMPLETE"])
        self.assertFalse(self.gates(self.authority_state(armed=False))["AUTOMATION_ARMED"])
        self.assertFalse(self.gates(config=dict(self.config, runtimeReady=False))["RUNTIME_PREPARED"])

    def test_stale_latest_backup_stops_before_export_download_or_import(self):
        c = controller.Controller(self.config)
        stale = dict(self.source, sourceTimestamp=self.iso(self.now-200000))
        with mock.patch.object(c, "exporter", return_value={"backup":stale}) as exporter, mock.patch.object(c, "download") as download, mock.patch.object(controller, "prepare") as prepare, mock.patch.object(controller.time, "time", return_value=self.now):
            c.prepare_latest()
        self.assertEqual(c.state["phase"], "BACKUP_STALE")
        exporter.assert_called_once_with("/v1/backups/latest")
        download.assert_not_called()
        prepare.assert_not_called()


class ControllerArtifactTests(RecoveryFixture):
    def test_cached_export_uses_nested_export_checksum_not_source_checksum(self):
        c = controller.Controller(self.config)
        cached = c.cache / (self.export_id + ".sql.zst.age")
        cached.write_bytes(self.artifact.read_bytes())
        with mock.patch.object(controller.urllib.request, "build_opener") as network:
            result = c.download(self.export_id, self.manifest)
        self.assertEqual(result, cached)
        network.assert_not_called()
        self.assertNotEqual(self.manifest["source"]["sourceSha256"], self.manifest["export"]["sha256"])

    def test_cached_ciphertext_tamper_or_wrong_recipient_rejected_without_network(self):
        c = controller.Controller(self.config)
        cached = c.cache / (self.export_id + ".sql.zst.age")
        cached.write_bytes(self.artifact.read_bytes()[:-1] + b"X")
        with mock.patch.object(controller.urllib.request, "build_opener") as network:
            with self.assertRaises(ValueError): c.download(self.export_id, self.manifest)
        network.assert_not_called()
        wrong = dict(self.manifest, export=dict(self.manifest["export"],ociRecipient="different-recipient"))
        with self.assertRaises(ValueError): c.download(self.export_id, wrong)

    def test_partial_or_wrong_hash_download_never_becomes_ready_artifact(self):
        c = controller.Controller(self.config)
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(self.artifact.read_bytes()[:-3])
        with mock.patch.object(controller.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(ValueError): c.download(self.export_id, self.manifest)
        self.assertFalse((c.cache / (self.export_id + ".sql.zst.age")).exists())
        self.assertFalse(list(c.cache.glob("*.partial")))

    def test_nas_nested_manifest_is_forwarded_intact_and_pinned_source_checked(self):
        c = controller.Controller(self.config)
        Path(self.config["candidateRoot"]).mkdir()
        def exporter(path, body=None):
            if path == "/v1/backups/latest": return {"backup":self.source}
            self.assertEqual(path,"/v1/exports")
            self.assertEqual(body,{"backupId":self.source["backupId"]})
            return {"exportId":self.export_id,"state":"ready","manifest":self.manifest}
        with mock.patch.object(c,"exporter",side_effect=exporter), mock.patch.object(c,"download",return_value=self.artifact) as download, mock.patch.object(controller,"prepare",return_value=self.candidate) as prepare, mock.patch.object(controller.time,"time",return_value=self.now):
            c.prepare_latest()
        download.assert_called_once_with(self.export_id,self.manifest)
        self.assertEqual(prepare.call_args.args[:3],(self.config,self.manifest,self.artifact))
        self.assertEqual(c.state["phase"],"STANDBY_READY")
        self.assertEqual(c.state["backup"], self.source)
        self.assertIsNone(c.state["pendingBackup"])
        self.assertEqual(restore_mysql.read_json(c.root / "prepared-candidate.json")["id"],self.candidate["id"])

    def test_export_of_different_source_is_rejected_before_download_or_restore(self):
        c = controller.Controller(self.config)
        changed = dict(self.manifest, source=dict(self.source, sourceSha256="e" * 64))
        replies = [{"backup": self.source}, {"exportId": self.export_id, "state": "ready", "manifest": changed}]
        with mock.patch.object(c, "exporter", side_effect=replies), mock.patch.object(c, "download") as download, mock.patch.object(controller, "prepare") as prepare, mock.patch.object(controller.time, "time", return_value=self.now):
            with self.assertRaises(ValueError): c.prepare_latest()
        download.assert_not_called()
        prepare.assert_not_called()


class RestoreIsolationTests(RecoveryFixture):
    def test_bad_checksum_is_rejected_before_any_docker_action(self):
        self.artifact.write_bytes(self.artifact.read_bytes()[:-1]+b"Z")
        with mock.patch.object(restore_mysql,"run") as run:
            with self.assertRaises(ValueError): restore_mysql.prepare(self.config,self.manifest,self.artifact)
        run.assert_not_called()
        self.assertFalse(Path(self.config["candidateRoot"]).exists())

    def test_initial_candidate_identity_is_checkpointed_before_docker_side_effect(self):
        progress=[]
        def run(argv,**kwargs):
            if argv[:2] == ["docker","run"]:
                container=argv[argv.index("--name")+1]
                self.assertTrue(any(item.get("candidate",{}).get("id") == container[len("cbte-dr-"):] for item in progress),"controller cannot quarantine a startup container if the candidate identity is not checkpointed first")
            return "ok"
        with mock.patch.object(restore_mysql,"run",side_effect=run), mock.patch.object(restore_mysql,"mysql",side_effect=self.fake_mysql), mock.patch.object(restore_mysql,"stream_import"):
            result=restore_mysql.prepare(self.config,self.manifest,self.artifact,progress.append)
        self.assertEqual(result["phase"],"VALIDATED")

    def test_partial_import_quarantines_old_candidate_and_next_attempt_is_new(self):
        with mock.patch.object(restore_mysql,"run",return_value="ok") as run, mock.patch.object(restore_mysql,"mysql",side_effect=self.fake_mysql), mock.patch.object(restore_mysql,"stream_import",side_effect=RuntimeError("upstream age stream failed")):
            with self.assertRaises(RuntimeError): restore_mysql.prepare(self.config,self.manifest,self.artifact)
        first_dirs=list(Path(self.config["candidateRoot"]).iterdir())
        self.assertEqual(len(first_dirs),1)
        old=restore_mysql.read_json(first_dirs[0]/"receipt.json")
        self.assertEqual(old["phase"],"QUARANTINED")
        self.assertTrue(any(call.args[0][:2]==["docker","stop"] and call.args[0][-1]==old["container"] for call in run.call_args_list))
        with mock.patch.object(restore_mysql,"run",return_value="ok"), mock.patch.object(restore_mysql,"mysql",side_effect=self.fake_mysql), mock.patch.object(restore_mysql,"stream_import"):
            new=restore_mysql.prepare(self.config,self.manifest,self.artifact)
        self.assertNotEqual(new["id"],old["id"])
        self.assertEqual(restore_mysql.read_json(first_dirs[0]/"receipt.json")["phase"],"QUARANTINED")

    def test_validated_candidate_stays_network_none_with_scheduler_off_and_read_only(self):
        with mock.patch.object(restore_mysql,"run",return_value="ok") as run, mock.patch.object(restore_mysql,"mysql",side_effect=self.fake_mysql) as mysql, mock.patch.object(restore_mysql,"stream_import"):
            result=restore_mysql.prepare(self.config,self.manifest,self.artifact)
        docker=next(call.args[0] for call in run.call_args_list if call.args[0][:2]==["docker","run"])
        self.assertEqual(docker[docker.index("--network")+1],"none")
        self.assertEqual(docker[docker.index("--restart")+1],"no")
        self.assertIn("--event-scheduler=OFF",docker)
        self.assertNotIn("-p",docker)
        self.assertNotIn("--publish",docker)
        self.assertEqual(result["phase"],"VALIDATED")
        self.assertTrue(result["checks"]["importCompleted"])
        mysql.assert_any_call(result["container"],"SET GLOBAL read_only=ON; SET GLOBAL super_read_only=ON;")

    def test_successful_mysql_exit_cannot_hide_failed_decryption(self):
        class Process:
            def __init__(self,code,pid): self.returncode,self.pid,self.stdout=code,pid,io.BytesIO()
            def poll(self): return self.returncode
            def wait(self,timeout=None): return self.returncode
        processes=[Process(2,9999001),Process(0,9999002),Process(0,9999003)]
        with mock.patch.object(restore_mysql.subprocess,"Popen",side_effect=processes):
            with self.assertRaises(RuntimeError): restore_mysql.stream_import(self.artifact,"unused-identity","fixture-container",self.root/"import.log",self.root,minimum_free_bytes=0)


class ControllerRestartTests(RecoveryFixture):
    def test_restart_never_restores_over_an_active_oci_database(self):
        root=Path(self.config["stateDir"])
        restore_mysql.atomic_json(root/"state.json",{"phase":"ACTIVE","candidate":self.candidate,"backup":self.source})
        active=dict(self.candidate,epoch=2)
        restore_mysql.atomic_json(root/"active-candidate.json",active)
        c=controller.Controller(self.config)
        with mock.patch.object(c,"authority",return_value=self.authority_state(activeNode="oci",epoch=3)),mock.patch.object(c,"prepare_latest") as prepare,mock.patch.object(controller,"run",return_value="active"):
            c.tick()
        prepare.assert_not_called()
        pointer=restore_mysql.read_json(root/"active-candidate.json")
        self.assertEqual(pointer["id"],self.candidate["id"])
        self.assertEqual(pointer["epoch"],3)

    def test_missing_active_pointer_blocks_instead_of_reimporting_backup(self):
        c=controller.Controller(self.config)
        with mock.patch.object(c,"authority",return_value=self.authority_state(activeNode="oci",epoch=2)),mock.patch.object(c,"prepare_latest") as prepare,mock.patch.object(controller,"run") as run:
            c.tick()
        prepare.assert_not_called()
        run.assert_not_called()
        self.assertEqual(c.state["phase"],"ACTIVE_STATE_UNKNOWN")

    def test_interrupted_import_preserves_quarantined_or_unconfirmed_identity(self):
        for verified in (False,True):
            root=Path(self.config["stateDir"])
            restore_mysql.atomic_json(root/"state.json",{"phase":"RESTORING_ISOLATED","candidate":{"id":self.candidate["id"]}})
            quarantined = dict(self.candidate, phase="QUARANTINED")
            with mock.patch.object(controller,"quarantine_interrupted_candidate",return_value=quarantined,side_effect=None if verified else RuntimeError("Ownership cannot be confirmed")) as quarantine:
                c=controller.Controller(self.config)
            quarantine.assert_called_once()
            self.assertEqual(c.state["phase"],"PREPARATION_INTERRUPTED")
            self.assertEqual(c.state["candidate"]["id"], self.candidate["id"])
            self.assertEqual(c.state["lastError"]["code"], "RESTORE_INTERRUPTED" if verified else "RESTORE_QUARANTINE_UNCONFIRMED")
            if verified:
                self.assertEqual(c.state["candidate"]["phase"], "QUARANTINED")


if __name__ == "__main__":
    unittest.main()
