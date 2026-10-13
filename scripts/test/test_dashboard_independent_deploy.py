"""Deployment transaction tests with temporary files and system/process stubs."""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("dashboard_independent_deploy", REPO / "scripts/dashboard-independent-deploy.py")
DEPLOY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = DEPLOY
SPEC.loader.exec_module(DEPLOY)
REAL_IDENTITIES = DEPLOY.identities
REAL_ATOMIC_FILE = DEPLOY.atomic_file
LINKS: dict[str, Path] = {}


class TestLinkPath(type(Path())):
    """Represent only the deployment symlink without needing Windows elevation."""
    def symlink_to(self, target, target_is_directory=False):
        if self.exists():
            raise FileExistsError(str(self))
        self.write_bytes(b"fixture symlink")
        LINKS[str(self)] = Path(target)

    def is_symlink(self):
        return str(self) in LINKS and self.exists()

    def resolve(self, strict=False):
        if self.is_symlink():
            return LINKS[str(self)].resolve(strict=strict)
        return super().resolve(strict=strict)

    def unlink(self, missing_ok=False):
        LINKS.pop(str(self), None)
        return super().unlink(missing_ok=missing_ok)


class Fixture:
    def __init__(self, root: Path):
        self.root = root
        self.stage = root / "stage"
        self.live = root / "live"
        self.stage.mkdir()
        (self.live / "dashboard").mkdir(parents=True)
        self.build = self.stage / "dashboard/.next-account-ui-preview"
        self.build.mkdir(parents=True)
        (self.build / "BUILD_ID").write_text("reviewedBuild")
        (self.build / "server.js").write_text("reviewed fixture server")
        self.artifact_report = root / "artifact-report.json"
        self.artifact_report.write_text(json.dumps({"buildPath": str(self.build.resolve()), "stageRoot": str(self.stage.resolve()),
            "buildId": "reviewedBuild", "missingTraceFiles": [], "externalTracePaths": [],
            "artifactFiles": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.build.iterdir()}}))
        systemd = root / "systemd"
        nginx = root / "nginx"
        systemd.mkdir()
        nginx.mkdir()
        self.layout = DEPLOY.Layout(current=TestLinkPath(root / "opt/current"), runtime_env=root / "etc/environment.json",
            unit=systemd / "cbte-dashboard.service", bot_dropin=systemd / "cbte.service.d/98-independent-dashboard.conf",
            nginx_gateway=nginx / "cbte-admin-gateway.conf", nginx_origin=nginx / "cbte-dashboard-origin.conf", proc=root / "proc")
        self.old_nginx = b"location / {\n proxy_pass http://127.0.0.1:30989;\n}\n"
        self.layout.nginx_gateway.write_bytes(self.old_nginx)
        self.layout.nginx_origin.write_bytes(self.old_nginx)
        self.args = SimpleNamespace(stage_root=self.stage, artifact_report=self.artifact_report,
            expected_artifact_report_sha256=DEPLOY.sha256(self.artifact_report), expected_build_id="reviewedBuild",
            expected_bot_main_pid=100, expected_bot_workload_pid=200, expected_wrapper_pid=300, expected_next_pid=400,
            expected_live_release=self.live, unit_source=REPO / "deploy/systemd/cbte-dashboard.service",
            backup_dir=root / "backup", port=30990, canonical_origin="https://cbte.sprink.cloud")
        self.observed = {"main": {"pid": 100, "parentPid": 1, "startTicks": "10", "cwd": str(self.live)},
            "bot": {"pid": 200, "parentPid": 100, "startTicks": "20", "cwd": str(self.live)},
            "wrapper": {"pid": 300, "parentPid": 200, "startTicks": "30", "cwd": str(self.live / "dashboard")},
            "next": {"pid": 400, "parentPid": 300, "startTicks": "40", "cwd": str(self.live / "dashboard")}}
        self.calls = []
        self.kills = []
        self.dashboard_active = False
        self.enabled = False
        self.fail_command = None
        self.fail_once = True

    def run(self, command):
        self.calls.append(command)
        if command == ["systemctl", "enable", DEPLOY.SERVICE]:
            self.enabled = True
        if self.fail_command == command:
            if self.fail_once:
                self.fail_command = None
            raise RuntimeError("stubbed command failure")
        if command == ["systemctl", "start", DEPLOY.SERVICE]:
            self.dashboard_active = True
        if command == ["systemctl", "stop", DEPLOY.SERVICE]:
            self.dashboard_active = False
        if command == ["systemctl", "disable", DEPLOY.SERVICE]:
            self.enabled = False
        return ""

    def service_field(self, service, field):
        if service == "cbte.service":
            return {"MainPID": "100", "ActiveState": "active"}[field]
        return {"LoadState": "loaded" if self.layout.unit.exists() else "not-found",
                "MainPID": "500" if self.dashboard_active else "0",
                "ActiveState": "active" if self.dashboard_active else "inactive"}[field]

    def patch(self):
        stack = ExitStack()
        stack.enter_context(patch.object(DEPLOY, "identities", side_effect=lambda *_: self.observed))
        stack.enter_context(patch.object(DEPLOY, "environment", return_value={"PORT": "30989", "DASHBOARD_PORT": "30989",
            "NEXTAUTH_SECRET": "PRIVATE_FIXTURE", "CBTE_FLEET_NODE": "primary", "CBTE_FLEET_LEASE_FILE": str(self.root / "lease.json"),
            "DASHBOARD_DISABLED": "true", "DISABLE_DASHBOARD": "true", "DASHBOARD_NEXT_DIST_DIR": ".next-old"}))
        stack.enter_context(patch.object(DEPLOY, "service_field", side_effect=self.service_field))
        stack.enter_context(patch.object(DEPLOY, "run", side_effect=self.run))
        stack.enter_context(patch.object(DEPLOY, "free_port"))
        stack.enter_context(patch.object(DEPLOY, "health", return_value={"status": 200, "ok": True, "authorityAvailable": True}))
        stack.enter_context(patch.object(DEPLOY, "public_health", return_value={"status": 200, "ok": True}))
        stack.enter_context(patch.object(DEPLOY.os, "kill", side_effect=lambda pid, sig: self.kills.append((pid, sig))))
        return stack


class IndependentDeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cbte-deploy-transaction-")
        self.fixture = Fixture(Path(self.temp.name))
        self.patches = self.fixture.patch()

    def tearDown(self):
        self.patches.close()
        self.temp.cleanup()

    def prepare(self):
        return DEPLOY.prepare(self.fixture.args, self.fixture.layout)

    def promote(self):
        return DEPLOY.promote(self.fixture.args, self.fixture.layout)

    def assert_old_route_and_bot_untouched(self):
        self.assertEqual(self.fixture.layout.nginx_gateway.read_bytes(), self.fixture.old_nginx)
        self.assertEqual(self.fixture.layout.nginx_origin.read_bytes(), self.fixture.old_nginx)
        self.assertEqual(self.fixture.kills, [])
        self.assertFalse(self.fixture.layout.bot_dropin.exists())
        self.assertNotIn(["systemctl", "restart", "cbte.service"], self.fixture.calls)

    def test_prepare_has_no_public_or_bot_effect_and_captures_private_env(self):
        report = self.prepare()
        self.assertEqual(report["status"], "prepared")
        self.assertEqual(report["publicRoutingChanged"], False)
        self.assertEqual(self.fixture.layout.current.resolve(), self.fixture.stage.resolve())
        captured = json.loads(self.fixture.layout.runtime_env.read_text())
        self.assertEqual(captured["PORT"], "30990")
        self.assertEqual(captured["DASHBOARD_PORT"], "30990")
        self.assertEqual(captured["DASHBOARD_FLEET_LEASE_MODE"], "shared-current")
        self.assertEqual(captured["NEXTAUTH_SECRET"], "PRIVATE_FIXTURE")
        self.assertNotIn("DASHBOARD_DISABLED", captured)
        self.assertNotIn("DISABLE_DASHBOARD", captured)
        self.assertNotIn("DASHBOARD_NEXT_DIST_DIR", captured)
        self.assertNotIn("PRIVATE_FIXTURE", json.dumps(report))
        self.assertNotIn("PRIVATE_FIXTURE", (self.fixture.args.backup_dir / "prepare.json").read_text())
        self.assertNotIn("PRIVATE_FIXTURE", json.dumps(self.fixture.calls))
        self.assert_old_route_and_bot_untouched()

    def test_repeated_prepare_fails_closed_and_preserves_installation(self):
        self.prepare()
        before = self.fixture.layout.runtime_env.read_bytes()
        calls = list(self.fixture.calls)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.prepare()
        self.assertEqual(self.fixture.layout.runtime_env.read_bytes(), before)
        self.assertEqual(self.fixture.calls, calls)
        self.assert_old_route_and_bot_untouched()

    def test_changed_artifact_fails_before_installation(self):
        (self.fixture.build / "server.js").write_text("unexpected changed artifact")
        with self.assertRaisesRegex(ValueError, "artifact changed"):
            self.prepare()
        self.assertFalse(self.fixture.layout.unit.exists())
        self.assertFalse(self.fixture.args.backup_dir.exists())
        self.assertEqual(self.fixture.calls, [])

    def test_start_failure_rolls_back_only_created_references_and_preserves_build(self):
        self.fixture.fail_command = ["systemctl", "start", DEPLOY.SERVICE]
        with self.assertRaises(RuntimeError):
            self.prepare()
        self.assertFalse(self.fixture.layout.current.exists())
        self.assertFalse(self.fixture.layout.unit.exists())
        self.assertFalse(self.fixture.layout.runtime_env.exists())
        self.assertTrue((self.fixture.build / "BUILD_ID").exists())
        record = json.loads((self.fixture.args.backup_dir / "prepare.json").read_text())
        self.assertEqual(record["status"], "prepare_failed")
        self.assert_old_route_and_bot_untouched()

    def test_nginx_validation_failure_restores_configs_without_handoff(self):
        self.prepare()
        self.fixture.fail_command = ["nginx", "-t"]
        with self.assertRaises(RuntimeError):
            self.promote()
        self.assert_old_route_and_bot_untouched()
        self.assertTrue(self.fixture.dashboard_active)
        self.assertFalse(self.fixture.enabled)
        for name in ("cbte-admin-gateway.conf", "cbte-dashboard-origin.conf"):
            self.assertEqual((self.fixture.args.backup_dir / "nginx" / name).read_bytes(), self.fixture.old_nginx)

    def test_reload_failure_restores_and_reloads_original_config(self):
        self.prepare()
        self.fixture.fail_command = ["systemctl", "reload", "nginx"]
        with self.assertRaises(RuntimeError):
            self.promote()
        self.assert_old_route_and_bot_untouched()
        self.assertEqual(self.fixture.calls.count(["systemctl", "reload", "nginx"]), 2)

    def test_enable_failure_rolls_back_dropin_routes_and_partial_enable(self):
        self.prepare()
        self.fixture.fail_command = ["systemctl", "enable", DEPLOY.SERVICE]
        with self.assertRaises(RuntimeError):
            self.promote()
        self.assert_old_route_and_bot_untouched()
        self.assertFalse(self.fixture.enabled)
        self.assertIn(["systemctl", "disable", DEPLOY.SERVICE], self.fixture.calls)

    def test_promotion_hands_off_only_verified_wrapper_and_enables_boot_service(self):
        self.prepare()
        report = self.promote()
        self.assertEqual(report["status"], "promoted")
        self.assertTrue(self.fixture.enabled)
        self.assertEqual(self.fixture.layout.nginx_gateway.read_bytes(), self.fixture.old_nginx.replace(b"30989", b"30990"))
        self.assertEqual(self.fixture.layout.nginx_origin.read_bytes(), self.fixture.old_nginx.replace(b"30989", b"30990"))
        self.assertEqual(self.fixture.kills, [(300, DEPLOY.signal.SIGTERM)])
        self.assertIn("DASHBOARD_DISABLED=true", self.fixture.layout.bot_dropin.read_text())
        self.assertNotIn(["systemctl", "restart", "cbte.service"], self.fixture.calls)
        previous_calls = list(self.fixture.calls)
        with self.assertRaisesRegex(ValueError, "drop-in already exists"):
            self.promote()
        self.assertEqual(self.fixture.calls, previous_calls)

    def test_post_handoff_metadata_failure_never_returns_to_dead_upstream(self):
        self.prepare()
        def fail_commit(path, content, mode=0o600):
            if path.name == "promote.json" and json.loads(content)["status"] == "promoted":
                raise OSError("fixture metadata storage failure")
            return REAL_ATOMIC_FILE(path, content, mode)
        with patch.object(DEPLOY, "atomic_file", side_effect=fail_commit):
            with self.assertRaises(OSError):
                self.promote()
        self.assertEqual(self.fixture.kills, [(300, DEPLOY.signal.SIGTERM)])
        self.assertTrue(self.fixture.enabled)
        self.assertTrue(self.fixture.layout.bot_dropin.exists())
        self.assertIn(b"30990", self.fixture.layout.nginx_origin.read_bytes())
        record = json.loads((self.fixture.args.backup_dir / "promote.json").read_text())
        self.assertEqual(record["status"], "promoted_metadata_failure")

    def test_duplicate_upstream_is_rejected_before_nginx_mutation(self):
        self.prepare()
        self.fixture.layout.nginx_gateway.write_bytes(self.fixture.old_nginx * 2)
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.promote()
        self.assertEqual(self.fixture.layout.nginx_gateway.read_bytes(), self.fixture.old_nginx * 2)
        self.assertEqual(self.fixture.kills, [])
        self.assertFalse(self.fixture.layout.bot_dropin.exists())

    def test_pid_ancestry_guard_rejects_replaced_next_child(self):
        identities = {entry["pid"]: dict(entry) for entry in self.fixture.observed.values()}
        identities[400]["parentPid"] = 999
        with patch.object(DEPLOY, "process_identity", side_effect=lambda pid, *_: identities[pid]):
            with self.assertRaisesRegex(ValueError, "ancestry changed"):
                REAL_IDENTITIES(self.fixture.args, self.fixture.layout)

    def test_mutated_prepared_environment_prevents_promotion(self):
        self.prepare()
        self.fixture.layout.runtime_env.write_text("{}")
        with self.assertRaisesRegex(ValueError, "environment, unit, or build pointer changed"):
            self.promote()
        self.assert_old_route_and_bot_untouched()

    def test_public_health_failure_restores_old_route_before_handoff(self):
        self.prepare()
        with patch.object(DEPLOY, "public_health", side_effect=RuntimeError("public route unavailable")):
            with self.assertRaises(RuntimeError):
                self.promote()
        self.assert_old_route_and_bot_untouched()
        self.assertTrue(self.fixture.dashboard_active)

    def test_rollback_never_overwrites_concurrently_edited_nginx_config(self):
        self.prepare()
        concurrent = b"operator changed this config concurrently\n"
        def public_failure(*_):
            self.fixture.layout.nginx_gateway.write_bytes(concurrent)
            raise RuntimeError("public health failed after concurrent edit")
        with patch.object(DEPLOY, "public_health", side_effect=public_failure):
            with self.assertRaises(RuntimeError):
                self.promote()
        self.assertEqual(self.fixture.layout.nginx_gateway.read_bytes(), concurrent)
        self.assertEqual(self.fixture.layout.nginx_origin.read_bytes(), self.fixture.old_nginx)
        record = json.loads((self.fixture.args.backup_dir / "promote.json").read_text())
        self.assertEqual(record["rollbackConflicts"], [str(self.fixture.layout.nginx_gateway)])
        self.assertEqual(self.fixture.kills, [])


if __name__ == "__main__":
    unittest.main()
