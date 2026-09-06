import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("primary_config_writer", Path(__file__).resolve().parents[1] / "write-config.py")
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


class PrimaryConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.directory = self.root / "configuration"
        self.directory.mkdir(mode=0o700)
        self.revision = "a" * 40
        self.account = SimpleNamespace(pw_uid=123, pw_gid=456)
        self.config = {"dashboard": {"publicBaseUrl": "https://cbte.sprink.cloud/", "clientId": "123456789012345678",
            "clientSecret": "fixture-quote\"-slash\\-dollar$-oauth-secret"}, "errorNotificationURL": "https://notify.example.test/private?a=1&b=2"}
        self.config_path = self.source / "config.json"
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        self.token = "shared-OCI-token-" + "t" * 48
        self.password_hash = "$2b$12$" + "a" * 53
        self.hasher_calls = []

    def save_env(self, name, values):
        path = self.directory / (name + ".env")
        path.write_text(writer.environment_text(values), encoding="utf-8")
        path.chmod(0o600)

    def read(self, name):
        return writer.read_environment(self.directory / (name + ".env"))

    def fake_hasher(self, argv, **kwargs):
        self.hasher_calls.append((argv, kwargs))
        self.assertEqual(argv, [str(Path("/fixture/cbte-admin")), "password-hash"])
        self.assertEqual(kwargs["timeout"], 30)
        return SimpleNamespace(returncode=0, stdout=(self.password_hash + "\n").encode(), stderr=b"")

    def generate(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), mock.patch.object(writer.subprocess, "run", side_effect=self.fake_hasher):
            writer.write_configuration(self.source, self.revision, self.directory, self.account, binary=Path("/fixture/cbte-admin"))
        self.assertEqual(output.getvalue(), "")

    def test_primary_paths_oauth_and_explicit_administrators(self):
        self.save_env("core", {"ADMIN_AGENT_TOKEN": self.token})
        self.generate()
        core = self.read("core")
        self.assertEqual(core["ADMIN_AGENT_TOKEN"], self.token)
        self.assertEqual(core["ADMIN_DISCORD_CLIENT_ID"], self.config["dashboard"]["clientId"])
        self.assertEqual(core["ADMIN_DISCORD_CLIENT_SECRET"], self.config["dashboard"]["clientSecret"])
        self.assertEqual(core["ADMIN_DISCORD_REDIRECT_URI"], "https://cbte.sprink.cloud/ops/auth/discord/callback")
        for name in ["core", "analysis", "reports", "bot"]:
            values = self.read(name)
            self.assertEqual(values["ADMIN_AGENT_TOKEN"], self.token)
            self.assertEqual(values["ADMIN_OWNER_ID"], "796972193287503913")
            self.assertEqual(values["ADMIN_ALLOWED_USER_IDS"], writer.ADMINS)
            self.assertEqual(values["DASHBOARD_ADMIN_USER_IDS"], writer.ADMINS)
        self.assertEqual(core["ADMIN_AGENT_WORKER_DIR"], "/opt/cbte-admin/worker-runtime")
        self.assertEqual(core["ADMIN_AGENT_BOT_UNIT"], "cbte.service")
        self.assertEqual(self.read("analysis")["SAVES_DIR"], "/var/lib/cbte-admin-analysis/saves")
        self.assertEqual(self.read("reports")["ADMIN_ANALYSIS_STATE_DIR"], "/var/lib/cbte-admin-reports")
        self.assertEqual(self.read("executor")["ADMIN_AGENT_EXECUTOR_ALLOWED_UID"], "123")
        self.assertEqual(self.read("bot")["PORT"], "30989")
        self.assertEqual(core["ADMIN_AGENT_PASSWORD_HASH"], self.password_hash)
        if os.name == "posix":
            self.assertTrue(all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in self.directory.iterdir()))

    def test_preserves_only_intended_recovery_fields_per_service(self):
        core_recovery = {"RECOVERY_CONTROLLER_URL": "http://127.0.0.1:34212", "RECOVERY_CONTROLLER_TOKEN": "status-token" * 6,
                         "RECOVERY_INTENT_TOKEN": "intent-token" * 6, "RECOVERY_NODE": "primary"}
        fleet = {"CBTE_FLEET_LEASE_FILE": "/run/cbte-recovery/primary-lease.json", "CBTE_FLEET_NODE": "primary", "CBTE_FLEET_EPOCH": "7"}
        self.save_env("core", {"ADMIN_AGENT_TOKEN": self.token, "ADMIN_AGENT_PASSWORD_HASH": self.password_hash,
            "ADMIN_OWNER_ID": "111111111111111111", "ADMIN_AGENT_WORKER_DIR": "/unexpected/override", "UNRELATED_SECRET": "must-be-discarded", **core_recovery})
        for name in ["analysis", "reports", "bot"]:
            self.save_env(name, {**fleet, **core_recovery, "UNRELATED_SETTING": "discard"})
        self.generate()
        self.assertEqual(len(self.hasher_calls), 0)
        core = self.read("core")
        for key, value in core_recovery.items():
            self.assertEqual(core[key], value)
        self.assertNotIn("UNRELATED_SECRET", core)
        self.assertEqual(core["ADMIN_AGENT_WORKER_DIR"], "/opt/cbte-admin/worker-runtime")
        for name in ["analysis", "reports", "bot"]:
            values = self.read(name)
            for key, value in fleet.items():
                self.assertEqual(values[key], value)
            self.assertNotIn("RECOVERY_INTENT_TOKEN", values)
            self.assertNotIn("RECOVERY_NODE", values)
            self.assertNotIn("UNRELATED_SETTING", values)
            if name != "bot":
                self.assertNotIn("RECOVERY_CONTROLLER_TOKEN", values)
        self.assertEqual(self.read("bot")["RECOVERY_CONTROLLER_TOKEN"], core_recovery["RECOVERY_CONTROLLER_TOKEN"])

    def test_rerun_keeps_password_token_and_recovery_quoted_values(self):
        self.save_env("core", {"ADMIN_AGENT_TOKEN": self.token, "ADMIN_AGENT_PUSH_WEBHOOK": "https://example.test/push?x=a&y=b"})
        self.generate()
        password = (self.directory / "bootstrap-password").read_bytes()
        before = {name: self.read(name) for name in writer.PRESERVE_RECOVERY}
        self.generate()
        self.assertEqual(before, {name: self.read(name) for name in writer.PRESERVE_RECOVERY})
        self.assertEqual(password, (self.directory / "bootstrap-password").read_bytes())
        self.assertEqual(len(self.hasher_calls), 1)

    def test_old_unquoted_and_new_quoted_environment_values_round_trip(self):
        path = self.directory / "legacy.env"
        path.write_text('TOKEN=abc=def#fragment\nHASH=' + self.password_hash + '\nQUOTED="value with spaces"\n', encoding="utf-8")
        self.assertEqual(writer.read_environment(path), {"TOKEN": "abc=def#fragment", "HASH": self.password_hash, "QUOTED": "value with spaces"})
        tricky = {"VALUE": 'quote" apostrophe\' slash\\ dollar$ backtick` equals= hash#'}
        path.write_text(writer.environment_text(tricky), encoding="utf-8")
        self.assertEqual(writer.read_environment(path), tricky)
        for value in ["bad\nINJECTED=1", "bad\0value", "bad\rvalue"]:
            with self.assertRaises(writer.ConfigurationError):
                writer.environment_text({"VALUE": value})

    def test_invalid_preserved_configuration_does_not_overwrite_env_files(self):
        self.save_env("core", {"ADMIN_AGENT_TOKEN": self.token, "ADMIN_AGENT_PASSWORD_HASH": self.password_hash})
        bad = self.directory / "analysis.env"
        bad.write_text('CBTE_FLEET_NODE="unterminated\n', encoding="utf-8")
        before = {path: path.read_bytes() for path in self.directory.iterdir()}
        with self.assertRaises(writer.ConfigurationError):
            self.generate()
        self.assertEqual(before, {path: path.read_bytes() for path in self.directory.iterdir()})

    def test_legacy_root_oauth_fields_are_supported(self):
        self.config["clientId"] = self.config["dashboard"].pop("clientId")
        self.config["clientSecret"] = self.config["dashboard"].pop("clientSecret")
        self.config_path.write_text(json.dumps(self.config), encoding="utf-8")
        self.generate()
        self.assertEqual(self.read("core")["ADMIN_DISCORD_CLIENT_SECRET"], self.config["clientSecret"])


if __name__ == "__main__":
    unittest.main()
