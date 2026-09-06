"""Routing tests use fake network/CLI backends; no DNS record is changed."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import types
import unittest
from unittest import mock

from recovery import routing


class FakeBackend:
    def __init__(self, fixture):
        self.fixture = fixture
        self.calls = []
        self.authority_value = {"ok": True, "activeNode": "oci", "epoch": 7, "serverTime": fixture.now, "lease": {"valid": True, "node": "oci", "instanceId": "oci-instance-7", "expiresAt": fixture.now + 90}}
        self.local = fixture.proof()
        self.public = []
        self.command = {"state": "accepted", "started": True, "exitCode": 0}

    def authority(self, config):
        self.calls.append("authority")
        return copy.deepcopy(self.authority_value)

    def probe(self, url):
        self.calls.append(url)
        if url == routing.LOCAL_HEALTH:
            return copy.deepcopy(self.local)
        return copy.deepcopy(self.public.pop(0) if self.public else self.fixture.proof())

    def route(self, config, hostname):
        self.calls.append(("route", config["tunnelId"], hostname))
        key = hashlib.sha256(("7\0" + hostname).encode()).hexdigest()
        receipt = json.loads((Path(config["stateDir"]) / (key + ".json")).read_text())
        if receipt["state"] != "command_running" or receipt["lastProbe"]["status"] == 200 and routing.verified_health(receipt["lastProbe"], 7, "oci-instance-7"):
            raise AssertionError("Routing side effect lacks durable intent and prior read reconciliation")
        return copy.deepcopy(self.command)


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cbte-routing-offline-")
        self.root = Path(self.temp.name)
        self.now = 1800000000.0
        binary = self.root / "cloudflared"
        binary.write_text("fixture executable; tests never run it")
        binary.chmod(0o755)
        certificate = self.root / "cert.pem"
        certificate.write_text("fixture certificate; tests never submit it")
        certificate.chmod(0o600)
        self.lease_file = self.root / "lease.json"
        self.lease = {"version": 1, "node": "oci", "state": "active", "epoch": 7, "instanceId": "oci-instance-7", "updatedAt": self.now, "validUntilUnixMs": (self.now + 70) * 1000}
        self.write_lease()
        self.path = self.root / "routing.json"
        self.values = {"cloudflared": str(binary), "originCertificate": str(certificate), "tunnelId": "30451f0b-c6dd-46db-9ab4-ab82b8f757ba", "hostnames": ["cbte.sprink.cloud"], "stateDir": str(self.root / "receipts"), "authorityUrl": "http://127.0.0.1:34210", "authorityToken": "fixture-authority-token-not-used-123456789", "leaseFile": str(self.lease_file)}
        self.write_config()
        # Test fixtures may run under an unprivileged CI account. Ownership logic
        # has separate explicit tests; all shape/path/provenance checks stay real.
        self.owner = mock.patch.object(routing, "check_ownership")
        self.owner.start()
        self.addCleanup(self.owner.stop)
        self.network = mock.patch("socket.create_connection", side_effect=AssertionError("Routing tests cannot open network connections"))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.config = routing.load_config(str(self.path))
        self.backend = FakeBackend(self)

    def tearDown(self):
        self.temp.cleanup()

    def write_config(self):
        self.path.write_text(json.dumps(self.values), encoding="utf-8")
        self.path.chmod(0o600)

    def write_lease(self):
        self.lease_file.write_text(json.dumps(self.lease))
        self.lease_file.chmod(0o644)

    def proof(self, **changes):
        body = {"ok": True, "scope": "dashboard_http_only", "node": "oci", "epoch": 7, "instanceId": "oci-instance-7"}
        body.update(changes)
        return {"status": 200, "body": body, "headers": {}}

    def ensure(self):
        return routing.ensure_routes(self.config, 7, backend=self.backend, now=lambda: self.now)

    def commands(self):
        return [value for value in self.backend.calls if isinstance(value, tuple)]

    def test_existing_correct_public_route_needs_no_dns_command(self):
        result = self.ensure()
        self.assertTrue(result["ok"])
        self.assertEqual(result["records"][0]["state"], "verified")
        self.assertFalse(self.commands())

    def test_public_proof_requires_ok_node_epoch_and_instance(self):
        for proof in [self.proof(ok=False), self.proof(node="primary"), self.proof(epoch=6), self.proof(instanceId="old-process"), {"status":200,"body":{"ok":True}}, {"status":302,"body":self.proof()["body"]}]:
            self.assertFalse(routing.verified_health(proof, 7, "oci-instance-7"))
        self.assertTrue(routing.verified_health(self.proof(), 7, "oci-instance-7"))
        conflict = self.proof()
        conflict["headers"] = {"X-CBTE-Fleet-Node":"primary", "X-CBTE-Fleet-Epoch":"7", "X-CBTE-Fleet-Instance-Id":"oci-instance-7"}
        self.assertFalse(routing.verified_health(conflict, 7, "oci-instance-7"))

    def test_cli_success_is_not_public_readiness(self):
        self.backend.public = [self.proof(node="primary"), self.proof(node="primary")]
        result = self.ensure()
        self.assertFalse(result["ok"])
        self.assertEqual(result["records"][0]["state"], "pending_verification")
        self.assertEqual(self.commands(), [("route", self.values["tunnelId"], "cbte.sprink.cloud")])

    def test_unknown_command_is_reconciled_without_repeating_when_public_matches(self):
        self.backend.command = {"state":"unknown","started":True,"exitCode":None}
        self.backend.public = [{"status":530}, {"status":530}]
        first = self.ensure()
        self.assertEqual(first["records"][0]["state"], "unknown")
        self.backend.public = [self.proof()]
        second = self.ensure()
        self.assertTrue(second["ok"])
        self.assertEqual(len(self.commands()), 1)

    def test_restart_with_running_receipt_reads_public_proof_before_any_retry(self):
        self.backend.command = {"state":"unknown","started":True}
        self.backend.public = [{"status":530},{"status":530}]
        self.ensure()
        key=hashlib.sha256(b"7\0cbte.sprink.cloud").hexdigest()
        path=Path(self.values["stateDir"])/(key+".json")
        receipt=json.loads(path.read_text())
        receipt["state"]="command_running"
        path.write_text(json.dumps(receipt))
        self.config=routing.load_config(str(self.path))
        self.backend=FakeBackend(self)
        result=self.ensure()
        self.assertTrue(result["ok"])
        self.assertFalse(self.commands())

    def test_unknown_retry_rechecks_readiness_then_repeats_only_pinned_target(self):
        self.backend.command = {"state":"unknown","started":True}
        self.backend.public = [{"status":530}, {"status":530}]
        self.ensure()
        self.now += 40
        self.lease.update(updatedAt=self.now, validUntilUnixMs=(self.now+70)*1000)
        self.write_lease()
        self.backend.authority_value.update(serverTime=self.now)
        self.backend.authority_value["lease"]["expiresAt"] = self.now+90
        self.backend.public = [{"status":530},self.proof()]
        result = self.ensure()
        self.assertTrue(result["ok"])
        self.assertEqual(self.commands(), [("route",self.values["tunnelId"],"cbte.sprink.cloud")]*2)

    def test_primary_authority_expired_lease_or_stale_local_file_never_routes(self):
        self.backend.authority_value["activeNode"] = "primary"
        with self.assertRaises(routing.RoutingError): self.ensure()
        self.assertFalse(self.commands())
        self.backend.authority_value["activeNode"] = "oci"
        self.lease["updatedAt"] = self.now-26
        self.write_lease()
        with self.assertRaises(routing.RoutingError): self.ensure()
        self.lease.update(updatedAt=self.now, validUntilUnixMs=(self.now+5)*1000)
        self.write_lease()
        with self.assertRaises(routing.RoutingError): self.ensure()
        self.assertFalse(self.commands())

    def test_local_candidate_identity_must_be_verified_before_dns_mutation(self):
        self.backend.local = self.proof(epoch=6)
        self.backend.public = [{"status":530}]
        with self.assertRaises(routing.RoutingError) as caught: self.ensure()
        self.assertEqual(caught.exception.code, "LOCAL_READINESS_UNVERIFIED")
        self.assertFalse(self.commands())

    def test_config_cannot_be_supplied_or_mutated_by_request(self):
        with self.assertRaises(routing.RoutingError): routing.ensure_routes(dict(self.config), 7, backend=self.backend, now=lambda:self.now)
        self.config["hostnames"] = ["unrequested.example.com"]
        with self.assertRaises(routing.RoutingError): self.ensure()
        self.assertFalse(self.commands())

    def test_hostname_urls_wildcards_and_cli_fragments_are_not_allowlisted_hosts(self):
        for hostname in ["https://cbte.sprink.cloud","*.sprink.cloud","cbte.sprink.cloud;id","cbte.sprink.cloud:443"]:
            self.values["hostnames"]=[hostname]
            self.write_config()
            with self.assertRaises(routing.RoutingError): routing.load_config(str(self.path))
        self.assertFalse(self.commands())

    def test_no_automatic_tunnel_target_rollback_even_after_config_change(self):
        self.ensure()
        self.values["tunnelId"] = "00000000-0000-0000-0000-000000000001"
        self.write_config()
        self.config = routing.load_config(str(self.path))
        with self.assertRaises(routing.RoutingError) as caught: self.ensure()
        self.assertEqual(caught.exception.code, "PINNED_TARGET_CHANGED")
        self.assertFalse(self.commands())

    def test_cli_timeout_uses_fixed_argv_and_is_unknown_not_failed(self):
        process = mock.Mock(pid=999999, stdout=io.BytesIO(b"stdout"), stderr=io.BytesIO(b"stderr"))
        process.wait.side_effect = [subprocess.TimeoutExpired(["cloudflared"],20), -9]
        Path(self.values["stateDir"]).mkdir()
        with mock.patch.object(routing.subprocess,"Popen",return_value=process) as popen, mock.patch.object(routing.os,"killpg",create=True) as killpg:
            result = routing.Backend().route(self.config, "cbte.sprink.cloud")
        self.assertEqual(result["state"],"unknown")
        argv = popen.call_args.args[0]
        self.assertEqual(argv,[self.values["cloudflared"],"tunnel","--origincert",self.values["originCertificate"],"route","dns","--overwrite-dns",self.values["tunnelId"],"cbte.sprink.cloud"])
        self.assertNotIn(self.values["authorityToken"],popen.call_args.kwargs["env"].values())
        self.assertEqual(process.wait.call_args_list[0].kwargs["timeout"],20)


class OwnershipTests(unittest.TestCase):
    def test_root_config_and_certificate_ownership_is_enforced(self):
        good=types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o600)
        routing.check_ownership(good,0o077,"BAD","bad",posix=True)
        for value in [types.SimpleNamespace(st_uid=1000,st_mode=stat.S_IFREG|0o600),types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o644)]:
            with self.assertRaises(routing.RoutingError): routing.check_ownership(value,0o077,"BAD","bad",posix=True)


class HTTPProbeTests(unittest.TestCase):
    def test_public_probe_identifies_the_recovery_service_without_browser_impersonation_or_credentials(self):
        backend = routing.Backend()
        response = mock.MagicMock(status=200, headers={})
        response.read.return_value = b'{"ok":true,"node":"oci","epoch":7,"instanceId":"current"}'
        with mock.patch.object(backend.opener, "open") as opened:
            opened.return_value.__enter__.return_value = response
            result = backend.probe("https://cbte.sprink.cloud/api/health")
        request = opened.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), "CBTE-Recovery/1.0")
        self.assertNotIn("Mozilla", request.get_header("User-agent"))
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(request.get_header("Cache-control"), "no-cache, no-store")
        self.assertIsNone(request.get_header("Authorization"))
        self.assertTrue(request.full_url.startswith("https://cbte.sprink.cloud/api/health?recovery_probe="))
        self.assertEqual(opened.call_args.kwargs["timeout"], routing.PROBE_TIMEOUT)
        response.read.assert_called_once_with(65537)
        self.assertTrue(routing.verified_health(result, 7, "current"))

    def test_identified_probe_still_rejects_edge_errors_as_unverified(self):
        backend = routing.Backend()
        error = routing.urllib.error.HTTPError("https://cbte.sprink.cloud/api/health", 403, "Forbidden", {}, io.BytesIO(b"error code: 1010"))
        with mock.patch.object(backend.opener, "open", side_effect=error):
            result = backend.probe("https://cbte.sprink.cloud/api/health")
        self.assertEqual(result, {"status": 403, "error": "HTTP_REJECTED"})
        self.assertFalse(routing.verified_health(result, 7, "current"))


if __name__ == "__main__":
    unittest.main()
