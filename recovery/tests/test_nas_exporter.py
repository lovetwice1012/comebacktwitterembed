import concurrent.futures
import dataclasses
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request


MODULE = Path(__file__).resolve().parents[1] / "nas_exporter.py"
spec = importlib.util.spec_from_file_location("nas_exporter", MODULE)
import sys
nas = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = nas
spec.loader.exec_module(nas)
RECIPIENT = "age1tqapt4fs9d0pvhlwf3cg0vv29fu8k9ugqqzpg3qczjvm9t3nqqtqperrzu"
TOKEN = "fixture-export-token-never-use-production"


class ExporterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cbte-nas-export-")
        self.root = Path(self.temp.name)
        self.archive = self.root / "archive"
        self.archive.mkdir()
        self.config = nas.Config(token=TOKEN, oci_recipient=RECIPIENT, archive_root=self.archive, export_root=self.root / "exports", active_backup_root=self.root / "active-backups", min_free_bytes=0, max_source_bytes=1024 * 1024, max_export_bytes=2 * 1024 * 1024, max_cache_bytes=16 * 1024 * 1024, export_timeout_seconds=3, retry_cooldown_seconds=0)
        self.exporters = []

    def tearDown(self):
        for exporter in self.exporters:
            if exporter.worker:
                exporter.worker.join(timeout=5)
        self.temp.cleanup()

    def backup(self, backup_id="20260904T173004Z", value=b"fixture-encrypted-payload" * 20):
        directory = self.archive / "host-mysql" / backup_id[:4] / backup_id[4:6] / backup_id
        directory.mkdir(parents=True)
        name = f"{backup_id}__host-mysql.sql.zst.age"
        data = nas.AGE_HEADER + value
        digest = hashlib.sha256(data).hexdigest()
        (directory / name).write_bytes(data)
        (directory / f"{name}.sha256").write_bytes(f"{digest}  {name}\n".encode("ascii"))
        (directory / ".verified").write_text(f"schema=1\nfilename={name}\nsha256={digest}\nsize={len(data)}\nverified_at=2026-09-05T00:00:00Z\n", encoding="utf-8")
        return directory / name

    @staticmethod
    def fake_rewrap(source, output, recipient, deadline, max_bytes):
        output.write_bytes(nas.AGE_HEADER + b"OCI-rewrapped-fixture-" + source.read_bytes())

    def exporter(self, runner=None, config=None):
        exporter = nas.Exporter(config or self.config, runner or self.fake_rewrap)
        self.exporters.append(exporter)
        return exporter

    def terminal(self, exporter, key):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            state = exporter.status(key)
            if state["state"] in {"ready", "failed", "interrupted"}:
                return state
            time.sleep(0.01)
        self.fail("Export did not finish")

    def test_latest_is_by_utc_name_and_skips_checksum_invalid_generation(self):
        old = self.backup("20260903T173004Z")
        bad = self.backup()
        bytes_ = bad.read_bytes()
        bad.write_bytes(bytes_[:-1] + b"X")
        result = self.exporter().latest()
        self.assertEqual(result["backup"]["backupId"], "20260903T173004Z")
        self.assertTrue(result["backup"]["sha256Reverified"])
        self.assertEqual(result["skipped"][0]["code"], "CHECKSUM_MISMATCH")
        self.assertTrue(old.exists())

    def test_complete_export_binds_both_hashes_recipient_and_survives_restart(self):
        source = self.backup()
        original = source.read_bytes()
        exporter = self.exporter()
        accepted = exporter.request_export("20260904T173004Z")
        ready = self.terminal(exporter, accepted["exportId"])
        self.assertEqual(ready["state"], "ready", ready)
        manifest, stream = exporter.data(accepted["exportId"])
        with stream:
            exported = stream.read()
        self.assertEqual(manifest["source"]["sourceSha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(manifest["export"]["sha256"], hashlib.sha256(exported).hexdigest())
        self.assertEqual(manifest["export"]["ociRecipient"], RECIPIENT)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(set(os.listdir(source.parent)), {source.name, source.name + ".sha256", ".verified"})
        restarted = self.exporter()
        self.assertEqual(restarted.request_export("20260904T173004Z")["exportId"], accepted["exportId"])
        self.assertNotIn(TOKEN, json.dumps(ready))
        self.assertFalse(list(self.config.export_root.rglob("*.partial")))

    def test_ready_retention_expires_only_old_ciphertext_and_expired_post_can_rebuild(self):
        sources = {f"2026090{day}T173004Z": self.backup(f"2026090{day}T173004Z") for day in range(1, 6)}
        before = {key: path.read_bytes() for key, path in sources.items()}
        exporter = self.exporter()
        exports = {}
        for backup_id in sources:
            accepted = exporter.request_export(backup_id)
            exports[backup_id] = accepted["exportId"]
            self.assertEqual(self.terminal(exporter, accepted["exportId"])["state"], "ready")
            exporter.worker.join(timeout=3)
        self.assertEqual(sum(state["state"] == "ready" for state in exporter.jobs.values()), 3)
        oldest = exports["20260901T173004Z"]
        expired = exporter.status(oldest)
        self.assertEqual(expired["state"], "expired")
        self.assertIn("manifest", expired)
        self.assertTrue((self.config.export_root / oldest / "manifest.json").exists())
        self.assertFalse((self.config.export_root / oldest / "rewrapped.sql.zst.age").exists())
        with self.assertRaises(nas.ExportError) as caught:
            exporter.data(oldest)
        self.assertEqual(caught.exception.status, 410)
        accepted = exporter.request_export("20260901T173004Z")
        self.assertEqual(accepted["exportId"], oldest)
        rebuilt = self.terminal(exporter, oldest)
        exporter.worker.join(timeout=3)
        self.assertEqual(rebuilt["state"], "ready")
        self.assertEqual(rebuilt["attempt"], 2)
        self.assertEqual(exporter.status(exports["20260905T173004Z"])["state"], "ready", "newest source must not be pruned by an old-generation rebuild")
        self.assertEqual(sum(state["state"] == "ready" for state in exporter.jobs.values()), 3)
        for backup_id, path in sources.items():
            self.assertEqual(path.read_bytes(), before[backup_id])
            self.assertEqual(len(os.listdir(path.parent)), 3)

    def test_retention_protects_in_progress_downloads_until_their_streams_close(self):
        for day in range(1, 4):
            self.backup(f"2026090{day}T173004Z")
        exporter = self.exporter(config=dataclasses.replace(self.config, keep_ready_exports=2))
        keys = []
        streams = []
        try:
            for day in range(1, 3):
                key = exporter.request_export(f"2026090{day}T173004Z")["exportId"]
                self.terminal(exporter, key); exporter.worker.join(timeout=3)
                keys.append(key)
                streams.append(exporter.data(key)[1])
            newest = exporter.request_export("20260903T173004Z")["exportId"]
            self.terminal(exporter, newest); exporter.worker.join(timeout=3)
            self.assertEqual(exporter.status(keys[0])["state"], "ready")
            self.assertTrue(streams[0].read().startswith(nas.AGE_HEADER))
            streams[0].close()
            self.assertEqual(exporter.status(keys[0])["state"], "expired")
            self.assertEqual(exporter.status(newest)["state"], "ready")
        finally:
            for stream in streams:
                stream.close()

    def test_concurrent_identical_requests_share_one_export_and_other_backup_is_busy(self):
        self.backup()
        self.backup("20260903T173004Z")
        release = threading.Event()
        calls = []
        def runner(*args):
            calls.append(args[2])
            release.wait(timeout=3)
            self.fake_rewrap(*args)
        exporter = self.exporter(runner)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda _: exporter.request_export("20260904T173004Z"), range(6)))
        self.assertEqual(len({row["exportId"] for row in responses}), 1)
        with self.assertRaises(nas.ExportError) as caught:
            exporter.request_export("20260903T173004Z")
        self.assertEqual(caught.exception.code, "EXPORT_BUSY")
        release.set()
        self.assertEqual(self.terminal(exporter, responses[0]["exportId"])["state"], "ready")
        self.assertEqual(calls, [RECIPIENT])

    def test_corrupt_source_or_failed_pipeline_never_produces_ready_data(self):
        source = self.backup()
        source.write_bytes(source.read_bytes()[:-1] + b"X")
        exporter = self.exporter(lambda *args: self.fail("Invalid source must not reach decryption"))
        result = exporter.request_export("20260904T173004Z")
        state = self.terminal(exporter, result["exportId"])
        self.assertEqual(state["error"]["code"], "CHECKSUM_MISMATCH")
        with self.assertRaises(nas.ExportError):
            exporter.data(result["exportId"])

    def test_pipeline_failure_cleans_partial_ciphertext_and_is_explicit(self):
        self.backup()
        def runner(source, destination, recipient, deadline, maximum):
            destination.write_bytes(nas.AGE_HEADER + b"incomplete")
            raise nas.ExportError("AGE_REWRAP_FAILED", "Fixture pipeline authentication failure", 502)
        exporter = self.exporter(runner)
        result = exporter.request_export("20260904T173004Z")
        state = self.terminal(exporter, result["exportId"])
        self.assertEqual(state["state"], "failed")
        self.assertEqual(state["error"]["code"], "AGE_REWRAP_FAILED")
        exporter.worker.join(timeout=3)
        self.assertFalse(list(self.config.export_root.rglob("*.partial")))
        self.assertFalse(list(self.config.export_root.rglob("manifest.json")))

    def test_export_deadline_size_and_disk_failures_are_explicit_without_publishing_data(self):
        self.backup()
        def expired(source, destination, recipient, deadline, maximum):
            self.fake_rewrap(source, destination, recipient, deadline, maximum)
            time.sleep(1.05)
        def disk_full(source, destination, recipient, deadline, maximum):
            raise OSError(errno.ENOSPC, "fixture disk full")
        cases = [
            ("deadline", expired, {"export_timeout_seconds": 1}, "EXPORT_DEADLINE"),
            ("size", self.fake_rewrap, {"max_export_bytes": 256}, "EXPORT_SIZE_LIMIT"),
            ("disk", disk_full, {}, "EXPORT_DISK_LIMIT"),
        ]
        for label, runner, values, expected in cases:
            config = dataclasses.replace(self.config, export_root=self.root / ("exports-" + label), **values)
            exporter = self.exporter(runner, config)
            result = exporter.request_export("20260904T173004Z")
            state = self.terminal(exporter, result["exportId"])
            self.assertEqual(state["state"], "failed")
            self.assertEqual(state["error"]["code"], expected)
            with self.assertRaises(nas.ExportError):
                exporter.data(result["exportId"])

    def test_manifest_tampering_or_ciphertext_tampering_is_not_served(self):
        self.backup()
        exporter = self.exporter()
        accepted = exporter.request_export("20260904T173004Z")
        self.assertEqual(self.terminal(exporter, accepted["exportId"])["state"], "ready")
        directory = self.config.export_root / accepted["exportId"]
        data = directory / "rewrapped.sql.zst.age"
        data.write_bytes(data.read_bytes()[:-1] + b"X")
        with self.assertRaises(nas.ExportError) as caught:
            exporter.data(accepted["exportId"])
        self.assertEqual(caught.exception.code, "EXPORT_CHECKSUM_MISMATCH")
        manifest = json.loads((directory / "manifest.json").read_text())
        manifest["export"]["filename"] = "../../identity.txt"
        (directory / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(nas.ExportError):
            exporter.status(accepted["exportId"])

    def test_paths_extra_manifest_fields_and_disk_quota_fail_closed(self):
        source = self.backup()
        with self.assertRaises(nas.ExportError):
            nas.source_metadata(self.config, "../../etc/shadow")
        marker = source.parent / ".verified"
        marker.write_text(marker.read_text() + "recipient=attacker\n")
        with self.assertRaises(nas.ExportError):
            nas.source_metadata(self.config, "20260904T173004Z")
        marker.write_text(marker.read_text().replace("recipient=attacker\n", ""))
        small = dataclasses.replace(self.config, max_cache_bytes=1024)
        with self.assertRaises(nas.ExportError) as caught:
            self.exporter(config=small).request_export("20260904T173004Z")
        self.assertEqual(caught.exception.code, "EXPORT_DISK_LIMIT")

    def test_symlink_archives_are_rejected(self):
        source = self.backup()
        other = self.root / "outside.age"
        source.rename(other)
        try:
            source.symlink_to(other)
        except OSError:
            self.skipTest("Host does not permit test symlinks")
        with self.assertRaises(nas.ExportError):
            nas.source_metadata(self.config, "20260904T173004Z")

    def test_docker_command_pins_identity_recipient_image_network_and_internal_timeout(self):
        command = nas.docker_command(Path("/exports/staged-cipher.age"), RECIPIENT, "fixture-job", 75)
        self.assertEqual(command[command.index("--network") + 1], "none")
        self.assertIn("--pull=never", command)
        self.assertEqual(command[command.index("--log-driver") + 1], "none")
        self.assertIn(nas.RESTORE_IMAGE, command)
        self.assertIn("/usr/bin/timeout", command)
        self.assertIn("75", command)
        self.assertEqual(command[-1], RECIPIENT)
        self.assertTrue(any(nas.NAS_IDENTITY in item and item.endswith(",readonly") for item in command))
        script = command[command.index("-c") + 1]
        self.assertIn("set -o pipefail", script)
        self.assertIn("age --decrypt", script)
        self.assertIn("| age --encrypt", script)
        self.assertNotIn("zstd --decompress", script)

    def test_http_authentication_and_request_recipient_injection_rejection(self):
        self.backup()
        server = nas.server_for(self.exporter(), port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with urllib.request.urlopen(url + "/health") as response:
                self.assertEqual(json.load(response), {"ok": True, "service": "cbte-nas-exporter"})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(url + "/v1/backups/latest")
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
            request = urllib.request.Request(url + "/v1/exports", method="POST", headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, data=json.dumps({"backupId": "20260904T173004Z", "recipient": "attacker"}).encode())
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(request)
            self.assertEqual(caught.exception.code, 400)
            caught.exception.close()
            request = urllib.request.Request(url + "/v1/backups/latest", headers={"Authorization": "Bearer " + TOKEN})
            with urllib.request.urlopen(request) as response:
                self.assertEqual(json.load(response)["backup"]["backupId"], "20260904T173004Z")
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
