"""Offline fault-injection tests; never contacts NAS, OCI or Discord."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import subprocess
from unittest import mock

from recovery.authority import Authority, AuthorityError, DRAIN, PROOF_DOMAIN, TTL, canonical, make_server
from recovery.guardian import AuthorityClient, Guardian, RemoteError, STOP_BUDGET, SystemdUnitFencer, PRIMARY_COMPANIONS, command_digest, inspect_companions, inspect_guardian_unit, installation_proof, stop_group, validate_command


class FakeClock:
    def __init__(self):
        self.timestamp, self.tick = 10000.0, 500.0

    def wall(self):
        return self.timestamp

    def monotonic(self):
        return self.tick

    def advance(self, seconds):
        self.timestamp += seconds
        self.tick += seconds


def configuration(directory):
    return {"database": str(Path(directory) / "authority.db"), "clusterId": "test-cluster", "tokens": {"primary": "p" * 40, "oci": "o" * 40, "controller": "c" * 40}, "enrollmentPolicy": {"unit": "cbte.service", "installationId": "installation-1", "guardianSha256": "a" * 64, "commandSha256": "b" * 64}}


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.config = configuration(self.directory.name)
        self.clock = FakeClock()
        self.authority = Authority(self.config, self.clock)

    def tearDown(self):
        self.authority.close()
        self.directory.cleanup()

    def status(self):
        return self.authority.call("GET", "/v1/status", "controller")

    def call(self, path, role="controller", **data):
        return self.authority.call("POST", path, role, data)

    def assert_code(self, code, callback):
        with self.assertRaises(AuthorityError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def enroll(self, mutate=None):
        challenge = self.call("/v1/primary/enroll/challenge", "primary", instanceId="primary-guardian")
        proof = dict(self.config["enrollmentPolicy"], challengeId=challenge["challengeId"], nonce=challenge["nonce"], guardianPid=1234, mainPid=1234, killMode="control-group", cgroupPids=[1234], hostBootId="boot-one", execStartVerified=True, workloadStarted=False)
        if mutate:
            mutate(proof)
        body = {"clusterId": self.config["clusterId"], "instanceId": "primary-guardian", "proof": proof}
        signature = hmac.new(self.config["tokens"]["primary"].encode(), PROOF_DOMAIN + canonical(body).encode(), hashlib.sha256).hexdigest()
        return self.call("/v1/primary/enroll", "primary", instanceId="primary-guardian", proof=proof, signature=signature)

    def ready(self):
        self.enroll()
        self.clock.advance(TTL + DRAIN)
        self.call("/v1/arm", armed=True, expectedEpoch=self.status()["epoch"])

    def acquire(self, instance="primary-one", node="primary"):
        return self.call("/v1/lease/acquire", node, node=node, instanceId=instance, epoch=self.status()["epoch"])

    @staticmethod
    def lease_body(lease):
        return {key: lease[key] for key in ("node", "instanceId", "epoch", "leaseId")}

    def test_unenrolled_primary_blocks_promotion_even_after_long_outage(self):
        self.clock.advance(86400)
        self.assertFalse(self.status()["primaryEnrolled"])
        self.assert_code("PRIMARY_NOT_ENROLLED", lambda: self.call("/v1/arm", armed=True, expectedEpoch=1))
        self.assert_code("PRIMARY_NOT_ENROLLED", lambda: self.call("/v1/promote", target="oci", expectedEpoch=1, idempotencyKey="outage"))
        self.assertEqual(self.status()["activeNode"], "primary")

    def test_roles_cannot_impersonate_nodes_or_enrollment(self):
        self.assert_code("ROLE_MISMATCH", lambda: self.call("/v1/lease/acquire", "oci", node="primary", instanceId="other", epoch=1))
        self.assert_code("PRIMARY_ROLE_REQUIRED", lambda: self.call("/v1/primary/enroll/challenge", instanceId="fake"))
        self.assert_code("CONTROLLER_REQUIRED", lambda: self.call("/v1/promote", "primary", target="oci", expectedEpoch=1, idempotencyKey="bad"))

    def test_start_quarantine_and_single_holder(self):
        self.assert_code("AUTHORITY_QUARANTINED", self.acquire)
        self.clock.advance(150)
        lease = self.acquire()
        self.assertEqual(lease["ttlSeconds"], 90)
        self.assertEqual(self.acquire()["leaseId"], lease["leaseId"])
        self.assert_code("LEASE_HELD", lambda: self.acquire("primary-two"))
        self.assert_code("NOT_ACTIVE_NODE", lambda: self.acquire("oci-one", "oci"))

    def test_renewal_expiry_drain_and_sticky_promotion(self):
        self.ready()
        lease = self.acquire()
        self.clock.advance(10)
        renewed = self.call("/v1/lease/renew", "primary", **self.lease_body(lease))
        self.assertEqual(renewed["expiresAt"], self.clock.wall() + TTL)
        self.clock.advance(TTL)
        self.assert_code("LEASE_EXPIRED", lambda: self.call("/v1/lease/renew", "primary", **self.lease_body(renewed)))
        self.assert_code("LEASE_DRAINING", lambda: self.call("/v1/promote", target="oci", expectedEpoch=1, idempotencyKey="promotion"))
        self.clock.advance(DRAIN)
        promoted = self.call("/v1/promote", target="oci", expectedEpoch=1, idempotencyKey="promotion")
        self.assertEqual(promoted["epoch"], 2)
        self.assertEqual(self.call("/v1/promote", target="oci", expectedEpoch=1, idempotencyKey="promotion"), promoted)
        self.assert_code("NOT_ACTIVE_NODE", self.acquire)
        self.assertEqual(self.acquire("oci-one", "oci")["epoch"], 2)
        self.assert_code("FAILBACK_FORBIDDEN", lambda: self.call("/v1/promote", target="primary", expectedEpoch=2, idempotencyKey="failback"))

    def test_release_does_not_shorten_original_grace(self):
        self.ready()
        lease = self.acquire()
        released = self.call("/v1/lease/release", "primary", **self.lease_body(lease))
        self.assertEqual(released["drainUntil"], lease["expiresAt"] + DRAIN)
        self.clock.advance(100)
        self.assert_code("LEASE_DRAINING", lambda: self.call("/v1/promote", target="oci", expectedEpoch=1, idempotencyKey="early"))

    def test_restart_revokes_old_lease_and_quarantines(self):
        self.ready()
        lease = self.acquire()
        self.authority.close()
        self.authority = Authority(self.config, self.clock)
        status = self.status()
        self.assertEqual(status["epoch"], 2)
        self.assertGreaterEqual(status["quarantineUntil"], self.clock.wall() + 150)
        self.assertTrue(status["primaryEnrolled"])
        self.assert_code("STALE_EPOCH", lambda: self.call("/v1/lease/renew", "primary", **self.lease_body(lease)))
        self.assert_code("AUTHORITY_QUARANTINED", self.acquire)

    def test_forward_and_backward_time_jumps_quarantine(self):
        self.ready()
        self.acquire()
        epoch = self.status()["epoch"]
        self.clock.timestamp += 600
        status = self.status()
        self.assertEqual(status["epoch"], epoch + 1)
        self.assertGreaterEqual(status["quarantineUntil"], self.clock.wall() + 150)
        self.assert_code("AUTHORITY_QUARANTINED", self.acquire)
        self.clock.timestamp -= 1200
        status = self.status()
        self.assertEqual(status["epoch"], epoch + 2)
        self.assertGreater(status["quarantineUntil"], self.clock.wall() + 150)

    def test_cumulative_small_clock_steps_cannot_bypass_quarantine(self):
        self.ready()
        self.acquire()
        epoch = self.status()["epoch"]
        for _ in range(3):
            self.clock.timestamp += 2.0
            self.status()
        self.assertGreater(self.status()["epoch"], epoch)
        self.assertGreaterEqual(self.status()["quarantineUntil"], self.clock.wall() + 150)

    def test_bad_installation_proof_does_not_enroll(self):
        self.assert_code("INCOMPLETE_INSTALLATION_PROOF", lambda: self.enroll(lambda proof: proof.update(cgroupPids=[1234, 9999])))
        self.assertFalse(self.status()["primaryEnrolled"])
        self.assert_code("INSTALLATION_MISMATCH", lambda: self.enroll(lambda proof: proof.update(guardianSha256="wrong")))

    def test_enrollment_challenge_expires_and_is_one_use(self):
        challenge = self.call("/v1/primary/enroll/challenge", "primary", instanceId="p")
        self.clock.advance(121)
        self.assert_code("INVALID_CHALLENGE", lambda: self.call("/v1/primary/enroll", "primary", instanceId="p", proof={"challengeId":challenge["challengeId"],"nonce":challenge["nonce"]}, signature="x"))
        challenge = self.call("/v1/primary/enroll/challenge", "primary", instanceId="p")
        proof = {"challengeId":challenge["challengeId"],"nonce":challenge["nonce"]}
        self.assert_code("INVALID_SIGNATURE", lambda: self.call("/v1/primary/enroll", "primary", instanceId="p", proof=proof, signature="x"))
        self.assert_code("INVALID_CHALLENGE", lambda: self.call("/v1/primary/enroll", "primary", instanceId="p", proof=proof, signature="x"))

    def test_changed_installation_policy_requires_new_enrollment(self):
        self.ready()
        self.authority.close()
        self.config["enrollmentPolicy"]["guardianSha256"] = "f" * 64
        self.authority = Authority(self.config, self.clock)
        self.assertFalse(self.status()["primaryEnrolled"])
        self.assertFalse(self.status()["armed"])

    def test_concurrent_promoters_cas_once_and_conflicting_key_rejected(self):
        self.ready()
        barrier = threading.Barrier(2)
        results = []
        def promote(key):
            barrier.wait()
            try:
                results.append(self.call("/v1/promote", target="oci", expectedEpoch=1, idempotencyKey=key))
            except AuthorityError as error:
                results.append(error.code)
        threads = [threading.Thread(target=promote, args=(str(i),)) for i in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
        self.assertEqual(self.status()["epoch"], 2)
        winner = next(item for item in results if isinstance(item, dict))
        self.assert_code("IDEMPOTENCY_CONFLICT", lambda: self.call("/v1/promote", target="oci", expectedEpoch=2, idempotencyKey=winner["idempotencyKey"]))

    def test_http_status_and_auth_do_not_expose_role_tokens(self):
        server = make_server(self.authority, "127.0.0.1:0")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = AuthorityClient("http://127.0.0.1:%d" % server.server_port, self.config["tokens"]["oci"])
            status = client.request("GET", "/v1/status")
            self.assertEqual(status["activeNode"], "primary")
            self.assertNotIn(self.config["tokens"]["primary"], json.dumps(status))
            bad = AuthorityClient("http://127.0.0.1:%d" % server.server_port, "bad")
            with self.assertRaises(RemoteError): bad.request("GET", "/v1/status")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class GuardianTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.clock = FakeClock()
        self.config = {"authorityUrl": "http://127.0.0.1:34210", "node": "oci", "token": "o" * 40, "command": [os.path.abspath(os.sys.executable), "-c", "pass"], "leaseFile": str(Path(self.directory.name) / "lease.json"), "systemdUnit": "cbte-guard-test.service"}

    def tearDown(self):
        self.directory.cleanup()

    def lease(self, guardian):
        return {"node": "oci", "instanceId": guardian.instance_id, "epoch": 2, "leaseId": "lease-secret-id", "ttlSeconds": 90, "stopMarginSeconds": 20, "expiresAt": self.clock.wall() + 90}

    def test_no_shell_command_handlers(self):
        invalid = dict(self.config, command=["/bin/sh", "-c", "anything"])
        with self.assertRaises(ValueError): validate_command(invalid)

    def test_late_or_changed_lease_is_rejected(self):
        guardian = Guardian(self.config, client=mock.Mock(), clock=self.clock)
        started = self.clock.monotonic()
        self.clock.advance(75)
        with self.assertRaises(RemoteError): guardian.adopt(self.lease(guardian), started)
        guardian.adopt(self.lease(guardian), self.clock.monotonic())
        changed = dict(self.lease(guardian), epoch=3)
        with self.assertRaises(RemoteError): guardian.adopt(changed, self.clock.monotonic())

    def test_public_lease_and_child_environment_have_no_authority_credentials(self):
        guardian = Guardian(self.config, client=mock.Mock(), clock=self.clock)
        guardian.adopt(self.lease(guardian), self.clock.monotonic())
        guardian.publish("active")
        saved = json.loads(Path(self.config["leaseFile"]).read_text())
        self.assertEqual(saved["epoch"], 2)
        self.assertEqual(saved["validUntilUnixMs"], int((self.clock.wall() + 70) * 1000))
        self.assertNotIn(self.config["token"], json.dumps(saved))
        self.assertNotIn("lease-secret-id", json.dumps(saved))
        if os.name == "posix":
            self.assertEqual(Path(self.config["leaseFile"]).stat().st_mode & 0o777, 0o644)
        with mock.patch("recovery.guardian.subprocess.Popen") as spawn:
            guardian._spawn()
        kwargs = spawn.call_args.kwargs
        self.assertEqual(kwargs["env"]["CBTE_FLEET_EPOCH"], "2")
        self.assertEqual(kwargs["env"]["CBTE_FLEET_NODE"], "oci")
        self.assertEqual(kwargs["env"]["CBTE_FLEET_LEASE_FILE"], self.config["leaseFile"])
        self.assertTrue(kwargs["start_new_session"])
        self.assertNotIn(self.config["token"], kwargs["env"].values())

    def test_cancelled_acquisition_never_spawns_workload(self):
        client = mock.Mock()
        guardian = Guardian(self.config, client=client, clock=self.clock, process_factory=mock.Mock())
        guardian.stop_event.set()
        self.assertEqual(guardian.run(), 0)
        guardian.process_factory.assert_not_called()
        client.request.assert_not_called()

    def test_cancelled_network_request_does_not_wait_for_transport(self):
        blocker = threading.Event()
        client = mock.Mock()
        client.request.side_effect = lambda *args: blocker.wait(5)
        guardian = Guardian(self.config, client=client)
        timer = threading.Timer(0.1, guardian.stop_event.set)
        timer.start()
        started = time.monotonic()
        try:
            with self.assertRaises(RemoteError) as caught:
                guardian.call("GET", "/v1/status")
            self.assertEqual(caught.exception.code, "CANCELLED")
            self.assertLess(time.monotonic() - started, 1)
        finally:
            blocker.set()
            timer.join()
            guardian.pending_thread.join(timeout=1)

    def test_standby_denial_never_spawns_workload(self):
        client = mock.Mock()
        guardian = Guardian(self.config, client=client, clock=self.clock, process_factory=mock.Mock(), fencer=mock.Mock())
        def request(method, path, payload=None):
            if path == "/v1/status": return {"ok": True, "epoch": 1}
            guardian.stop_event.set()
            raise RemoteError("NOT_ACTIVE_NODE")
        client.request.side_effect = request
        guardian.run()
        guardian.process_factory.assert_not_called()

    def test_watchdog_fences_independently_of_network_or_status_writes(self):
        fencer = mock.Mock()
        guardian = Guardian(self.config, client=mock.Mock(), clock=self.clock, fencer=fencer)
        guardian.adopt(self.lease(guardian), self.clock.monotonic())
        guardian.child = mock.Mock(pid=123)
        guardian.start_watchdog()
        self.clock.advance(90 - 20 - STOP_BUDGET + 0.1)
        self.assertTrue(guardian.fence_event.wait(1))
        guardian.watchdog.join(timeout=1)
        fencer.fence.assert_called_once_with()
        guardian.client.request.assert_not_called()

    def test_acquire_precedes_spawn_and_startup_grant_is_already_present(self):
        holder = {}
        class Client:
            def request(self, method, path, payload=None):
                guardian = holder["guardian"]
                if path == "/v1/status": return {"ok": True, "epoch": 2}
                if path == "/v1/lease/acquire":
                    holder["acquired"] = True
                    return holder["test"].lease(guardian)
                return {"ok": True}
        def spawn():
            self.assertTrue(holder["acquired"])
            data = json.loads(Path(self.config["leaseFile"]).read_text())
            self.assertEqual(data["state"], "active")
            self.assertGreater(data["validUntilUnixMs"], self.clock.wall() * 1000)
            process = mock.Mock(pid=123, returncode=0)
            process.poll.return_value = 0
            return process
        guardian = Guardian(self.config, client=Client(), clock=self.clock, process_factory=spawn, fencer=mock.Mock())
        holder.update(guardian=guardian, test=self)
        with mock.patch("recovery.guardian.stop_group", return_value=True):
            self.assertEqual(guardian.run(), 0)

    def test_missing_or_unverified_systemd_unit_prevents_activation(self):
        config = dict(self.config)
        del config["systemdUnit"]
        with self.assertRaises(ValueError): Guardian(config, client=mock.Mock())
        guardian = Guardian(self.config, client=mock.Mock(), process_factory=mock.Mock())
        with mock.patch("recovery.guardian.inspect_guardian_unit", side_effect=ValueError("MainPID mismatch")):
            with self.assertRaises(ValueError): guardian.run()
        guardian.process_factory.assert_not_called()
        guardian.client.request.assert_not_called()

    def test_fencer_only_targets_its_verified_own_unit(self):
        runner, kill_self = mock.Mock(), mock.Mock()
        observed = {"unit":"cbte-guard-test.service","mainPid":os.getpid(),"killMode":"control-group","execStartVerified":True,"cgroup":"/system.slice/cbte-guard-test.service","cgroupDirectory":self.directory.name}
        fencer = SystemdUnitFencer(observed, runner=runner, kill_self=kill_self)
        fencer.fence()
        fencer.fence()
        self.assertEqual(runner.call_count, 1)
        self.assertEqual(runner.call_args.args[0], ["/usr/bin/systemctl","kill","--kill-who=all","--signal=SIGKILL","cbte-guard-test.service"])
        self.assertEqual(runner.call_args.kwargs["timeout"], 2)
        kill_self.assert_called_once_with()
        with self.assertRaises(ValueError): SystemdUnitFencer(dict(observed, mainPid=os.getpid()+1))

    def test_primary_companions_are_fixed_and_fenced_before_bot_without_core(self):
        with self.assertRaises(ValueError): validate_command(dict(self.config,node="primary",companionUnits=["mysql.service"]))
        runner, kill_self=mock.Mock(),mock.Mock()
        observed={"unit":"cbte.service","mainPid":os.getpid(),"killMode":"control-group","execStartVerified":True,"cgroup":"/system.slice/cbte.service","cgroupDirectory":self.directory.name,"companionUnits":[{"unit":unit,"installed":False} for unit in PRIMARY_COMPANIONS]}
        fencer=SystemdUnitFencer(observed,runner=runner,kill_self=kill_self)
        fencer.fence()
        units=[call.args[0][-1] for call in runner.call_args_list]
        self.assertEqual(units,["cbte-admin-analysis.service","cbte-admin-reports.service","cbte.service"])
        self.assertNotIn("cbte-admin.service",units)
        self.assertNotIn("cbte-admin-executor.service",units)
        self.assertTrue(all(call.kwargs["timeout"]==2 for call in runner.call_args_list))
        self.assertGreaterEqual(STOP_BUDGET,12)

    def test_companion_kill_failure_does_not_skip_remaining_targets(self):
        runner=mock.Mock(side_effect=[subprocess.TimeoutExpired(["systemctl"],2),mock.Mock(returncode=1),mock.Mock(returncode=0)])
        observed={"unit":"cbte.service","mainPid":os.getpid(),"killMode":"control-group","execStartVerified":True,"cgroup":"/system.slice/cbte.service","cgroupDirectory":self.directory.name,"companionUnits":[{"unit":unit,"installed":False} for unit in PRIMARY_COMPANIONS]}
        kill_self=mock.Mock()
        SystemdUnitFencer(observed,runner=runner,kill_self=kill_self).fence()
        self.assertEqual(runner.call_count,3)
        kill_self.assert_called_once()

    def test_companion_inspection_requires_control_group_and_trusted_fragments(self):
        def response(argv,**kwargs):
            unit=argv[2]
            return mock.Mock(returncode=0,stdout="LoadState=loaded\nKillMode=control-group\nFragmentPath=/etc/systemd/system/%s\nDropInPaths=/etc/systemd/system/%s.d/guard.conf\nControlGroup=\n"%(unit,unit))
        with mock.patch("recovery.guardian.subprocess.run",side_effect=response),mock.patch("recovery.guardian.trusted_unit_file",return_value="hash") as trust:
            observed=inspect_companions(dict(self.config,node="primary"))
        self.assertEqual([row["unit"] for row in observed],list(PRIMARY_COMPANIONS))
        self.assertEqual(trust.call_count,4)
        bad=mock.Mock(returncode=0,stdout="LoadState=loaded\nKillMode=mixed\nFragmentPath=/etc/systemd/system/cbte-admin-analysis.service\n")
        with mock.patch("recovery.guardian.subprocess.run",return_value=bad):
            with self.assertRaises(ValueError): inspect_companions(dict(self.config,node="primary"))
        absent=mock.Mock(returncode=1,stdout="LoadState=not-found\n")
        with mock.patch("recovery.guardian.subprocess.run",return_value=absent):
            self.assertTrue(all(not row["installed"] for row in inspect_companions(dict(self.config,node="primary"))))

    @unittest.skipUnless(os.name == "posix", "requires POSIX detached process fixture")
    def test_unit_fencer_stops_detached_grandchild_that_pgkill_would_miss(self):
        pidfile = str(Path(self.directory.name) / "detached.pid")
        child_code = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"
        script = "import subprocess,sys,time,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);p=subprocess.Popen([sys.executable,'-c',%r],start_new_session=True);open(%r,'w').write(str(p.pid));time.sleep(60)" % (child_code,pidfile)
        process = subprocess.Popen([os.sys.executable,"-c",script],start_new_session=True)
        detached = None
        try:
            deadline = time.monotonic()+3
            while not Path(pidfile).exists() and time.monotonic()<deadline: time.sleep(0.02)
            detached = int(Path(pidfile).read_text())
            self.assertNotEqual(os.getpgid(detached), process.pid)
            def fake_systemd(argv, **kwargs):
                self.assertEqual(argv[-1], "cbte-guard-test.service")
                # A unit manager tracks descendants regardless of their PG/session.
                os.kill(detached, 9)
                os.killpg(process.pid, 9)
                return mock.Mock(returncode=0)
            observed={"unit":"cbte-guard-test.service","mainPid":os.getpid(),"killMode":"control-group","execStartVerified":True,"cgroup":"/fake/unit","cgroupDirectory":self.directory.name}
            fencer=SystemdUnitFencer(observed,runner=fake_systemd,kill_self=lambda:None)
            fencer.fence()
            process.wait(timeout=2)
            deadline=time.monotonic()+2
            while Path("/proc/%d/stat"%detached).exists() and time.monotonic()<deadline:
                if Path("/proc/%d/stat"%detached).read_text().split(") ",1)[1].startswith("Z"): break
                time.sleep(0.02)
            if Path("/proc/%d/stat"%detached).exists():
                self.assertTrue(Path("/proc/%d/stat"%detached).read_text().split(") ",1)[1].startswith("Z"))
        finally:
            for pid in (detached,process.pid):
                if pid:
                    try: os.kill(pid,9)
                    except ProcessLookupError: pass
            process.wait(timeout=2)

    @unittest.skipUnless(os.name == "posix", "requires POSIX process groups")
    def test_entire_process_group_is_bounded_even_when_child_ignores_term(self):
        script = "import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); os.fork(); time.sleep(60)"
        process = subprocess.Popen([os.sys.executable, "-c", script], start_new_session=True)
        try:
            time.sleep(0.15)
            started = time.monotonic()
            self.assertTrue(stop_group(process))
            self.assertLess(time.monotonic() - started, 7)
            self.assertIsNotNone(process.poll())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    unittest.main()
