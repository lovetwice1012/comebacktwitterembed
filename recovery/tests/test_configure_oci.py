import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("configure_oci", Path(__file__).resolve().parents[1] / "configure_oci.py")
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


class ConfigureOCITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "configuration"
        self.directory.mkdir(mode=0o700)
        self.release = self.root / "release-fixture"
        self.release.mkdir(mode=0o700)
        self.node = self.root / "node"
        self.node.write_text("fixture executable")
        self.node.chmod(0o700)
        self.binary = self.root / "cbte-admin"
        self.binary.write_text("fixture executable")
        self.binary.chmod(0o700)
        self.tokens = {role: role + "-" + "t" * 48 for role in ["controller", "primary", "oci"]}
        self.authority = {"tokens": self.tokens, "armed": False}
        self.controller = {"statusToken": "s" * 48, "exporterToken": "e" * 48, "ociIntentToken": "intent-" + "i" * 48,
            "authorityControllerToken": self.tokens["controller"], "authorityUrl": "http://127.0.0.1:34210",
            "exporterUrl": "http://127.0.0.1:33443", "stateDir": str(self.root / "controller-state"),
            "candidateRoot": str(self.root / "candidates"), "runtimeReady": False, "routingReady": False,
            "ociRecipient": "fixture public recipient"}
        self.production = {"token": "fixture-production-bot-token", "dashboard": {"clientId": "123456789012345678",
            "clientSecret": "fixture-oauth-with-quote\"-slash\\-dollar$-secret", "nextAuthSecret": "fixture-next-auth-session-secret"}}
        for name, value in [("authority.json", self.authority), ("controller.json", self.controller), ("bot-config.json", self.production)]:
            self.write_json(name, value)
        self.hasher_calls = []

    def write_json(self, name, value):
        path = self.directory / name
        path.write_text(json.dumps(value), encoding="utf-8")
        path.chmod(0o600)

    def fake_binary(self, argv, **kwargs):
        self.hasher_calls.append((argv, kwargs))
        self.assertEqual(argv, [str(self.binary), "password-hash"])
        self.assertEqual(kwargs["timeout"], 30)
        self.assertTrue(kwargs["input"].endswith(b"\n"))
        self.assertGreaterEqual(len(kwargs["input"].strip()), 14)
        return mock.Mock(returncode=0, stdout=("$2b$12$" + "a" * 53 + "\n").encode(), stderr=b"")

    def run_generator(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), mock.patch.object(configure.subprocess, "run", side_effect=self.fake_binary):
            count = configure.configure(self.release, self.node, self.binary, self.directory)
        self.assertEqual(output.getvalue(), "")
        return count

    def read(self, name):
        return json.loads((self.directory / name).read_text(encoding="utf-8"))

    def environments(self):
        return {name: configure.read_env(self.directory / "admin" / (name + ".env")) for name in ["common", "core", "analysis", "reports", "bot"]}

    def test_complete_configuration_preserves_separation_and_activation_gates(self):
        before = {name: (self.directory / name).read_bytes() for name in ["authority.json", "controller.json", "bot-config.json"]}
        self.assertEqual(self.run_generator(), 10)
        for name, content in before.items():
            self.assertEqual((self.directory / name).read_bytes(), content)
        environments = self.environments()
        token = environments["common"]["ADMIN_AGENT_TOKEN"]
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual({environment["ADMIN_AGENT_TOKEN"] for environment in environments.values()}, {token})
        for environment in environments.values():
            self.assertEqual(environment["ADMIN_OWNER_ID"], configure.OWNER)
            self.assertEqual(environment["ADMIN_ALLOWED_USER_IDS"], configure.ADMINS)
            for secret in self.tokens.values():
                self.assertNotIn(secret, environment.values())
        core = environments["core"]
        self.assertEqual(core["ADMIN_DISCORD_CLIENT_SECRET"], self.production["dashboard"]["clientSecret"])
        self.assertEqual(core["ADMIN_DISCORD_REDIRECT_URI"], "https://cbte-recovery.sprink.cloud/ops/auth/discord/callback")
        self.assertEqual(core["ADMIN_AGENT_STATE_DIR"], str(configure.STATE / "management"))
        self.assertEqual(core["RECOVERY_CONTROLLER_TOKEN"], self.controller["statusToken"])
        self.assertEqual(core["RECOVERY_INTENT_TOKEN"], self.controller["ociIntentToken"])
        self.assertEqual(core["RECOVERY_NODE"], "oci")
        self.assertEqual(core["ADMIN_AGENT_EXECUTOR_SOCKET"], "/run/cbte-admin-executor/executor.sock")
        self.assertEqual(core["ADMIN_AGENT_SERVICE_PROFILE"], "oci-guarded")
        self.assertEqual(environments["bot"]["RECOVERY_CONTROLLER_TOKEN"], self.controller["statusToken"])
        self.assertEqual(core["ADMIN_AGENT_DISCORD_WEBHOOK"], "")
        for name in ["common", "analysis", "reports", "bot"]:
            if name != "bot":
                self.assertNotIn("RECOVERY_CONTROLLER_TOKEN", environments[name])
            self.assertNotIn("RECOVERY_INTENT_TOKEN", environments[name])
            self.assertNotIn("ADMIN_AGENT_PASSWORD_HASH", environments[name])
        workload = self.read("workload.json")
        self.assertTrue(workload["externalAdminCore"])
        self.assertEqual(workload["candidatePointer"], str(Path(self.controller["stateDir"]) / "active-candidate.json"))
        self.assertEqual(workload["candidateRoot"], self.controller["candidateRoot"])
        self.assertEqual(workload["authorityToken"], self.tokens["oci"])
        self.assertEqual(workload["publicMediaLink"], str(configure.STATE / "public-saves-current"))
        guardian = self.read("oci-guardian.json")
        self.assertEqual(guardian["systemdUnit"], "cbte-recovery-workload.service")
        self.assertEqual(guardian["command"], ["/usr/bin/python3", "/opt/cbte-recovery/start_workload.py", "--config", str(self.directory / "workload.json")])
        self.assertEqual(self.read("routing.json")["hostnames"], ["cbte.sprink.cloud", "twidata.sprink.cloud"])
        self.assertEqual(self.read("active-backup.json")["nasRecipient"], configure.NAS_RECIPIENT)
        self.assertEqual(self.read("active-backup.json")["nasToken"], self.controller["exporterToken"])
        self.assertEqual(self.read("active-backup.json")["keepUploadedBackups"], 1)
        self.assertEqual(self.read("active-backup.json")["minimumFreeBytes"], 4 * 1024**3)
        if os.name == "posix":
            for path in self.directory.rglob("*"):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)

    def test_rerun_preserves_management_password_token_and_nextauth(self):
        self.production["dashboard"].pop("nextAuthSecret")
        self.write_json("bot-config.json", self.production)
        self.run_generator()
        before = self.environments()
        password = (self.directory / "bootstrap-password").read_bytes()
        self.assertEqual(self.run_generator(), 9)
        after = self.environments()
        self.assertEqual(before, after)
        self.assertEqual((self.directory / "bootstrap-password").read_bytes(), password)
        self.assertEqual(len(self.hasher_calls), 1)

    def test_conflicting_existing_tokens_do_not_rewrite_files(self):
        self.run_generator()
        analysis = self.directory / "admin/analysis.env"
        env = configure.read_env(analysis)
        env["ADMIN_AGENT_TOKEN"] = "other" * 12
        analysis.write_text(configure.env_text(env), encoding="utf-8")
        snapshot = {path: path.read_bytes() for path in self.directory.rglob("*") if path.is_file()}
        with self.assertRaises(configure.ConfigurationError):
            self.run_generator()
        self.assertEqual(snapshot, {path: path.read_bytes() for path in snapshot})

    def test_rerun_preserves_installed_oci_executor_and_does_not_rewrite_executor_credentials(self):
        self.run_generator()
        core_path = self.directory / "admin/core.env"
        core = configure.read_env(core_path)
        core.update(ADMIN_AGENT_EXECUTOR_SOCKET="/run/cbte-admin-executor/executor.sock", ADMIN_AGENT_SERVICE_PROFILE="oci-guarded")
        core_path.write_text(configure.env_text(core), encoding="utf-8")
        executor = self.directory / "admin/executor.env"
        executor.write_text('ADMIN_AGENT_EXECUTOR_ALLOWED_UID="993"\nADMIN_AGENT_EXECUTOR_GROUP_GID="985"\n', encoding="utf-8")
        executor.chmod(0o600)
        before = executor.read_bytes()
        self.run_generator()
        regenerated = self.environments()["core"]
        self.assertEqual(regenerated["ADMIN_AGENT_EXECUTOR_SOCKET"], core["ADMIN_AGENT_EXECUTOR_SOCKET"])
        self.assertEqual(regenerated["ADMIN_AGENT_SERVICE_PROFILE"], core["ADMIN_AGENT_SERVICE_PROFILE"])
        self.assertEqual(executor.read_bytes(), before)

    def test_existing_bootstrap_is_reused_after_partial_generation(self):
        bootstrap = self.directory / "bootstrap-password"
        bootstrap.write_text("existing-private-bootstrap-password\n", encoding="utf-8")
        bootstrap.chmod(0o600)
        self.run_generator()
        self.assertEqual(self.hasher_calls[0][1]["input"], b"existing-private-bootstrap-password\n")

    def test_hasher_failure_does_not_leak_output_or_generate_configs(self):
        with mock.patch.object(configure.subprocess, "run", return_value=mock.Mock(returncode=1, stdout=b"sensitive token output", stderr=b"private failure")):
            with self.assertRaises(configure.ConfigurationError) as caught:
                configure.configure(self.release, self.node, self.binary, self.directory)
        self.assertNotIn("sensitive", str(caught.exception))
        self.assertNotIn("private failure", str(caught.exception))
        self.assertFalse((self.directory / "bootstrap-password").exists())
        self.assertFalse((self.directory / "workload.json").exists())

    def test_env_round_trip_and_control_character_rejection(self):
        value = {'VALUE': 'quotes" and apostrophe\' backslash\\ dollar$ backtick`'}
        path = self.directory / "quoted.env"
        path.write_text(configure.env_text(value), encoding="utf-8")
        path.chmod(0o600)
        self.assertEqual(configure.read_env(path), value)
        for control in ["\n", "\r", "\0"]:
            with self.assertRaises(configure.ConfigurationError):
                configure.env_text({"VALUE": "secret" + control + "injected"})

    def test_relative_or_symlinked_paths_are_rejected(self):
        with self.assertRaises(configure.ConfigurationError):
            configure.configure(Path("relative"), self.node, self.binary, self.directory)
        link = self.root / "release-link"
        try:
            link.symlink_to(self.release, target_is_directory=True)
        except OSError:
            return
        with self.assertRaises(configure.ConfigurationError):
            configure.configure(link, self.node, self.binary, self.directory)


if __name__ == "__main__":
    unittest.main()
