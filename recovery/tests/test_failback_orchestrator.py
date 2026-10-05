import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import copy

from recovery.failback_orchestrator import Failback, FailbackError


class FailbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.config_file = root / "config.json"
        authority = root / "authority.json"
        key = root / "key"
        cert = root / "cert"
        notify_config = root / "notify.json"
        for path in (authority, key, cert, notify_config):
            path.write_text(json.dumps({"tokens": {"controller": "c" * 40}}) if path == authority else "fixture")
            os.chmod(path, 0o600)
        self.config = {"statePath": str(root / "state.json"), "authorityUrl": "http://127.0.0.1:34210", "authorityConfig": str(authority), "primarySshKey": str(key), "primarySnapshotPath": str(root / "snapshot"), "primaryReadyMarker": str(root / "ready"), "primaryTunnelId": "739a9c55-e8d6-4e80-a388-540704f4e2af", "cloudflared": "/usr/bin/cloudflared", "originCertificate": str(cert), "notificationConfig": str(notify_config), "primaryHostnames": ["cbte.sprink.cloud", "twidata.sprink.cloud"], "handoffMarker": str(root / "handoff.json"), "sourceLeaseFile": str(root / "lease.json")}

    def tearDown(self):
        self.temp.cleanup()

    def test_fixed_hostnames_and_durable_operation(self):
        process = Failback(self.config)
        self.assertEqual(process.state["phase"], "WAITING_PRIMARY")
        self.assertEqual(len(process.state["operationId"]), 48)
        with self.assertRaises(FailbackError):
            Failback(dict(self.config, primaryHostnames=["example.test"]))

    def copy_fixture(self):
        process = Failback(self.config)
        process.state["sourceEpoch"] = 6
        tables = ["guilds", "users", "providers", "schema_migrations"] + ["table_%02d" % n for n in range(36)]
        receipt = {"version": 1, "operationId": process.state["operationId"], "sourceNode": "oci", "sourceEpoch": 6,
                   "sourceFenced": True, "restoreVerified": True, "snapshotPath": self.config["primarySnapshotPath"],
                   "primaryBootId": "a" * 32, "snapshotSha256": "b" * 64, "tables": tables, "guilds": 17123}
        evidence = {"receipt": receipt, "bootId": "a" * 32, "snapshotSha256": "b" * 64, "tables": tables, "guilds": 17123}
        return process, evidence

    def test_current_40_table_copy_passes_without_a_hardcoded_count(self):
        process, evidence = self.copy_fixture()
        self.assertEqual(process.validate_primary_copy(evidence)["tables"], 40)

    def test_old_operation_epoch_hash_schema_or_unverified_copy_is_rejected(self):
        process, evidence = self.copy_fixture()
        for key, value in [("operationId", "old"), ("sourceEpoch", 5), ("snapshotSha256", "c" * 64),
                           ("sourceFenced", False), ("restoreVerified", False), ("primaryBootId", "other")]:
            with self.subTest(key=key):
                invalid = copy.deepcopy(evidence); invalid["receipt"][key] = value
                with self.assertRaises(FailbackError):
                    process.validate_primary_copy(invalid)
        invalid = copy.deepcopy(evidence); invalid["tables"] = invalid["tables"][:-1]
        with self.assertRaises(FailbackError):
            process.validate_primary_copy(invalid)

    def test_row_counts_are_fixed_before_handoff_but_can_grow_after_activation(self):
        process, evidence = self.copy_fixture(); evidence["guilds"] += 1
        with self.assertRaises(FailbackError):
            process.validate_primary_copy(evidence)
        process.state["phase"] = "PRIMARY_VERIFYING"
        self.assertEqual(process.validate_primary_copy(evidence)["guilds"], 17124)

    def test_legacy_snapshot_without_final_copy_manifest_fails_closed(self):
        process = Failback(self.config)
        with self.assertRaisesRegex(FailbackError, "final database copy"):
            process.primary_ready()

    def test_manual_only_policy_does_not_return_without_reservation(self):
        process = Failback(dict(self.config, manualFailbackOnly=True))
        with mock.patch.object(process, "manual_switch_record", return_value=None):
            self.assertFalse(process.bind_manual_switch({"epoch": 6}))
    def test_primary_cutback_requires_an_explicit_console_reservation(self):
        process = Failback(self.config)
        with mock.patch.object(process, "manual_switch_record", return_value=None):
            self.assertFalse(process.bind_manual_switch({"activeNode": "oci"}))
        process = Failback(dict(self.config, manualFailbackOnly=False))
        with mock.patch.object(process, "manual_switch_record", return_value=None):
            self.assertTrue(process.bind_manual_switch({"activeNode": "oci"}))


if __name__ == "__main__":
    unittest.main()
