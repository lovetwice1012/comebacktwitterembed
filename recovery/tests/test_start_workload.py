import copy
from contextlib import contextmanager
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import unittest
from unittest import mock
from types import SimpleNamespace


spec = importlib.util.spec_from_file_location("start_workload", Path(__file__).resolve().parents[1] / "start_workload.py")
workload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workload)


class FakeChild:
    def __init__(self, pid, code=None):
        self.pid, self.code = pid, code
        self.terminated = False
    def poll(self):
        return self.code
    def terminate(self):
        self.terminated, self.code = True, 0
    def wait(self, timeout=None):
        return self.code
    def kill(self):
        self.code = -9


class FakeBackend:
    def __init__(self, candidate):
        self.candidate = candidate
        self.commands, self.spawns = [], []
        self.ports = set()
        self.authority_value = {"activeNode": "oci", "epoch": 5, "serverTime": time.time(), "lease": {"node": "oci", "instanceId": "fixture-guardian", "valid": True, "expiresAt": time.time() + 90}}
        self.info = self.container("none")
        self.fail_bot = False
        self.failed_health = set()
        self.fail_mysql = False
        self.events_error = False
        self.events_value = None
        self.events_tokens = []
        self.bootstrap_complete = True
        self.database_users = {}
    def container(self, network):
        directory = Path(self.candidate["directory"])
        return {"Config": {"Image": self.candidate["mysqlImage"], "Labels": {"cbte.recovery": "true", "cbte.restore-id": self.candidate["id"]}, "Cmd": ["--bind-address=127.0.0.1", "--port=3306", "--mysqlx=OFF", "--event-scheduler=OFF"]}, "HostConfig": {"NetworkMode": network}, "State": {"Running": True}, "Mounts": [{"Type": "bind", "Destination": "/var/lib/mysql", "Source": str(directory / "data"), "RW": True}, {"Type": "bind", "Destination": "/run/cbte-secrets", "Source": str(directory / "secrets"), "RW": False}]}
    def authority(self, url, token):
        return copy.deepcopy(self.authority_value)
    def port_open(self, port):
        return port in self.ports
    def run(self, argv, input=None, timeout=30, optional=False):
        self.commands.append((argv, input))
        if self.fail_mysql and input == b"SELECT 1;":
            raise workload.ActivationError("Fixture MySQL failure")
        if input:
            for operation, user, host, plugin, password in re.findall(r"(CREATE USER IF NOT EXISTS|ALTER USER) '([^']+)'@'([^']+)' IDENTIFIED WITH ([a-z0-9_]+) BY '([a-f0-9]{64})';", input.decode()):
                identity = (user, host)
                value = {"plugin": plugin, "password": password}
                if operation == "CREATE USER IF NOT EXISTS":
                    self.database_users.setdefault(identity, value)
                else:
                    self.database_users[identity] = value
        if argv[1] == "inspect":
            return json.dumps([self.info]) if self.info else None
        if argv[1] == "stop":
            self.info["State"]["Running"] = False
            self.ports.discard(3306)
        elif argv[1] == "rm":
            self.info = None
        elif argv[1] == "run":
            self.info = self.container("host")
            self.ports.add(3306)
        elif argv[1] == "start":
            self.info["State"]["Running"] = True
            self.ports.add(3306)
        return "1\n"
    def spawn(self, argv, cwd, environment, log):
        child = FakeChild(1000 + len(self.spawns), 17 if self.fail_bot and argv[-1].endswith("index.js") else None)
        self.spawns.append((argv, cwd, environment, child))
        if argv[-1].endswith("index.js") and self.bootstrap_complete:
            self.complete_bootstrap(environment)
        return child
    def complete_bootstrap(self, environment):
        directory = Path(environment["CBTE_RECOVERY_BOOTSTRAP_DIR"])
        workload.atomic_json(directory / "bootstrap.json", {"version": 1, "candidateId": environment["CBTE_RECOVERY_BOOTSTRAP_ID"],
            "directory": str(directory), "complete": True, "tables": {kind: {"complete": True} for kind in ["autoextract_targets", "deregister_pending", "error_incidents"]}})
    def health(self, url, token=None):
        return url not in self.failed_health
    def admin_events(self, token):
        self.events_tokens.append(token)
        if self.events_error:
            raise ConnectionError("Fixture core outage")
        if self.events_value is not None:
            return copy.deepcopy(self.events_value)
        bot = next(child for command, _, _, child in self.spawns if command[-1].endswith("index.js"))
        return {"items": [{"kind": "heartbeat", "occurredAt": datetime.fromtimestamp(time.time(), timezone.utc).isoformat(),
                           "payload": {"fleet_node": "oci", "fleet_epoch": "5", "boot_id": "fixture-current-boot",
                                       "details": {"ready": True, "pid": bot.pid}}}]}


class WorkloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cbte-workload-test-")
        self.root = Path(self.temp.name)
        self.identifier = "a" * 24
        self.directory = self.root / "candidates" / self.identifier
        (self.directory / "data").mkdir(parents=True)
        (self.directory / "secrets").mkdir()
        self.private(self.directory / "secrets/client.cnf", "[client]\nuser=root\npassword=fixture-root\n")
        self.private(self.directory / "secrets/root-password", "fixture-root")
        self.candidate = {"id": self.identifier, "container": "cbte-dr-" + self.identifier, "directory": str(self.directory), "manifest": {"source": {"sourceTimestamp": "2026-09-04T17:30:04Z"}}, "mysqlImage": "mysql@sha256:" + "b" * 64, "phase": "VALIDATED", "checks": {"engine": "8.0.42", "eventScheduler": "OFF", "ciphertextVerified": True, "importCompleted": True, "network": "none", "savedataMigrated": False}}
        self.private(self.directory / "receipt.json", json.dumps(self.candidate))
        pointer = self.candidate | {"epoch": 5}
        self.private(self.root / "pointer.json", json.dumps(pointer))
        self.lease = {"version": 1, "node": "oci", "state": "active", "instanceId": "fixture-guardian", "epoch": 5, "validUntilUnixMs": time.time() * 1000 + 60000, "expiresAt": time.time() + 90}
        self.private(self.root / "lease.json", json.dumps(self.lease))
        release = self.root / "release"
        for relative in ["index.js", "src/adminSupport/worker.js", "src/recoveryBootstrap.js", "admin-agent/analysis-server.cjs", "dashboard/package.json"]:
            file = release / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture")
        self.private(self.root / "bot-config.json", json.dumps({"token": "fixture-discord-token", "db": {"host": "old-primary"}}))
        self.private(self.root / "node", "fixture-node")
        self.private(self.root / "admin", "fixture-admin")
        self.env_dir = self.root / "env"
        self.env_dir.mkdir()
        self.private(self.env_dir / "common.env", "ADMIN_AGENT_TOKEN=fixture-management-token-more-than-32-bytes\nADMIN_OWNER_ID=796972193287503913\nDB_HOST=old-primary\nADMIN_AGENT_STATE_DIR=/old-primary/state\n")
        self.config = {"candidatePointer": str(self.root / "pointer.json"), "candidateRoot": str(self.root / "candidates"), "releaseDir": str(release), "nodePath": str(self.root / "node"), "botConfigPath": str(self.root / "bot-config.json"), "authorityUrl": "http://127.0.0.1:34210", "authorityToken": "fixture-oci-authority-token-more-than32", "leaseFile": str(self.root / "lease.json"), "adminBinary": str(self.root / "admin"), "adminConfigDir": str(self.env_dir), "publicUrl": "https://fixture.invalid", "runtimeRoot": str(self.root / "runtime")}
        self.environment = {"CBTE_FLEET_NODE": "oci", "CBTE_FLEET_EPOCH": "5", "CBTE_FLEET_LEASE_FILE": self.config["leaseFile"], "RECOVERY_OCI_TOKEN": self.config["authorityToken"]}
        self.backend = FakeBackend(self.candidate)
        self.wrapper = workload.Workload(self.config, self.backend, self.environment)

    def tearDown(self):
        for log in self.wrapper.logs:
            if not log.closed:
                log.close()
        self.temp.cleanup()

    def private(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
        os.chmod(path, 0o600)

    def prepare(self):
        self.wrapper.load_candidate()
        self.wrapper.authority_check()
        self.wrapper.prepare_runtime()
        return self.wrapper.activate_database()

    @contextmanager
    def media_links(self, previous=None, owner=0):
        public_root = self.root / "public"
        public_root.mkdir(mode=0o700, exist_ok=True)
        link = public_root / "public-saves-current"
        self.config["publicMediaLink"] = str(link)
        links = {} if previous is None else {str(link): {"target": str(previous), "owner": owner}}
        original_lstat, original_unlink = Path.lstat, Path.unlink
        original_readlink, original_replace = os.readlink, os.replace
        def lstat(filename, *args, **kwargs):
            item = links.get(str(filename))
            return SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=item["owner"]) if item else original_lstat(filename, *args, **kwargs)
        def unlink(filename, *args, **kwargs):
            if str(filename) in links:
                del links[str(filename)]
            else:
                original_unlink(filename, *args, **kwargs)
        def symlink(target, filename, **_kwargs):
            links[str(filename)] = {"target": str(target), "owner": 0}
        def readlink(filename, *args, **kwargs):
            item = links.get(str(filename))
            return item["target"] if item else original_readlink(filename, *args, **kwargs)
        def replace(source, destination):
            if str(source) in links:
                links[str(destination)] = links.pop(str(source))
            else:
                original_replace(source, destination)
        # Simulate POSIX symlink ownership on Windows without granting real ACLs
        # or requiring Windows symlink privilege. Target directories are real
        # isolated fixtures and still pass the production path/marker checks.
        with mock.patch.object(workload, "PUBLIC_MEDIA_ROOT", public_root), \
                mock.patch.object(Path, "lstat", lstat), mock.patch.object(Path, "unlink", unlink), \
                mock.patch.object(workload.os, "symlink", symlink), mock.patch.object(workload.os, "readlink", readlink), \
                mock.patch.object(workload.os, "replace", replace):
            workload.validate_config(self.config)
            yield link, links

    def test_no_database_activation_without_matching_live_oci_lease(self):
        self.backend.authority_value["activeNode"] = "primary"
        self.assertEqual(self.wrapper.run(), 1)
        self.assertEqual(self.backend.commands, [])
        self.assertEqual(self.backend.spawns, [])

    def test_expired_lease_and_candidate_path_escape_fail_before_docker(self):
        self.lease["validUntilUnixMs"] = time.time() * 1000 - 1
        self.private(Path(self.config["leaseFile"]), json.dumps(self.lease))
        self.assertEqual(self.wrapper.run(), 1)
        self.assertEqual(self.backend.commands, [])
        pointer = self.candidate | {"directory": str(self.root / "outside"), "epoch": 5}
        self.private(Path(self.config["candidatePointer"]), json.dumps(pointer))
        with self.assertRaises(workload.ActivationError):
            self.wrapper.load_candidate()

    def test_only_owned_candidate_is_recreated_on_loopback_and_original_data_is_preserved(self):
        (self.directory / "data/fixture.ibd").write_bytes(b"preserved")
        credentials = self.prepare()
        commands = [entry[0] for entry in self.backend.commands]
        create = next(command for command in commands if command[1] == "run")
        self.assertEqual(create[create.index("--network") + 1], "host")
        for flag in ["--bind-address=127.0.0.1", "--port=3306", "--mysqlx=OFF", "--event-scheduler=OFF", "--super-read-only=ON"]:
            self.assertIn(flag, create)
        self.assertFalse(any(command[1:3] == ["rm", "-v"] for command in commands))
        self.assertEqual((self.directory / "data/fixture.ibd").read_bytes(), b"preserved")
        sql = b"\n".join(data for _, data in self.backend.commands if data)
        self.assertIn(b"GRANT ALL PRIVILEGES ON ComebackTwitterEmbed.*", sql)
        self.assertNotIn(b"GRANT ALL PRIVILEGES ON *.*", sql)
        self.assertNotIn(credentials["password"], json.dumps(commands))
        self.assertTrue((self.wrapper.runtime / "database-user.json").exists())

    def test_foreign_container_or_occupied_mysql_port_is_never_stopped(self):
        self.wrapper.load_candidate(); self.wrapper.prepare_runtime()
        self.backend.info["Config"]["Labels"]["cbte.restore-id"] = "foreign"
        with self.assertRaises(workload.ActivationError):
            self.wrapper.activate_database()
        self.assertTrue(all(command[0][1] == "inspect" for command in self.backend.commands))
        self.backend.commands.clear()
        self.backend.info = self.backend.container("none")
        self.backend.ports.add(3306)
        with self.assertRaises(workload.ActivationError):
            self.wrapper.activate_database()
        self.assertTrue(all(command[0][1] == "inspect" for command in self.backend.commands))

    def test_reentry_reuses_same_host_candidate_and_credentials_without_reimport(self):
        first = self.prepare()
        self.backend.commands.clear()
        second = workload.Workload(self.config, self.backend, self.environment)
        second.load_candidate(); second.prepare_runtime()
        credentials = second.activate_database()
        self.assertEqual(credentials["password"], first["password"])
        self.assertFalse(any(command[0][1] in {"run", "stop", "rm"} for command in self.backend.commands))
        self.assertFalse(any("age" in argument or "zstd" in argument for command, _ in self.backend.commands for argument in command))

    def test_recovery_account_creation_and_reentry_use_the_production_driver_supported_plugin(self):
        credentials = self.prepare()
        account = ("cbte_oci", "127.0.0.1")
        self.assertEqual(self.backend.database_users[account], {"plugin": "mysql_native_password", "password": credentials["password"]})
        # A restored/existing account may have MySQL 8's incompatible default.
        # IF NOT EXISTS alone would leave this account unusable by mysql@2.18.1.
        self.backend.database_users[account] = {"plugin": "caching_sha2_password", "password": "old"}
        self.backend.commands.clear()
        retry = workload.Workload(self.config, self.backend, self.environment)
        retry.load_candidate(); retry.prepare_runtime()
        repeated = retry.activate_database()
        self.assertEqual(repeated["password"], credentials["password"])
        self.assertEqual(self.backend.database_users[account], {"plugin": "mysql_native_password", "password": credentials["password"]})
        self.assertEqual(set(self.backend.database_users), {account})
        sql = b"\n".join(value for _, value in self.backend.commands if value)
        self.assertNotIn(b"default_authentication_plugin", sql)
        self.assertNotIn(b"GRANT ALL PRIVILEGES ON *.*", sql)

    def test_fresh_oci_state_and_forced_environment_do_not_replay_primary_jobs(self):
        credentials = self.prepare()
        environments = self.wrapper.environments(credentials)
        for environment in environments.values():
            self.assertEqual(environment["DB_HOST"], "127.0.0.1")
            self.assertEqual(environment["CBTE_FLEET_NODE"], "oci")
            self.assertNotIn("RECOVERY_OCI_TOKEN", environment)
            self.assertNotEqual(environment["ADMIN_AGENT_STATE_DIR"], "/old-primary/state")
        self.assertNotEqual(environments["interactive"]["ADMIN_ANALYSIS_STATE_DIR"], environments["reports"]["ADMIN_ANALYSIS_STATE_DIR"])
        self.assertEqual(environments["reports"]["ADMIN_ANALYSIS_ACTIONS"], "reports.build")
        self.assertEqual(list((self.wrapper.runtime / "saves").iterdir()), [])
        self.assertEqual(list((self.wrapper.runtime / "admin").iterdir()), [])
        self.assertEqual(environments["bot"]["CBTE_RECOVERY_BOOTSTRAP_ID"], self.identifier)
        self.assertEqual(environments["bot"]["CBTE_RECOVERY_BOOTSTRAP_DIR"], str(self.wrapper.runtime / "bootstrap"))
        self.assertEqual(list((self.wrapper.runtime / "bootstrap").iterdir()), [])
        self.assertTrue(all("CBTE_RECOVERY_BOOTSTRAP_ID" not in environments[name] for name in ["core", "interactive", "reports"]))
        self.wrapper.install_bot_config(credentials)
        installed = json.loads((Path(self.config["releaseDir"]) / "config.json").read_text())
        self.assertEqual(installed["db"]["host"], "127.0.0.1")

    def test_unmarked_copied_administrator_state_is_rejected(self):
        self.wrapper.load_candidate()
        target = Path(self.config["runtimeRoot"]) / self.identifier / "admin"
        target.mkdir(parents=True)
        (target / "old-primary.sqlite").write_bytes(b"old jobs")
        with self.assertRaises(workload.ActivationError):
            self.wrapper.prepare_runtime()

    def test_child_failure_stops_group_children_and_fences_database_read_only(self):
        self.backend.fail_bot = True
        self.assertEqual(self.wrapper.run(), 1)
        self.assertEqual(len(self.backend.spawns), 4)
        self.assertTrue(all(child.poll() is not None for *_, child in self.backend.spawns))
        last_sql = [data for _, data in self.backend.commands if data][-1]
        self.assertIn(b"SET GLOBAL super_read_only=ON", last_sql)
        state = json.loads((self.directory / "receipt.json").read_text())
        self.assertEqual(state["phase"], "ACTIVATION_FAILED")

    def test_subprocess_launch_does_not_create_detached_process_groups(self):
        with mock.patch.object(workload.subprocess, "Popen") as popen:
            workload.Backend().spawn(["node", "index.js"], "/fixture", {"KEY": "value"}, None)
        self.assertFalse(popen.call_args.kwargs["start_new_session"])
        self.assertNotIn("shell", popen.call_args.kwargs)

    def test_external_core_is_not_spawned_and_its_occupied_port_is_preserved(self):
        self.config["externalAdminCore"] = True
        self.backend.ports.add(30988)
        credentials = self.prepare()
        self.wrapper.start_children(self.wrapper.environments(credentials))
        self.assertEqual([name for name, _ in self.wrapper.children], ["interactive", "reports", "bot"])
        self.assertFalse(any(command == [self.config["adminBinary"]] for command, *_ in self.backend.spawns))
        self.assertIn(30988, self.backend.ports)
        with self.assertRaises(workload.ActivationError):
            workload.Workload(self.config | {"externalAdminCore": "true"}, self.backend, self.environment)

    def test_gateway_evidence_rejects_wrong_instance_epoch_pid_stale_or_unready_events(self):
        credentials = self.prepare()
        self.wrapper.start_children(self.wrapper.environments(credentials))
        now = time.time() + 1
        self.wrapper.bot_spawned_at = now - 10
        valid = self.backend.admin_events("fixture-token")
        valid["items"][0]["occurredAt"] = datetime.fromtimestamp(now - 1, timezone.utc).isoformat()
        cases = [
            ("payload.details.ready", False), ("payload.details.ready", "true"),
            ("payload.details.pid", 2), ("payload.details.pid", str(valid["items"][0]["payload"]["details"]["pid"])),
            ("payload.fleet_node", "primary"), ("payload.fleet_epoch", "4"), ("payload.fleet_epoch", True),
            ("payload.boot_id", ""), ("kind", "request.complete"),
            ("occurredAt", datetime.fromtimestamp(now - 11, timezone.utc).isoformat()),
            ("occurredAt", datetime.fromtimestamp(now + 1, timezone.utc).isoformat()),
            ("occurredAt", "2026-09-06T10:00:00"),
        ]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                event = copy.deepcopy(valid)
                target = event["items"][0]
                keys = field.split(".")
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                self.backend.events_value = event
                self.assertIsNone(self.wrapper.gateway_readiness("fixture-token", now=now))
        self.wrapper.bot_spawned_at = now - 100
        self.backend.events_value = copy.deepcopy(valid)
        self.backend.events_value["items"][0]["occurredAt"] = datetime.fromtimestamp(now - 46, timezone.utc).isoformat()
        self.assertIsNone(self.wrapper.gateway_readiness("fixture-token", now=now))
        self.backend.events_value = valid
        proof = self.wrapper.gateway_readiness("fixture-token", now=now)
        self.assertEqual(proof["botPid"], self.wrapper.children[-1][1].pid)
        self.assertEqual(proof["bootId"], "fixture-current-boot")
        self.assertEqual(proof["gatewayReadyAt"], valid["items"][0]["occurredAt"])

    def test_first_activation_waits_for_current_gateway_proof_and_persists_receipt(self):
        self.config["externalAdminCore"] = True
        self.backend.events_value = {"items": []}
        observations = []
        def tick(_seconds):
            observations.append(self.wrapper.activated)
            if len(observations) == 1:
                self.assertFalse(self.wrapper.activated)
                self.backend.events_value = None
            else:
                receipt = json.loads((self.directory / "receipt.json").read_text())
                activation = json.loads((self.wrapper.runtime / "activation.json").read_text())
                self.assertTrue(self.wrapper.activated)
                self.assertEqual(receipt["phase"], "ACTIVE")
                self.assertFalse(receipt["observabilityDegraded"])
                self.assertTrue(receipt["bootstrapComplete"])
                self.assertEqual(receipt["botPid"], self.wrapper.children[-1][1].pid)
                self.assertEqual(receipt["bootId"], "fixture-current-boot")
                self.assertEqual(receipt["gatewayReadyAt"], activation["gatewayReadyAt"])
                self.assertTrue(receipt["botSpawnedAt"])
                self.assertTrue(receipt["gatewayProofVerifiedAt"])
                self.wrapper.stop_event.set()
        with mock.patch.object(self.wrapper.stop_event, "wait", side_effect=tick):
            self.assertEqual(self.wrapper.run(), 0)
        self.assertEqual(observations, [False, True])
        self.assertTrue(all(token == "fixture-management-token-more-than-32-bytes" for token in self.backend.events_tokens))

    def test_external_core_missing_before_activation_never_produces_active_receipt(self):
        self.config.update(externalAdminCore=True, startupTimeoutSeconds=30)
        self.backend.events_error = True
        with mock.patch.object(workload.time, "monotonic", side_effect=[0, 0, 31, 32]):
            self.assertEqual(self.wrapper.run(), 1)
        receipt = json.loads((self.directory / "receipt.json").read_text())
        self.assertFalse(self.wrapper.activated)
        self.assertEqual(receipt["phase"], "ACTIVATION_FAILED")
        self.assertNotIn("gatewayReadyAt", receipt)

    def test_gateway_ready_does_not_activate_without_live_database_probe(self):
        self.config.update(externalAdminCore=True, startupTimeoutSeconds=30)
        def endpoint_health(_url, token=None):
            # Provisioning succeeded, then MySQL became unavailable before the
            # first application health check; a ready event alone is insufficient.
            self.backend.fail_mysql = True
            return True
        self.backend.health = endpoint_health
        with mock.patch.object(workload.time, "monotonic", side_effect=[0, 0, 31, 32]):
            self.assertEqual(self.wrapper.run(), 1)
        self.assertIsNotNone(self.wrapper.gateway_proof)
        self.assertFalse(self.wrapper.activated)
        self.assertEqual(json.loads((self.directory / "receipt.json").read_text())["phase"], "ACTIVATION_FAILED")

    def test_external_core_outage_after_verified_activation_keeps_bot_running(self):
        self.config["externalAdminCore"] = True
        iterations = []
        def tick(_seconds):
            iterations.append(self.wrapper.activated)
            self.assertTrue(self.wrapper.activated)
            self.assertTrue(all(child.poll() is None for _, child in self.wrapper.children))
            if len(iterations) == 1:
                self.backend.events_error = True
            else:
                receipt = json.loads((self.directory / "receipt.json").read_text())
                self.assertEqual(receipt["phase"], "ACTIVE")
                self.assertTrue(receipt["observabilityDegraded"])
                self.assertEqual(receipt["bootId"], "fixture-current-boot")
            if len(iterations) == 5:
                self.wrapper.stop_event.set()
        with mock.patch.object(self.wrapper.stop_event, "wait", side_effect=tick):
            self.assertEqual(self.wrapper.run(), 0)
        self.assertEqual(len(iterations), 5)

    def test_gateway_proof_waits_for_candidate_bootstrap_completion_before_active(self):
        self.config["externalAdminCore"] = True
        self.backend.bootstrap_complete = False
        observed = []
        def tick(_seconds):
            observed.append(self.wrapper.activated)
            self.assertIsNotNone(self.wrapper.gateway_proof)
            if len(observed) == 1:
                self.assertFalse(self.wrapper.activated)
                self.assertFalse(self.wrapper.bootstrap_verified)
                bot_environment = next(environment for command, _, environment, _ in self.backend.spawns if command[-1].endswith("index.js"))
                self.backend.complete_bootstrap(bot_environment)
            else:
                self.assertTrue(self.wrapper.activated)
                self.assertTrue(self.wrapper.bootstrap_verified)
                self.assertTrue(json.loads((self.directory / "receipt.json").read_text())["bootstrapComplete"])
                self.wrapper.stop_event.set()
        with mock.patch.object(self.wrapper.stop_event, "wait", side_effect=tick):
            self.assertEqual(self.wrapper.run(), 0)
        self.assertEqual(observed, [False, True])

    def test_incomplete_foreign_or_malformed_bootstrap_receipts_cannot_authorize_activation(self):
        self.prepare()
        directory = self.wrapper.runtime / "bootstrap"
        good = {"version": 1, "candidateId": self.identifier, "directory": str(directory), "complete": True,
                "tables": {kind: {"complete": True} for kind in ["autoextract_targets", "deregister_pending", "error_incidents"]}}
        self.assertFalse(self.wrapper.bootstrap_ready())
        for value in [good | {"complete": False}, good | {"complete": 1}, good | {"candidateId": "b" * 24},
                      good | {"directory": str(self.root / "foreign")}, good | {"tables": {}}]:
            self.private(directory / "bootstrap.json", json.dumps(value))
            self.assertFalse(self.wrapper.bootstrap_ready())
        self.private(directory / "bootstrap.json", json.dumps(good))
        self.assertTrue(self.wrapper.bootstrap_ready())
        self.private(directory / "bootstrap.json", "{broken")
        self.assertFalse(self.wrapper.bootstrap_ready())

    def test_public_media_link_publishes_only_current_saves_with_scoped_acl_commands(self):
        self.prepare()
        self.backend.commands.clear()
        with self.media_links() as (link, links):
            self.wrapper.prepare_public_media()
            self.assertEqual(links[str(link)], {"target": str(self.wrapper.runtime / "saves"), "owner": 0})
        commands = [argv for argv, _ in self.backend.commands]
        self.assertEqual(commands[0], ["setfacl", "-m", "u:www-data:--x", "--", self.config["runtimeRoot"], str(self.wrapper.runtime)])
        self.assertEqual(commands[1], ["setfacl", "-R", "-P", "-m", "u:www-data:rX", "--", str(self.wrapper.runtime / "saves")])
        self.assertEqual(commands[2][0:4], ["find", str(self.wrapper.runtime / "saves"), "-type", "d"])
        self.assertIn("d:u:www-data:r-x", commands[2])
        for private in ["admin", "interactive", "reports", "support", "logs", "telemetry", "bootstrap"]:
            self.assertTrue(all(str(self.wrapper.runtime / private) not in argv for argv in commands))
        self.assertEqual(list((self.wrapper.runtime / "saves").iterdir()), [])

    def test_public_media_retarget_requires_owned_candidate_receipt_and_preserves_previous_saves(self):
        self.prepare()
        old = Path(self.config["runtimeRoot"]) / ("b" * 24)
        (old / "saves").mkdir(parents=True)
        (old / "saves" / "keep.txt").write_text("old public media remains on disk")
        self.private(old / "oci-state-origin.json", json.dumps({"candidateId": old.name, "origin": "fresh-oci-state", "savedataMigrated": False}))
        with self.media_links(previous=old / "saves") as (link, links):
            self.wrapper.prepare_public_media()
            self.assertEqual(links[str(link)]["target"], str(self.wrapper.runtime / "saves"))
        self.assertTrue((old / "saves" / "keep.txt").exists())
        self.assertEqual(list((self.wrapper.runtime / "saves").iterdir()), [])

    def test_public_media_refuses_foreign_links_and_never_overwrites_real_files_or_directories(self):
        self.prepare()
        self.backend.commands.clear()
        for previous, owner in [(self.wrapper.runtime / "saves", 999), (self.root / "foreign", 0), (self.wrapper.runtime / "admin", 0)]:
            with self.subTest(previous=previous, owner=owner), self.media_links(previous=previous, owner=owner) as (link, links):
                with self.assertRaises(workload.ActivationError):
                    self.wrapper.prepare_public_media()
                self.assertEqual(links[str(link)]["target"], str(previous))
        self.assertEqual(self.backend.commands, [])
        with self.media_links() as (link, _):
            link.mkdir()
            (link / "keep.txt").write_text("preserve")
            with self.assertRaises(workload.ActivationError):
                self.wrapper.prepare_public_media()
            self.assertEqual((link / "keep.txt").read_text(), "preserve")
            (link / "keep.txt").unlink()
            link.rmdir()
            link.write_text("real file")
            with self.assertRaises(workload.ActivationError):
                self.wrapper.prepare_public_media()
            self.assertEqual(link.read_text(), "real file")
        self.assertEqual(self.backend.commands, [])

    def test_public_media_config_rejects_outside_root_traversal_and_root_itself(self):
        public_root = self.root / "public"
        with mock.patch.object(workload, "PUBLIC_MEDIA_ROOT", public_root):
            for value in ["relative", str(self.root / "outside"), str(public_root), str(public_root / ".." / "outside")]:
                with self.subTest(value=value), self.assertRaises(workload.ActivationError):
                    workload.validate_config(self.config | {"publicMediaLink": value})

    def test_public_media_refuses_managed_looking_link_without_matching_origin_receipt(self):
        self.prepare()
        old = Path(self.config["runtimeRoot"]) / ("b" * 24)
        (old / "saves").mkdir(parents=True)
        self.backend.commands.clear()
        with self.media_links(previous=old / "saves"):
            with self.assertRaises(workload.ActivationError):
                self.wrapper.prepare_public_media()
            self.private(old / "oci-state-origin.json", json.dumps({"candidateId": "c" * 24, "origin": "fresh-oci-state", "savedataMigrated": False}))
            with self.assertRaises(workload.ActivationError):
                self.wrapper.prepare_public_media()
        self.assertEqual(self.backend.commands, [])

    def test_external_core_does_not_hide_worker_dashboard_or_database_failure(self):
        self.config["externalAdminCore"] = True
        # Each subcase runs against the same owned candidate after its previous
        # workload has fully stopped; no primary state or live service is used.
        for failed in ["http://127.0.0.1:30990/health", "http://127.0.0.1:30991/health", "http://127.0.0.1:30989/api/health", "mysql"]:
            with self.subTest(failed=failed):
                self.backend = FakeBackend(self.candidate)
                self.wrapper = workload.Workload(self.config, self.backend, self.environment)
                ticks = []
                def tick(_seconds):
                    ticks.append(1)
                    self.assertTrue(self.wrapper.activated)
                    self.assertLess(len(ticks), 5)
                    self.backend.events_error = True
                    if failed == "mysql":
                        self.backend.fail_mysql = True
                    else:
                        self.backend.failed_health.add(failed)
                with mock.patch.object(self.wrapper.stop_event, "wait", side_effect=tick):
                    self.assertEqual(self.wrapper.run(), 1)
                self.assertTrue(self.wrapper.activated)
                self.assertEqual(len(ticks), 3)
                self.assertTrue(all(child.poll() is not None for _, child in self.wrapper.children))
                self.assertEqual(json.loads((self.directory / "receipt.json").read_text())["phase"], "ACTIVATION_FAILED")

    def test_current_guardian_environment_is_rechecked_after_activation(self):
        self.config["externalAdminCore"] = True
        def tick(_seconds):
            self.assertTrue(self.wrapper.activated)
            self.wrapper.environment["CBTE_FLEET_EPOCH"] = "6"
        with mock.patch.object(self.wrapper.stop_event, "wait", side_effect=tick):
            self.assertEqual(self.wrapper.run(), 1)
        self.assertTrue(self.wrapper.activated)
        self.assertTrue(all(child.poll() is not None for _, child in self.wrapper.children))

    def test_admin_events_api_uses_service_authentication_and_bounded_nonredirecting_request(self):
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b'{"items": []}'
        opener = mock.MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with mock.patch.object(workload.urllib.request, "build_opener", return_value=opener) as build:
            self.assertEqual(workload.Backend().admin_events("fixture-service-token"), {"items": []})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:30988/v1/events?kind=heartbeat&limit=1")
        self.assertEqual(request.get_header("X-admin-agent-token"), "fixture-service-token")
        self.assertIn(workload.NoRedirect, build.call_args.args)
        self.assertEqual(build.call_args.args[0].proxies, {})
        response.read.assert_called_once_with(262145)

    def test_read_lease_accepts_public_readonly_mode_and_rejects_nan_expiry(self):
        path = Path(self.config["leaseFile"])
        os.chmod(path, 0o644)
        self.assertEqual(workload.read_lease(path)["epoch"], 5)
        self.lease["validUntilUnixMs"] = float("nan")
        self.private(path, json.dumps(self.lease))
        with self.assertRaises(workload.ActivationError):
            self.wrapper.guardian_lease_check()


if __name__ == "__main__":
    unittest.main()
