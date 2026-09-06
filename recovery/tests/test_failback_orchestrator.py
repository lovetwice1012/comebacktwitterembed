import json
import os
from pathlib import Path
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main()
