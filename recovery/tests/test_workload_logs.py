"""Authenticated loopback reads of bounded, owned workload logs."""
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from recovery import controller, workload_logs
from recovery.restore_mysql import atomic_json


class WorkloadLogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cbte-workload-log-read-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "controller"
        self.candidates = self.root / "candidates"
        self.runtime_root = self.root / "workload"
        self.identifier = "a" * 24
        self.candidate = self.candidates / self.identifier
        self.runtime = self.runtime_root / self.identifier
        self.logs = self.runtime / "logs"
        for path in [self.state, self.candidates, self.candidate, self.runtime_root, self.runtime, self.logs]:
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            path.chmod(0o700)
        self.pointer = {"id": self.identifier, "epoch": 4, "container": "cbte-dr-" + self.identifier, "directory": str(self.candidate), "mysqlImage": "mysql@sha256:" + "b" * 64, "manifest": {}, "checks": {"importCompleted": True}}
        atomic_json(self.state / "active-candidate.json", self.pointer)
        atomic_json(self.candidate / "receipt.json", self.pointer | {"phase": "ACTIVATION_FAILED", "activationEpoch": 4, "activationUpdatedAt": 1800000000})
        atomic_json(self.runtime / "oci-state-origin.json", {"candidateId": self.identifier, "origin": "fresh-oci-state"})
        self.activation = {"candidateId": self.identifier, "container": self.pointer["container"], "epoch": 4, "phase": "ACTIVATION_FAILED", "updatedAt": 1800000000, "childLogs": [{"name": "bot.log", "receivedBytes": 2000, "writtenBytes": 1900, "droppedBytes": 100, "trimmedBytes": 50, "rotations": 2, "writeError": "OSError:28", "readError": None, "queuedChunks": 0, "unexpectedPrivateField": "not-a-log-health-field"}]}
        atomic_json(self.runtime / "activation.json", self.activation)
        self.workload_path = self.root / "workload.json"
        self.workload = {"candidatePointer": str(self.state / "active-candidate.json"), "candidateRoot": str(self.candidates), "runtimeRoot": str(self.runtime_root), "authorityToken": "fixture-oci-role-token-" + "o" * 24}
        atomic_json(self.workload_path, self.workload)
        self.config = {"stateDir": str(self.state), "candidateRoot": str(self.candidates), "workloadConfig": str(self.workload_path), "statusToken": "fixture-status-" + "s" * 32, "authorityControllerToken": "fixture-controller-role-" + "c" * 24, "listen": "127.0.0.1:0"}
        self.primary_token = "fixture-primary-role-" + "p" * 24
        atomic_json(self.root / "authority.json", {"tokens": {"primary": self.primary_token, "oci": self.workload["authorityToken"], "controller": self.config["authorityControllerToken"]}})
        self.write_log("bot.log", b"startup began\nprovider HTTP403\nRuntimeError: provider failed\n")
        self.c = controller.Controller(self.config)
        self.server = controller.make_server(self.c, self.config)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True)
        self.thread.start()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=1)

    def write_log(self, name, data):
        path = self.logs / name
        path.write_bytes(data); path.chmod(0o600)
        return path

    def get(self, query="component=bot", token=True):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=3)
        headers = {"Authorization": "Bearer " + self.config["statusToken"]} if token else {}
        try:
            connection.request("GET", "/v1/workload-logs?" + query, headers=headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_authenticated_tail_exposes_startup_failure_and_loss_metadata(self):
        code, value = self.get("component=bot&lines=2")
        self.assertEqual(code, 200)
        self.assertTrue(value["available"])
        self.assertEqual(value["text"], "provider HTTP403\nRuntimeError: provider failed\n")
        self.assertTrue(value["truncated"])
        self.assertEqual(value["phase"], "ACTIVATION_FAILED")
        self.assertEqual(value["logHealth"]["droppedBytes"], 100)
        self.assertEqual(value["logHealth"]["trimmedBytes"], 50)
        self.assertEqual(value["logHealth"]["writeError"], "OSError:28")
        self.assertNotIn("unexpectedPrivateField", value["logHealth"])
        self.assertIn("fileUpdatedAt", value)

    def test_authentication_precedes_any_private_file_read(self):
        with mock.patch.object(workload_logs, "read_workload_logs", side_effect=AssertionError("unauthorized file read")):
            self.assertEqual(self.get(token=False)[0], 401)

    def test_traversal_unknown_fields_duplicates_and_limits_are_rejected(self):
        for query in ["component=..%2F..%2Fsecret", "component=core", "path=/etc/shadow", "component=bot&component=reports", "component=bot&bytes=262145", "component=bot&lines=1001", "component=bot&archive=8", "component=bot&archive=4", "component=bot&bytes=-1"]:
            with self.subTest(query=query): self.assertEqual(self.get(query)[0], 400)

    def test_missing_and_empty_logs_are_distinct(self):
        (self.logs / "bot.log").unlink()
        code, value = self.get()
        self.assertEqual(code, 200)
        self.assertFalse(value["available"])
        self.assertEqual(value["state"], "log_absent")
        self.write_log("bot.log", b"")
        _, value = self.get()
        self.assertTrue(value["available"])
        self.assertEqual(value["fileBytes"], 0)

    def test_standby_without_active_pointer_reports_not_started(self):
        (self.state / "active-candidate.json").unlink()
        code, value = self.get()
        self.assertEqual(code, 200)
        self.assertFalse(value["available"])
        self.assertEqual(value["state"], "not_started")

    def test_candidate_or_activation_mismatch_never_returns_log_bytes(self):
        self.activation["candidateId"] = "f" * 24
        atomic_json(self.runtime / "activation.json", self.activation)
        code, value = self.get()
        self.assertEqual(code, 409)
        self.assertEqual(value["error"]["code"], "LOG_ACTIVATION_MISMATCH")
        self.assertNotIn("RuntimeError", json.dumps(value))

    def test_symlink_log_and_symlink_runtime_are_rejected(self):
        target = self.root / "unrelated-private.txt"
        target.write_text("must not be returned"); target.chmod(0o600)
        log = self.logs / "bot.log"; log.unlink()
        try: log.symlink_to(target)
        except OSError: self.skipTest("symlink creation unavailable")
        code, value = self.get()
        self.assertEqual(code, 409)
        self.assertNotIn("must not be returned", json.dumps(value))
        log.unlink(); self.write_log("bot.log", b"legitimate")
        moved = self.runtime.with_name(self.identifier + "-moved")
        self.runtime.rename(moved)
        self.runtime.symlink_to(moved, target_is_directory=True)
        self.assertEqual(self.get()[0], 409)

    def test_byte_bounded_long_line_and_archive_selection(self):
        self.write_log("bot.log", b"x" * (workload_logs.MAX_BYTES + 200))
        _, value = self.get("component=bot&bytes=100")
        self.assertEqual(value["text"], "x" * 100)
        self.assertEqual(value["returnedBytes"], 100)
        self.assertTrue(value["firstLinePartial"])
        self.assertTrue(value["truncated"])
        self.write_log("bot.log.1", b"previous failure\n")
        _, value = self.get("component=bot&archive=1")
        self.assertEqual(value["text"], "previous failure\n")
        self.assertEqual({item["archive"] for item in value["files"]}, {0, 1})

    def test_control_role_credentials_are_omitted_but_log_evidence_remains_literal(self):
        content = "<script>alert('literal log')</script>\n" + " ".join([self.primary_token, self.config["statusToken"], self.workload["authorityToken"], self.config["authorityControllerToken"]])
        self.write_log("bot.log", content.encode())
        _, value = self.get()
        self.assertTrue(value["controlCredentialsRedacted"])
        self.assertIn("<script>", value["text"])
        for token in [self.primary_token, self.config["statusToken"], self.workload["authorityToken"], self.config["authorityControllerToken"]]:
            self.assertNotIn(token, json.dumps(value))

    def test_previous_activation_epoch_is_readable_as_historical_evidence(self):
        self.activation["epoch"] = 3
        atomic_json(self.runtime / "activation.json", self.activation)
        _, value = self.get()
        self.assertTrue(value["available"])
        self.assertFalse(value["currentActivation"])
        self.assertEqual(value["activationEpoch"], 3)

    def test_receipt_metadata_covers_crash_between_phase_and_activation_file_write(self):
        (self.runtime / "activation.json").unlink()
        code, value = self.get()
        self.assertEqual(code, 200)
        self.assertTrue(value["available"])
        self.assertEqual(value["metadataSource"], "candidate_receipt")
