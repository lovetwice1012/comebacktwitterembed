"""Real loopback intent bridge tests; fleet/process mutations remain mocked."""
import copy
import http.client
import json
import threading
from unittest import mock

from recovery import controller, restore_mysql
from recovery.tests.test_controller_restore import RecoveryFixture


class IntentBridgeTests(RecoveryFixture):
    def setUp(self):
        super().setUp()
        self.network_guard.stop()  # This suite explicitly tests its own loopback HTTP server.
        self.config.update(listen="127.0.0.1:0", statusToken="fixture-status-token-at-least32bytes", primaryIntentToken="fixture-primary-push-token-atleast32bytes", ociIntentToken="fixture-oci-push-token-atleast32bytes")
        self.c = controller.Controller(self.config)
        self.server = controller.make_server(self.c, self.config)
        self.server_thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True)
        self.server_thread.start()
        self.addCleanup(self.close_server)
        self.request = {"node": "primary", "desiredState": "stopped", "revision": 2, "actorId": "933314562487386122"}
        self.process_guard = mock.patch.object(controller, "run", side_effect=AssertionError("Intent bridge must never start/stop a unit"))
        self.process_guard.start()
        self.addCleanup(self.process_guard.stop)

    def close_server(self):
        self.c.stop.set()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=1)

    def post(self, value=None, token="primary", raw=None, content_type="application/json"):
        body = raw if raw is not None else json.dumps(self.request if value is None else value).encode()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=2)
        headers = {"Content-Type": content_type}
        if token:
            secret = self.config.get(token + "IntentToken", token)
            headers["Authorization"] = "Bearer " + secret
        try:
            connection.request("POST", "/v1/intent", body, headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_authentication_and_node_roles_are_separate(self):
        for token in (None, "unknown-source-token", self.config["statusToken"]):
            self.assertEqual(self.post(token=token)[0], 401)
        self.assertEqual(self.post(dict(self.request, node="oci"))[0], 403)
        self.assertNotIn("primaryIntent", self.c.state)
        self.assertNotIn("ociIntent", self.c.state)

    def test_exact_schema_actor_and_body_bound_are_enforced(self):
        for field, value in [("node", "third-host"), ("node", []), ("desiredState", "auto"), ("revision", True), ("revision", 0), ("revision", "2"), ("actorId", "111111111111111111"), ("actorId", [])]:
            with self.subTest(field=field, value=value):
                self.assertEqual(self.post(dict(self.request, **{field: value}))[0], 400)
        self.assertEqual(self.post(dict(self.request, armed=True))[0], 400)
        self.assertEqual(self.post(raw=b"[]")[0], 400)
        self.assertEqual(self.post(raw=b'{"node":"primary","node":"oci"}')[0], 400)
        self.assertEqual(self.post(raw=b"x" * 4097)[0], 413)
        self.assertEqual(self.post(content_type="text/plain")[0], 400)

    def test_ack_follows_durable_write_and_exact_retry_is_idempotent(self):
        status, result = self.post()
        self.assertEqual((status, result), (200, {"ok": True, "node": "primary", "desiredState": "stopped", "revision": 2}))
        saved = restore_mysql.read_json(self.c.state_path)["primaryIntent"]
        self.assertEqual(saved["revision"], 2)
        self.assertEqual(saved["desiredState"], "stopped")
        self.assertEqual(self.post(), (status, result))
        self.assertEqual(restore_mysql.read_json(self.c.state_path)["primaryIntent"], saved)
        self.assertNotIn("armed", self.c.state)

    def test_older_or_conflicting_revision_never_overwrites_acknowledged_stop(self):
        self.assertEqual(self.post()[0], 200)
        self.assertEqual(self.post(dict(self.request, revision=1, desiredState="running"))[0], 409)
        self.assertEqual(self.post(dict(self.request, desiredState="running"))[0], 409)
        self.assertEqual(self.c.state["primaryIntent"]["desiredState"], "stopped")

    def test_oci_role_can_record_only_oci_and_second_admin_is_allowed(self):
        self.assertEqual(self.post(dict(self.request, node="oci", actorId="796972193287503913"), token="oci")[0], 200)
        self.assertEqual(self.c.state["ociIntent"]["revision"], 2)
        self.assertNotIn("primaryIntent", self.c.state)

    def test_storage_failure_never_acknowledges_or_poison_retries(self):
        with mock.patch.object(controller, "atomic_json", side_effect=OSError("simulated fsync failure")):
            self.assertEqual(self.post()[0], 503)
        self.assertNotIn("primaryIntent", self.c.state)
        self.assertEqual(self.post()[0], 200)
        self.assertEqual(restore_mysql.read_json(self.c.state_path)["primaryIntent"]["revision"], 2)

    def test_blocked_old_poll_cannot_roll_back_concurrent_acknowledged_push(self):
        entered, release = threading.Event(), threading.Event()
        errors = []
        def policy(node):
            entered.set()
            release.wait(2)
            return {"desiredState": "running", "revision": 1, "maintenanceUntil": ""}
        def poll():
            try: self.c.refresh_operator_intent("primary")
            except Exception as error: errors.append(error)
        with mock.patch.object(self.c, "admin_policy", side_effect=policy):
            worker = threading.Thread(target=poll)
            worker.start()
            self.assertTrue(entered.wait(1))
            try:
                self.assertEqual(self.post()[0], 200)
            finally:
                release.set()
                worker.join(timeout=2)
        self.assertEqual(errors, [])
        self.assertEqual(self.c.state["primaryIntent"]["desiredState"], "stopped")
        self.assertEqual(self.c.state["primaryIntent"]["revision"], 2)
        self.assertEqual(self.c.state["primaryIntent"]["pollState"], "outdated")

    def test_pushed_running_waits_for_full_policy_and_retry_keeps_confirmed_details(self):
        running = dict(self.request, desiredState="running")
        self.assertEqual(self.post(running)[0], 200)
        self.assertFalse(controller.intent_wants_running(self.c.state["primaryIntent"]))
        with mock.patch.object(self.c, "admin_policy", return_value={"desiredState": "running", "revision": 2, "maintenanceUntil": ""}):
            self.c.refresh_operator_intent("primary")
        self.assertTrue(controller.intent_wants_running(self.c.state["primaryIntent"]))
        self.assertEqual(self.post(running)[0], 200)
        self.assertTrue(self.c.state["primaryIntent"]["policyDetailsConfirmed"])

    def test_push_is_durable_while_database_preparation_is_blocked(self):
        self.c.config["autoPrepare"] = True
        self.c.update(candidate=self.candidate, backup=self.source)
        entered, release = threading.Event(), threading.Event()
        policies = {"primary": {"desiredState": "running", "revision": 1, "maintenanceUntil": ""}, "oci": {"desiredState": "running", "revision": 1, "maintenanceUntil": ""}}
        def prepare(): entered.set(); release.wait(2)
        with mock.patch.object(self.c, "authority", return_value=self.authority_state()), mock.patch.object(self.c, "admin_policy", side_effect=lambda node: copy.deepcopy(policies[node])), mock.patch.object(self.c, "prepare_latest", side_effect=prepare), mock.patch.object(self.c, "activate") as activate, mock.patch.object(controller.time, "time", return_value=self.now):
            worker = threading.Thread(target=self.c.tick)
            worker.start()
            self.assertTrue(entered.wait(1))
            try:
                self.assertEqual(self.post()[0], 200)
                self.assertEqual(restore_mysql.read_json(self.c.state_path)["primaryIntent"]["desiredState"], "stopped")
                self.assertTrue(worker.is_alive())
            finally:
                release.set(); worker.join(timeout=2)
        activate.assert_not_called()

    def test_background_observer_runs_independently_of_blocked_preparation(self):
        self.c.config["autoPrepare"] = True
        entered, release, observed = threading.Event(), threading.Event(), threading.Event()
        policies = {"primary": {"desiredState": "running", "revision": 1, "maintenanceUntil": ""}, "oci": {"desiredState": "running", "revision": 1, "maintenanceUntil": ""}}
        def prepare(): entered.set(); release.wait(3)
        original_update = self.c.update
        def update(**changes):
            original_update(**changes)
            if changes.get("primaryIntent", {}).get("revision") == 3:
                observed.set()
        with mock.patch.object(self.c, "authority", return_value=self.authority_state()), mock.patch.object(self.c, "admin_policy", side_effect=lambda node: copy.deepcopy(policies[node])), mock.patch.object(self.c, "prepare_latest", side_effect=prepare), mock.patch.object(self.c, "update", side_effect=update), mock.patch.object(self.c, "activate") as activate, mock.patch.object(controller.time, "time", return_value=self.now):
            worker = threading.Thread(target=self.c.tick)
            worker.start()
            self.assertTrue(entered.wait(1))
            policies["primary"].update(desiredState="stopped", revision=3)
            observer = self.c.start_intent_observer()
            try:
                self.assertTrue(observed.wait(1))
                self.assertTrue(worker.is_alive())
                self.assertEqual(self.c.state["primaryIntent"]["desiredState"], "stopped")
            finally:
                self.c.stop.set(); release.set()
                worker.join(timeout=2); observer.join(timeout=2)
        activate.assert_not_called()
