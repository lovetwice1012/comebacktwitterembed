"""Operator stop/maintenance intent must survive process/host failure."""
import copy
import io
import json
from pathlib import Path
import unittest
from unittest import mock

from recovery import controller, restore_mysql
from recovery.tests.test_controller_restore import RecoveryFixture


class OperatorIntentTests(RecoveryFixture):
    def setUp(self):
        super().setUp()
        self.config.update(primaryAdminUrl="http://127.0.0.1:34224", primaryAdminToken="fixture-primary-admin-token-more-than32", ociAdminToken="fixture-oci-admin-token-more-than32", ociStandbyPolicyRevision=7)
        self.c = controller.Controller(self.config)
        self.c.update(backup=self.source, candidate=self.candidate, phase="STANDBY_READY")
        self.policies = {"primary": {"revision": 3, "desiredState": "running", "maintenanceUntil": ""}, "oci": {"revision": 7, "desiredState": "maintenance", "maintenanceUntil": "", "autoInvestigate": True, "autoRestartHungBot": False, "restartDailyLimit": 3, "reportsPausedUntil": "", "reportsRefreshIntervalSeconds": 900}}
        self.unavailable = set()
        self.policy_calls = []
        self.put_lost_response = False
        self.put_conflict = False
        self.unit = "inactive"
        self.commands = []
        self.policy_patch = mock.patch.object(self.c, "admin_policy", side_effect=self.policy)
        self.policy_patch.start()
        self.addCleanup(self.policy_patch.stop)
        self.time_patch = mock.patch.object(controller.time, "time", return_value=self.now)
        self.time_patch.start()
        self.addCleanup(self.time_patch.stop)

    def policy(self, node, body=None):
        self.policy_calls.append((node, copy.deepcopy(body)))
        if node in self.unavailable:
            raise OSError("management transport unavailable")
        if body is not None:
            if self.put_conflict:
                self.policies[node].update(revision=self.policies[node]["revision"] + 1, desiredState="stopped")
                raise RuntimeError("CAS revision conflict")
            self.assertEqual(body["expectedRevision"], self.policies[node]["revision"])
            self.policies[node] = {key: value for key, value in body.items() if key != "expectedRevision"}
            self.policies[node]["revision"] += 1
            if self.put_lost_response:
                self.put_lost_response = False
                raise OSError("PUT applied but response lost")
        return copy.deepcopy(self.policies[node])

    def unit_run(self, command, timeout=30):
        self.commands.append(command)
        if command[1] == "start": self.unit = "active"
        return self.unit

    def tick(self, authority=None):
        with mock.patch.object(self.c, "authority", return_value=authority or self.authority_state()), mock.patch.object(self.c, "activate") as activate:
            self.c.tick()
        return activate

    def active(self):
        candidate = dict(self.candidate, epoch=2)
        restore_mysql.atomic_json(self.c.root / "active-candidate.json", candidate)
        return self.authority_state(activeNode="oci", epoch=2)

    def test_primary_stop_and_maintenance_block_promotion_after_lease_drain(self):
        for desired in ("stopped", "maintenance"):
            self.policies["primary"].update(desiredState=desired, revision=self.policies["primary"]["revision"] + 1)
            activate = self.tick()
            activate.assert_not_called()
            self.assertFalse(next(item for item in self.c.state["gates"] if item["code"] == "PRIMARY_OPERATOR_RUNNING")["ready"])
            self.assertEqual(self.c.state["primaryIntent"]["desiredState"], desired)

    def test_unreachable_primary_without_initial_observation_blocks(self):
        self.unavailable.add("primary")
        self.tick().assert_not_called()
        self.assertEqual(self.c.state["primaryIntent"]["observationState"], "unknown")

    def test_last_known_running_survives_primary_host_loss_and_controller_restart(self):
        observed = self.c.refresh_operator_intent("primary")
        self.unavailable.add("primary")
        self.tick().assert_called_once()
        self.assertEqual(self.c.state["primaryIntent"]["observationState"], "stale")
        self.assertEqual(self.c.state["primaryIntent"]["fetchedAt"], observed["fetchedAt"])
        restarted = controller.Controller(self.config)
        with mock.patch.object(restarted, "admin_policy", side_effect=self.policy), mock.patch.object(restarted, "authority", return_value=self.authority_state()), mock.patch.object(restarted, "activate") as activate:
            restarted.tick()
        activate.assert_called_once()
        self.assertEqual(restarted.state["primaryIntent"]["revision"], 3)

    def test_last_known_stopped_never_becomes_running_on_transport_failure(self):
        self.policies["primary"]["desiredState"] = "stopped"
        self.c.refresh_operator_intent("primary")
        self.unavailable.add("primary")
        self.tick().assert_not_called()
        self.assertEqual(self.c.state["primaryIntent"]["desiredState"], "stopped")

    def test_timed_maintenance_blocks_even_when_desired_state_is_running(self):
        self.policies["primary"]["maintenanceUntil"] = self.iso(self.now + 600)
        self.tick().assert_not_called()

    def test_unknown_or_operator_modified_oci_standby_blocks_promotion(self):
        self.unavailable.add("oci")
        self.tick().assert_not_called()
        self.unavailable.clear()
        self.policies["oci"].update(revision=8, desiredState="maintenance")
        self.tick().assert_not_called()
        self.policies["oci"].update(revision=9, desiredState="stopped")
        self.tick().assert_not_called()

    def test_primary_intent_is_refreshed_after_long_backup_preparation(self):
        self.c.config["autoPrepare"] = True
        def prepare(): self.policies["primary"].update(desiredState="stopped", revision=4)
        with mock.patch.object(self.c, "prepare_latest", side_effect=prepare):
            self.tick().assert_not_called()
        self.assertEqual(self.c.state["primaryIntent"]["revision"], 4)

    def test_seeded_oci_transition_preserves_every_other_policy_field(self):
        before = copy.deepcopy(self.policies["oci"])
        self.c.update(ociActivationPolicy={"state": "pending", "seedRevision": 7})
        result = self.c.activate_oci_operator_intent()
        self.assertEqual(result["desiredState"], "running")
        self.assertEqual(result["revision"], 8)
        sent = next(body for node, body in self.policy_calls if body is not None)
        self.assertEqual(sent, dict(before, desiredState="running", expectedRevision=7))
        self.assertEqual(self.c.state["ociActivationPolicy"]["state"], "applied")

    def test_lost_cas_response_is_reconciled_without_another_put(self):
        self.put_lost_response = True
        self.c.update(ociActivationPolicy={"state": "pending", "seedRevision": 7})
        self.c.activate_oci_operator_intent()
        self.c.activate_oci_operator_intent()
        self.assertEqual(sum(body is not None for _, body in self.policy_calls), 1)
        self.assertEqual(self.c.state["ociActivationPolicy"]["state"], "applied")

    def test_cas_conflict_never_overwrites_operator_stop_or_starts_unit(self):
        self.put_conflict = True
        self.c.update(ociActivationPolicy={"state": "pending", "seedRevision": 7})
        authority = self.active()
        with mock.patch.object(controller, "run", side_effect=self.unit_run):
            self.c.reconcile_oci_workload(authority, self.candidate)
        self.assertEqual(self.policies["oci"]["desiredState"], "stopped")
        self.assertEqual(self.c.state["ociActivationPolicy"]["state"], "blocked")
        self.assertFalse(any(command[1] == "start" for command in self.commands))

    def test_active_oci_manual_stop_and_maintenance_are_not_restarted(self):
        authority = self.active()
        for desired in ("stopped", "maintenance"):
            self.policies["oci"].update(desiredState=desired, revision=self.policies["oci"]["revision"] + 1)
            with mock.patch.object(self.c, "authority", return_value=authority), mock.patch.object(controller, "run", side_effect=self.unit_run):
                self.c.tick()
            self.assertEqual(self.c.state["phase"], "OCI_OPERATOR_PAUSED")
        self.assertFalse(any(command[1] == "start" for command in self.commands))

    def test_unreachable_oci_core_leaves_active_unit_alone_and_never_starts_inactive_unit(self):
        authority = self.active()
        self.policies["oci"].update(desiredState="running", revision=8)
        self.c.refresh_operator_intent("oci")
        self.unavailable.add("oci")
        for status in ("active", "inactive"):
            self.unit = status
            with mock.patch.object(self.c, "authority", return_value=authority), mock.patch.object(controller, "run", side_effect=self.unit_run):
                self.c.tick()
            self.assertEqual(self.unit, status)
            self.assertEqual(self.c.state["phase"], "OCI_OPERATOR_INTENT_UNCONFIRMED")
        self.assertTrue(all(command[1] == "show" for command in self.commands))

    def test_active_oci_fresh_running_intent_allows_start_and_readiness_verification(self):
        authority = self.active()
        self.policies["oci"].update(desiredState="running", revision=8)
        with mock.patch.object(self.c, "authority", return_value=authority), mock.patch.object(controller, "run", side_effect=self.unit_run), mock.patch.object(self.c, "verify_active") as verify:
            self.c.tick()
        self.assertEqual(self.unit, "active")
        verify.assert_called_once()

    def test_typed_put_uses_exact_loopback_policy_route_and_json(self):
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(json.dumps({"revision": 8, "desiredState": "running"}).encode())
        body = {"expectedRevision": 7, "desiredState": "running", "autoInvestigate": True}
        with mock.patch.object(controller.urllib.request, "build_opener", return_value=opener):
            controller.request_json("http://127.0.0.1:30988", "fixture-private-token", "/v1/policies", body, timeout=5, method="PUT")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_method(), "PUT")
        self.assertEqual(request.full_url, "http://127.0.0.1:30988/v1/policies")
        self.assertEqual(json.loads(request.data), body)
        with self.assertRaises(ValueError): controller.request_json("http://127.0.0.1:30988", "fixture", "/v1/policies", body, method="DELETE")

    def test_promotion_reserves_seed_cas_before_grant_then_starts_after_verified_policy(self):
        def promote(base, token, path, body=None, timeout=90, method=None):
            self.assertEqual(path, "/v1/promote")
            saved = restore_mysql.read_json(self.c.state_path)
            self.assertEqual(saved["ociActivationPolicy"]["state"], "pending")
            self.assertFalse(any(policy is not None for _, policy in self.policy_calls))
            return {"ok": True, "epoch": 2, "activeNode": "oci"}
        with mock.patch.object(controller, "request_json", side_effect=promote), mock.patch.object(self.c, "authority", return_value=self.authority_state(activeNode="oci", epoch=2)), mock.patch.object(controller, "run", side_effect=self.unit_run), mock.patch.object(self.c, "verify_active"):
            self.c.activate(self.authority_state())
        self.assertEqual(self.unit, "active")
        self.assertEqual(self.policies["oci"]["desiredState"], "running")
        self.assertEqual(self.c.state["ociActivationPolicy"]["state"], "applied")

    def test_changed_primary_intent_at_last_moment_prevents_authority_promotion(self):
        self.c.refresh_operator_intent("primary")
        self.policies["primary"].update(desiredState="stopped", revision=4)
        with mock.patch.object(controller, "request_json") as network, mock.patch.object(controller, "run") as process:
            self.c.activate(self.authority_state())
        network.assert_not_called()
        process.assert_not_called()
        self.assertEqual(self.c.state["phase"], "OPERATOR_PROMOTION_BLOCKED")

    def test_regressed_policy_is_unknown_and_stays_blocked_if_transport_then_fails(self):
        self.c.refresh_operator_intent("primary")
        self.policies["primary"]["revision"] = 1
        self.tick().assert_not_called()
        self.assertEqual(self.c.state["primaryIntent"]["observationState"], "unknown")
        self.unavailable.add("primary")
        self.tick().assert_not_called()
        self.assertEqual(self.c.state["primaryIntent"]["observationState"], "unknown")


if __name__ == "__main__":
    unittest.main()
