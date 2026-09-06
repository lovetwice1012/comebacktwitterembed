"""Explicit operator emergency approvals; all host/authority mutations are mocked."""
import copy
import http.client
import json
from pathlib import Path
import threading
from unittest import mock

from recovery import controller, manual_activation, restore_mysql
from recovery.tests.test_controller_restore import RecoveryFixture


class ManualApprovalTests(RecoveryFixture):
    def setUp(self):
        super().setUp()
        self.config.update(ociStandbyPolicyRevision=7, statusToken="s" * 48, primaryIntentToken="p" * 48, ociIntentToken="o" * 48, listen="127.0.0.1:0")
        self.c = controller.Controller(self.config)
        candidate = copy.deepcopy(self.candidate)
        candidate.update(directory=str(Path(self.config["candidateRoot"]) / candidate["id"]), mysqlImage=self.config["mysqlImage"])
        candidate["checks"].update(ciphertextVerified=True, importCompleted=True)
        self.candidate = candidate
        restore_mysql.atomic_json(Path(candidate["directory"]) / "receipt.json", candidate)
        restore_mysql.atomic_json(self.c.root / "prepared-candidate.json", candidate)
        self.primary = {"desiredState": "maintenance", "revision": 3, "observationState": "stale", "fetchedAt": self.iso(self.now - 600)}
        self.oci = {"desiredState": "maintenance", "revision": 7, "observationState": "fresh", "fetchedAt": self.iso(self.now)}
        self.c.update(phase="STANDBY_READY", candidate=candidate, backup=self.source, primaryIntent=self.primary, ociIntent=self.oci)
        self.a = self.authority_state()
        for patch in [mock.patch.object(self.c, "authority", side_effect=lambda: copy.deepcopy(self.a)), mock.patch.object(self.c, "refresh_operator_intent", side_effect=lambda node: self.c.state[node + "Intent"]), mock.patch.object(manual_activation.time, "time", side_effect=lambda: self.now)]:
            patch.start(); self.addCleanup(patch.stop)
        self.body = {"approvalId": "a" * 48, "actorId": "796972193287503913", "expectedEpoch": 1, "candidateId": candidate["id"], "backupId": self.source["backupId"], "backupSha256": self.source["sourceSha256"], "sourceTimestamp": self.source["sourceTimestamp"], "expectedPrimaryIntentRevision": 3, "expectedPrimaryIntentState": "maintenance", "expectedOciPolicyRevision": 7, "reason": "Primary did not return after authorized reboot", "acceptBackupRollback": True, "acceptMissingSavedata": True, "acceptPrimaryIntentOverride": True}

    def approve(self, body=None):
        return self.c.manual_approvals.approve("oci", body or self.body)["approval"]

    def test_durable_approval_changes_only_primary_intent_gate(self):
        before = copy.deepcopy(self.c.state["primaryIntent"])
        receipt = self.approve()
        self.assertEqual(self.c.state["primaryIntent"], before)
        self.assertEqual(receipt["expiresAt"] - receipt["createdAt"], 600)
        self.assertTrue(receipt["doesNotArm"])
        manual = self.c.manual_approvals.current(self.a)
        normal = controller.promotion_gates(self.a, self.source, self.candidate, self.config, self.primary, self.oci)
        approved = controller.promotion_gates(self.a, self.source, self.candidate, self.config, self.primary, self.oci, manual)
        changed = [left["code"] for left, right in zip(normal, approved) if left["ready"] != right["ready"]]
        self.assertEqual(changed, ["PRIMARY_OPERATOR_RUNNING"])
        saved = restore_mysql.read_json(self.c.manual_approvals.path(self.body["approvalId"]))
        self.assertEqual(saved["history"][0]["actorId"], self.body["actorId"])

    def test_approval_never_arms_or_overrides_other_promotion_gates(self):
        self.a["armed"] = False
        self.approve()
        with mock.patch.object(self.c, "activate") as activate, mock.patch.object(controller, "request_json") as network:
            self.c.tick()
        activate.assert_not_called(); network.assert_not_called()
        self.assertFalse(self.a["armed"])
        manual = self.c.manual_approvals.current(self.a)
        for code, authority, config in [
            ("PRIMARY_ENROLLED", self.a | {"primaryEnrolled": False}, self.config),
            ("OLD_LEASE_EXPIRED", self.a | {"lease": {"valid": True, "expiresAt": self.now + 30}}, self.config),
            ("LEASE_DRAIN_COMPLETE", self.a | {"drainUntil": self.now + 1}, self.config),
            ("RUNTIME_PREPARED", self.a, self.config | {"runtimeReady": False}),
            ("ROUTING_PREPARED", self.a, self.config | {"routingReady": False}),
        ]:
            gates = controller.promotion_gates(authority, self.source, self.candidate, config, self.primary, self.oci, manual)
            self.assertFalse(next(item for item in gates if item["code"] == code)["ready"])

    def test_no_approval_leaves_manual_stop_authoritative(self):
        with mock.patch.object(controller, "request_json") as network:
            self.c.activate(self.a)
        network.assert_not_called()
        self.assertEqual(self.c.state["primaryIntent"], self.primary)

    def test_expiry_idempotency_and_conflicting_input_do_not_extend_authorization(self):
        receipt = self.approve()
        self.assertEqual(self.approve()["expiresAt"], receipt["expiresAt"])
        with self.assertRaises(manual_activation.ApprovalError): self.approve(self.body | {"reason": "another reason"})
        with self.assertRaises(manual_activation.ApprovalError): self.approve(self.body | {"approvalId": "b" * 48})
        self.now += 601
        self.assertIsNone(self.c.manual_approvals.current(self.a))
        self.assertEqual(self.approve()["state"], "expired")
        self.assertEqual(self.approve()["expiresAt"], receipt["expiresAt"])

    def test_changed_primary_or_oci_operator_revision_invalidates_unused_approval(self):
        for node in ("primary", "oci"):
            with self.subTest(node=node):
                self.body["approvalId"] = ("a" if node == "primary" else "b") * 48
                self.c.update(primaryIntent=self.primary, ociIntent=self.oci)
                self.approve()
                self.c.update(**{node + "Intent": self.c.state[node + "Intent"] | {"revision": 99}})
                self.assertIsNone(self.c.manual_approvals.current(self.a))
                self.assertEqual(self.c.state["manualEmergencyApproval"]["state"], "invalidated")

    def test_candidate_or_validation_change_prevents_reservation(self):
        self.approve()
        receipt = copy.deepcopy(self.candidate); receipt["checks"]["importCompleted"] = False
        restore_mysql.atomic_json(Path(receipt["directory"]) / "receipt.json", receipt)
        self.assertIsNone(self.c.manual_approvals.current(self.a, reserve=True))
        self.assertEqual(self.c.state["manualEmergencyApproval"]["state"], "invalidated")

    def test_reservation_consumption_and_controller_oci_seed_cas_remain_one_attempt(self):
        self.approve()
        def promote(base, token, path, body=None, **_):
            self.assertEqual(path, "/v1/promote")
            self.assertEqual(self.c.state["manualEmergencyApproval"]["state"], "reserved")
            self.assertTrue(body["idempotencyKey"].endswith(self.body["approvalId"]))
            self.a.update(activeNode="oci", epoch=2)
            return {"ok": True, "epoch": 2}
        def own_cas(*_): self.c.update(ociIntent=self.oci | {"desiredState": "running", "revision": 8})
        with mock.patch.object(controller, "request_json", side_effect=promote) as network, mock.patch.object(self.c, "reconcile_oci_workload", side_effect=own_cas):
            self.c.activate(self.a)
        self.assertEqual(network.call_count, 1)
        self.assertEqual(self.c.state["manualEmergencyApproval"]["state"], "consumed")
        self.assertEqual(self.c.state["primaryIntent"], self.primary)
        self.assertIsNone(self.c.manual_approvals.current(self.authority_state()))

    def test_lost_promotion_reply_recovers_same_candidate_without_another_grant(self):
        self.approve()
        def lost(*args, **kwargs):
            self.a.update(activeNode="oci", epoch=2)
            raise TimeoutError("response lost after authority promoted")
        with mock.patch.object(controller, "request_json", side_effect=lost) as network:
            with self.assertRaises(TimeoutError): self.c.activate(self.authority_state())
        self.assertEqual(network.call_count, 1)
        self.assertFalse((self.c.root / "active-candidate.json").exists())
        with mock.patch.object(self.c, "reconcile_oci_workload"), mock.patch.object(controller, "request_json") as retry:
            self.c.tick()
        retry.assert_not_called()
        self.assertEqual(self.c.state["manualEmergencyApproval"]["state"], "consumed")
        self.assertEqual(restore_mysql.read_json(self.c.root / "active-candidate.json")["id"], self.candidate["id"])

    def test_http_approval_requires_oci_producer_and_exact_explicit_confirmations(self):
        self.network_guard.stop()
        server = controller.make_server(self.c, self.config)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.02), daemon=True); thread.start()
        def request(token, data):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=3)
            try:
                connection.request('POST', '/v1/emergency-approvals', json.dumps(data), {'Content-Type':'application/json','Authorization':'Bearer '+token})
                result = connection.getresponse(); return result.status, json.loads(result.read())
            finally: connection.close()
        try:
            self.assertEqual(request(self.config['statusToken'], self.body)[0], 401)
            self.assertEqual(request(self.config['primaryIntentToken'], self.body)[0], 403)
            self.assertEqual(request(self.config['ociIntentToken'], self.body | {'acceptBackupRollback':False})[0], 400)
            self.assertEqual(request(self.config['ociIntentToken'], self.body | {'arm':True})[0], 400)
            self.assertEqual(request(self.config['ociIntentToken'], self.body | {'actorId':'111111111111111111'})[0], 400)
            code, value = request(self.config['ociIntentToken'], self.body)
            self.assertEqual(code, 200); self.assertEqual(value['approval']['state'], 'approved')
            self.assertEqual(self.c.state['primaryIntent'], self.primary)
        finally: server.shutdown(); server.server_close(); thread.join(timeout=1)
