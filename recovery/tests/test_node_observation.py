"""Optional renewal observations never authorize or extend a separate lease."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from recovery.authority import Authority, AuthorityError, TTL
from recovery.guardian import Guardian, RemoteError
from recovery.test_authority_guardian import FakeClock, configuration
from recovery import controller


def observation(clock):
    return {"enabled": True, "physicalDevice": "sda", "logicalDevice": "dm-0", "thresholdSeconds": 180, "startupGraceSeconds": 300,
            "state": "observing", "reason": "continuous_stall_candidate", "childPid": 123, "childStartTicks": 9000,
            "observedAtUnixMs": int(clock.wall() * 1000), "continuousSeconds": 175.0,
            "evidence": {"state": "D", "physicalWrites": 123456, "logicalWrites": 123450, "physicalInflight": 0, "logicalInflight": 32, "wbtInflight": 96}}


class NodeObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cbte-node-observation-")
        self.config = configuration(self.temp.name)
        self.clock = FakeClock()
        self.a = Authority(self.config, self.clock)
        self.clock.advance(150)
        self.lease = self.acquire("primary-one")

    def tearDown(self):
        self.a.close(); self.temp.cleanup()

    def acquire(self, instance, node="primary"):
        return self.a.call("POST", "/v1/lease/acquire", node, {"node": node, "instanceId": instance, "epoch": self.a.call("GET", "/v1/status", "controller")["epoch"]})

    def body(self, lease=None):
        value = lease or self.lease
        return {key: value[key] for key in ("node", "instanceId", "epoch", "leaseId")}

    def renew(self, value, **changes):
        return self.a.call("POST", "/v1/lease/renew", "primary", dict(self.body(), primaryIoWatch=value, **changes))

    def test_live_identity_observation_is_durable_and_becomes_explicitly_stale(self):
        value = observation(self.clock)
        self.assertEqual(self.renew(value)["observationStatus"], "accepted")
        status = self.a.call("GET", "/v1/status", "controller")
        report = status["nodeObservations"]["primary"]
        self.assertEqual(report["instanceId"], "primary-one")
        self.assertEqual(report["receivedAt"], self.clock.wall())
        self.assertEqual(report["primaryIoWatch"]["state"], "observing")
        self.assertEqual(report["primaryIoWatch"]["evidence"]["physicalWrites"], "123456")
        self.assertFalse(report["stale"])
        self.assertNotIn(self.lease["leaseId"], json.dumps(report))
        self.clock.advance(95)
        report = self.a.call("GET", "/v1/status", "controller")["nodeObservations"]["primary"]
        self.assertTrue(report["stale"])
        self.assertFalse(report["leaseValid"])
        self.assertEqual(report["primaryIoWatch"]["state"], "observing")
        self.a.close(); self.a = Authority(self.config, self.clock)
        report = self.a.call("GET", "/v1/status", "controller")["nodeObservations"]["primary"]
        self.assertTrue(report["stale"])
        self.assertFalse(report["matchesCurrentLease"])

    def test_invalid_or_secret_diagnostics_are_ignored_without_failing_valid_renewal(self):
        cases = []
        for key, value in [("token", self.config["tokens"]["primary"]), ("reason", self.config["tokens"]["primary"]), ("thresholdSeconds", True), ("continuousSeconds", float("nan")), ("reason", "x" * 6000)]:
            item = observation(self.clock); item[key] = value; cases.append(item)
        item = observation(self.clock); item["evidence"]["command"] = "private shell data"; cases.append(item)
        for item in cases:
            self.clock.advance(1)
            result = self.renew(item)
            self.assertTrue(result["ok"])
            self.assertEqual(result["expiresAt"], self.clock.wall() + TTL)
            self.assertEqual(result["observationStatus"], "ignored_invalid")
        self.assertEqual(self.a.db.execute("SELECT COUNT(*) FROM node_observations").fetchone()[0], 0)
        self.assertNotIn(self.config["tokens"]["primary"], json.dumps(self.a.call("GET", "/v1/status", "controller")))

    def test_stale_identity_or_wrong_role_cannot_refresh_diagnostic_received_time(self):
        self.renew(observation(self.clock))
        original = self.a.db.execute("SELECT received_at,payload FROM node_observations").fetchone()
        self.clock.advance(10)
        for role, body in [("controller", self.body()), ("primary", dict(self.body(), instanceId="other")), ("primary", dict(self.body(), epoch=999))]:
            with self.assertRaises(AuthorityError):
                self.a.call("POST", "/v1/lease/renew", role, body | {"primaryIoWatch": observation(self.clock)})
        self.assertEqual(tuple(original), tuple(self.a.db.execute("SELECT received_at,payload FROM node_observations").fetchone()))

    def test_oci_live_lease_cannot_report_primary_io_diagnostics(self):
        # Fixture-only transition; the production promotion protocol is tested separately.
        self.a.db.execute("UPDATE authority SET active_node='oci',primary_enrolled=1,lease_id=NULL,lease_node=NULL,lease_instance=NULL,lease_expires=0,drain_until=0 WHERE id=1")
        lease = self.acquire("oci-one", "oci")
        result = self.a.call("POST", "/v1/lease/renew", "oci", self.body(lease) | {"primaryIoWatch": observation(self.clock)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["observationStatus"], "ignored_role")
        self.assertEqual(self.a.db.execute("SELECT COUNT(*) FROM node_observations").fetchone()[0], 0)

    def test_optional_observation_storage_error_does_not_abort_durable_renewal(self):
        self.a.db.execute("CREATE TRIGGER reject_observation BEFORE INSERT ON node_observations BEGIN SELECT RAISE(ABORT,'private diagnostic failure'); END")
        self.clock.advance(1)
        result = self.renew(observation(self.clock))
        self.assertTrue(result["ok"])
        self.assertEqual(result["expiresAt"], self.clock.wall() + TTL)
        self.assertEqual(result["observationStatus"], "ignored_storage_error")
        self.assertNotIn("private diagnostic failure", json.dumps(result))

    def test_node_instance_retention_is_bounded(self):
        self.renew(observation(self.clock))
        for index in range(4):
            self.clock.advance(151)
            self.lease = self.acquire("next-" + str(index))
            self.renew(observation(self.clock))
        self.assertEqual(self.a.db.execute("SELECT COUNT(*) FROM node_observations").fetchone()[0], 2)
        self.assertEqual(self.a.call("GET", "/v1/status", "controller")["nodeObservations"]["primary"]["instanceId"], "next-3")

    def test_uint64_kernel_counters_remain_exact_in_browser_status(self):
        value = observation(self.clock)
        value["evidence"]["physicalWrites"] = 2**64 - 1
        self.renew(value)
        report = self.a.call("GET", "/v1/status", "controller")["nodeObservations"]["primary"]
        self.assertEqual(report["primaryIoWatch"]["evidence"]["physicalWrites"], "18446744073709551615")

    def test_guardian_adds_only_cached_valid_observation_to_normal_renewal(self):
        config = {"node": "primary", "token": "p" * 40, "authorityUrl": "http://127.0.0.1:34210", "command": [os.path.abspath(os.sys.executable)], "leaseFile": str(Path(self.temp.name) / "lease.json"), "systemdUnit": "cbte.service"}
        client = mock.Mock()
        guardian = Guardian(config, client=client, clock=self.clock, fencer=mock.Mock())
        guardian.lease = self.lease | {"instanceId": guardian.instance_id}
        guardian.io_watch = mock.Mock(confirmed=False)
        guardian.io_watch.snapshot.return_value = observation(self.clock)
        body = guardian.lease_body(include_observation=True)
        self.assertEqual(body["primaryIoWatch"], observation(self.clock))
        self.assertNotIn("primaryIoWatch", guardian.lease_body())  # Release carries no diagnostic side channel.
        guardian.io_watch.snapshot.return_value = {"token": config["token"]}
        self.assertNotIn("primaryIoWatch", guardian.lease_body(include_observation=True))
        guardian.io_watch.confirmed = True
        with self.assertRaises(RemoteError): guardian.lease_body(include_observation=True)
        client.request.assert_not_called()  # No extra renew/send was made to flush a fault.

    def test_controller_keeps_reported_observation_while_primary_admin_is_unreachable(self):
        c = controller.Controller({"stateDir": str(Path(self.temp.name) / "controller")})
        reports = {"primary": {"receivedAt": self.clock.wall(), "stale": True, "primaryIoWatch": observation(self.clock)}}
        with mock.patch.object(c, "authority", return_value={"activeNode": "primary", "nodeObservations": reports}), mock.patch.object(c, "admin_policy", side_effect=OSError("primary unreachable")):
            c.observe_intents_once()
        self.assertEqual(c.state["nodeObservations"], reports)
        self.assertIn("authorityObservationFetchedAt", c.state)
