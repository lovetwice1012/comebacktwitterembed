import copy
import datetime as dt
import http.client
import json
import threading
from unittest import mock

from recovery import controller
from recovery.failback_orchestrator import Failback
from recovery.restore_mysql import atomic_json
from recovery.tests.test_controller_restore import RecoveryFixture


class ManualSwitchTests(RecoveryFixture):
    def setUp(self):
        super().setUp()
        self.c = controller.Controller(dict(self.config, statusToken="s" * 48))
        self.c.update(phase="STANDBY_READY", candidate=copy.deepcopy(self.candidate), backup=copy.deepcopy(self.source))

    def body(self, target="oci", execute_at=None):
        return {
            "operationId": "a" * 48,
            "actorId": "796972193287503913",
            "targetNode": target,
            "executeAt": self.iso(self.now + 3600 if execute_at is None else execute_at),
            "expectedEpoch": 1,
            "expectedCandidateId": self.candidate["id"] if target == "oci" else "",
            "expectedBackupId": self.source["backupId"] if target == "oci" else "",
            "expectedBackupSha256": self.source["sourceSha256"] if target == "oci" else "",
            "expectedBackupTimestamp": self.source["sourceTimestamp"] if target == "oci" else "",
            "reason": "管理者が確認した復旧切り替え",
            "confirm": True,
            "acceptDataRisk": True,
            "acceptPrimaryIntentOverride": True,
        }

    def test_schedule_is_epoch_and_candidate_bound_and_idempotent(self):
        with mock.patch.object(self.c, "authority", return_value=self.authority_state()), mock.patch.object(controller.time, "time", return_value=self.now):
            first = self.c.schedule_manual_switch(self.body())
            second = self.c.schedule_manual_switch(self.body())
        self.assertFalse(first["reused"])
        self.assertTrue(second["reused"])
        self.assertEqual(self.c.state["manualSwitch"]["state"], "scheduled")
        self.assertEqual(self.c.state["manualSwitch"]["executeAt"], self.iso(self.now + 3600))

    def test_primary_schedule_can_be_cancelled_but_execution_cannot(self):
        body = self.body(target="primary")
        authority = self.authority_state(activeNode="oci")
        with mock.patch.object(self.c, "authority", return_value=authority), mock.patch.object(controller.time, "time", return_value=self.now):
            self.c.schedule_manual_switch(body)
            cancelled = self.c.cancel_manual_switch({"operationId": body["operationId"], "actorId": body["actorId"]})
        self.assertEqual(cancelled["manualSwitch"]["state"], "cancelled")
        self.assertIsNone(self.c.cancel_manual_switch({"operationId": body["operationId"], "actorId": body["actorId"]})["manualSwitch"].get("startedAt"))

    def test_schedule_rejects_active_target_and_changed_candidate(self):
        with mock.patch.object(self.c, "authority", return_value=self.authority_state()), mock.patch.object(controller.time, "time", return_value=self.now):
            with self.assertRaises(controller.IntentError) as active:
                self.c.schedule_manual_switch(self.body(target="primary"))
        self.assertEqual(active.exception.code, "ALREADY_ACTIVE")
        self.c.update(candidate=copy.deepcopy(self.candidate) | {"id": "e" * 24})
        with mock.patch.object(self.c, "authority", return_value=self.authority_state()), mock.patch.object(controller.time, "time", return_value=self.now):
            with self.assertRaises(controller.IntentError) as changed:
                self.c.schedule_manual_switch(self.body())
        self.assertEqual(changed.exception.code, "SWITCH_CANDIDATE_CHANGED")

    def test_future_oci_schedule_holds_automatic_promotion(self):
        body = self.body(execute_at=self.now + 3600)
        with mock.patch.object(self.c, "authority", return_value=self.authority_state()), mock.patch.object(controller.time, "time", return_value=self.now):
            self.c.schedule_manual_switch(body)
            self.assertTrue(self.c.manual_switch_tick(self.authority_state()))
        self.assertEqual(self.c.state["manualSwitch"]["state"], "scheduled")

    def test_manual_promotion_override_only_covers_arming_and_primary_intent(self):
        authority = self.authority_state(armed=False)
        primary = {"desiredState": "maintenance", "revision": 2, "observationState": "fresh", "fetchedAt": self.iso(self.now)}
        oci = {"desiredState": "maintenance", "revision": 7, "observationState": "fresh", "fetchedAt": self.iso(self.now)}
        with mock.patch.object(controller.time, "time", return_value=self.now):
            gates = controller.promotion_gates(authority, self.source, self.candidate, self.config, primary, oci, manual_override=True)
        self.assertTrue(next(item for item in gates if item["code"] == "AUTOMATION_ARMED")["ready"])
        self.assertTrue(next(item for item in gates if item["code"] == "PRIMARY_OPERATOR_RUNNING")["ready"])
        self.assertFalse(next(item for item in gates if item["code"] == "OCI_OPERATOR_PERMITS_PROMOTION")["ready"])

    def test_http_endpoint_requires_controller_status_token(self):
        self.network_guard.stop()
        server = controller.make_server(self.c, self.c.config)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.02), daemon=True)
        thread.start()
        body = self.body()
        def request(token, payload):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=3)
            try:
                connection.request("POST", "/v1/manual-switch", json.dumps(payload), {"Content-Type": "application/json", "Authorization": "Bearer " + token})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()
        try:
            self.assertEqual(request("x" * 48, body)[0], 401)
            with mock.patch.object(self.c, "authority", return_value=self.authority_state()), mock.patch.object(controller.time, "time", return_value=self.now):
                code, value = request("s" * 48, body)
            self.assertEqual(code, 200)
            self.assertEqual(value["manualSwitch"]["state"], "scheduled")
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=1)

    def test_failback_coordinator_waits_for_future_primary_reservation(self):
        root = self.root / "failback"
        root.mkdir()
        authority = root / "authority.json"; authority.write_text(json.dumps({"tokens": {"controller": "c" * 40}}), encoding="utf-8")
        key = root / "key"; key.write_text("fixture", encoding="utf-8")
        snapshot = root / "snapshot"; snapshot.write_text("fixture", encoding="utf-8")
        marker = root / "ready"; marker.write_text("fixture", encoding="utf-8")
        cert = root / "cert"; cert.write_text("fixture", encoding="utf-8")
        notify = root / "notify.json"; notify.write_text("{}", encoding="utf-8")
        handoff = root / "handoff.json"; lease = root / "lease.json"
        controller_state = root / "controller-state.json"
        body = self.body(target="primary", execute_at=self.now + 3600)
        atomic_json(controller_state, {"manualSwitch": dict(body, state="scheduled", createdAt=self.iso(self.now), updatedAt=self.iso(self.now))})
        config = {"statePath": str(root / "state.json"), "controllerStatePath": str(controller_state), "authorityUrl": "http://127.0.0.1:34210", "authorityConfig": str(authority), "primarySshKey": str(key), "primarySnapshotPath": str(snapshot), "primaryReadyMarker": str(marker), "primaryTunnelId": "739a9c55-e8d6-4e80-a388-540704f4e2af", "cloudflared": "/usr/bin/cloudflared", "originCertificate": str(cert), "notificationConfig": str(notify), "primaryHostnames": ["cbte.sprink.cloud", "twidata.sprink.cloud"], "handoffMarker": str(handoff), "sourceLeaseFile": str(lease)}
        process = Failback(config, runner=lambda *_args, **_kwargs: "")
        with mock.patch.object(process, "authority", return_value={"activeNode": "oci"}), mock.patch.object(process, "primary_ready") as primary_ready, mock.patch("recovery.failback_orchestrator.time.time", return_value=self.now):
            process.step()
        primary_ready.assert_not_called()
        self.assertEqual(process.state["phase"], "WAITING_PRIMARY")


if __name__ == "__main__":
    import unittest
    unittest.main()
