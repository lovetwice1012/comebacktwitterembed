"""Offline I/O-stall policy tests. No host tuning, real fencing or network."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

from recovery import guardian


class Clock:
    def __init__(self):
        self.value = 500.0
    def monotonic(self):
        return self.value
    def wall(self):
        return 1800000000 + self.value
    def advance(self, seconds):
        self.value += seconds


POLICY = {"enabled": True, "physicalDevice": "sda", "logicalDevice": "dm-0", "thresholdSeconds": 180, "startupGraceSeconds": 300}


def sample(**changes):
    return {"pid": 123, "parentPid": os.getpid(), "startTicks": 456, "state": "D",
            "physicalWrites": 100, "logicalWrites": 200, "physicalInflight": 0,
            "logicalInflight": 135, "wbtInflight": 96, **changes}


class PolicyTests(unittest.TestCase):
    def watch(self):
        clock = Clock()
        return guardian.PrimaryIoWatch(POLICY, 123, os.getpid(), clock), clock

    def test_policy_is_opt_in_primary_only_and_cannot_select_arbitrary_paths_or_short_thresholds(self):
        self.assertIsNone(guardian.primary_io_policy({"node": "primary"}))
        self.assertIsNone(guardian.primary_io_policy({"primaryIoWatch": {"enabled": False}}))
        self.assertEqual(guardian.primary_io_policy({"node": "primary", "primaryIoWatch": POLICY}), POLICY)
        for node, value in [("oci", POLICY), ("primary", POLICY | {"physicalDevice": "../sda"}),
                            ("primary", POLICY | {"logicalDevice": "dm-1"}), ("primary", POLICY | {"thresholdSeconds": 179}),
                            ("primary", POLICY | {"startupGraceSeconds": 299}), ("primary", POLICY | {"enabled": "true"}),
                            ("primary", POLICY | {"path": "/private"})]:
            with self.subTest(node=node, value=value), self.assertRaises(ValueError):
                guardian.primary_io_policy({"node": node, "primaryIoWatch": value})

    def test_only_continuous_conjunction_after_startup_grace_confirms(self):
        watch, clock = self.watch()
        for _ in range(60):
            self.assertFalse(watch.observe(sample()))
            clock.advance(5)
        self.assertFalse(watch.observe(sample()))  # grace ends; timer starts now
        for _ in range(35):
            clock.advance(5)
            self.assertFalse(watch.observe(sample()))
        clock.advance(5)
        self.assertTrue(watch.observe(sample()))
        self.assertEqual(watch.snapshot()["state"], "confirmed")
        self.assertEqual(watch.snapshot()["continuousSeconds"], 180)

    def test_each_missing_condition_resets_instead_of_fencing(self):
        variants = [sample(state="S"), sample(physicalInflight=1), sample(logicalInflight=0), sample(wbtInflight=0),
                    None, sample(state=[]), sample(wbtInflight=-1), sample(physicalWrites=True), sample() | {"privatePath": "/secret"}]
        for value in variants:
            with self.subTest(value=value):
                watch, clock = self.watch()
                clock.advance(300)
                watch.observe(sample())
                for _ in range(60):
                    clock.advance(5)
                    self.assertFalse(watch.observe(value))
                self.assertFalse(watch.confirmed)
                self.assertEqual(watch.snapshot()["continuousSeconds"], 0)
                self.assertNotIn("/secret", json.dumps(watch.snapshot()))

    def test_write_progress_unknown_and_sample_gap_restart_the_full_interval(self):
        for reset in ["physical", "logical", "unknown", "gap", "counter_reset"]:
            with self.subTest(reset=reset):
                watch, clock = self.watch()
                clock.advance(300)
                current = sample()
                watch.observe(current)
                for _ in range(34):
                    clock.advance(5); self.assertFalse(watch.observe(current))
                if reset == "physical":
                    current = sample(physicalWrites=101)
                elif reset == "logical":
                    current = sample(logicalWrites=201)
                elif reset == "counter_reset":
                    current = sample(physicalWrites=1)
                elif reset == "gap":
                    clock.advance(20)
                clock.advance(5)
                self.assertFalse(watch.observe(None if reset == "unknown" else current))
                self.assertEqual(watch.snapshot()["continuousSeconds"], 0)
                for _ in range(35):
                    clock.advance(5); self.assertFalse(watch.observe(current))

    def test_pid_reuse_or_different_owner_never_rebinds_the_watched_child(self):
        for replacement in [sample(startTicks=457), sample(pid=124), sample(parentPid=os.getpid() + 1)]:
            watch, clock = self.watch()
            clock.advance(300)
            watch.observe(sample())
            for _ in range(50):
                clock.advance(5); self.assertFalse(watch.observe(replacement))
            self.assertEqual(watch.snapshot()["reason"], "child_identity_changed")
            for _ in range(50):
                clock.advance(5); self.assertFalse(watch.observe(sample()))

    def test_one_blocked_sampler_is_unknown_and_does_not_accumulate_threads(self):
        watch, clock = self.watch()
        blocked, entered = threading.Event(), threading.Event()
        calls = []
        def read(*args):
            calls.append(args); entered.set(); blocked.wait(3); return sample()
        watch.sampler = read
        try:
            watch.poll()
            self.assertTrue(entered.wait(1))
            for _ in range(200):
                clock.advance(5); self.assertFalse(watch.poll())
            self.assertEqual(len(calls), 1)
            self.assertEqual(watch.snapshot()["reason"], "sample_timeout")
        finally:
            blocked.set(); watch.pending.join(timeout=1)
        watch.poll()
        self.assertEqual(watch.snapshot()["reason"], "sample_too_late")

    def test_failed_sampler_thread_creation_is_unknown_not_a_watchdog_exception(self):
        watch, _ = self.watch()
        with mock.patch.object(guardian.threading.Thread, "start", side_effect=RuntimeError("fixture thread limit")):
            self.assertFalse(watch.poll())
        self.assertEqual(watch.snapshot()["reason"], "sampler_start_failed")
        self.assertIsNone(watch.pending)


class SamplerTests(unittest.TestCase):
    def stat(self, ticks=456, owner=None, state="D"):
        fields = [state, str(os.getpid() if owner is None else owner)] + ["0"] * 17 + [str(ticks)]
        return "123 (node (worker) name) " + " ".join(fields)

    def test_sampler_uses_only_fixed_bounded_reads_and_checks_identity_on_both_sides(self):
        values = {"/proc/123/stat": self.stat(), "/proc/diskstats": "8 0 sda 1 0 1 0 100 0 100 0 0 0 0\n253 0 dm-0 1 0 1 0 200 0 200 0 135 0 0\n",
                  "/sys/kernel/debug/block/sda/rqos/wbt/inflight": "0: inflight 96\n1: inflight 0\n2: inflight 0\n"}
        calls = []
        def read(filename, limit):
            calls.append((filename, limit)); return values[filename]
        with mock.patch.object(guardian, "_bounded_kernel_text", side_effect=read):
            self.assertEqual(guardian.sample_primary_io(123, os.getpid()), sample())
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(limit <= 1024 * 1024 for _, limit in calls))
        changing = [self.stat(), values["/proc/diskstats"], values["/sys/kernel/debug/block/sda/rqos/wbt/inflight"], self.stat(ticks=457)]
        with mock.patch.object(guardian, "_bounded_kernel_text", side_effect=changing), self.assertRaises(ValueError):
            guardian.sample_primary_io(123, os.getpid())
        with self.assertRaises(ValueError):
            guardian._io_process_stat(self.stat(owner=99), 123, os.getpid())


class GuardianIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.config = {"node": "primary", "token": "p" * 40, "authorityUrl": "http://127.0.0.1:34210", "command": [os.path.abspath(os.sys.executable)],
                       "leaseFile": str(Path(self.directory.name) / "lease.json"), "systemdUnit": "cbte.service", "primaryIoWatch": POLICY}
    def tearDown(self):
        self.directory.cleanup()
    def lease(self, instance):
        return {"node": "primary", "instanceId": instance.instance_id, "epoch": 1, "leaseId": "private-lease-id", "ttlSeconds": 90, "expiresAt": self.clock.wall() + 90}

    def test_stuck_sampling_does_not_delay_the_existing_hard_lease_fence(self):
        blocker, entered = threading.Event(), threading.Event()
        def sampler(*_):
            entered.set(); blocker.wait(3); return sample()
        fence = mock.Mock()
        instance = guardian.Guardian(self.config, client=mock.Mock(), clock=self.clock, fencer=fence, io_sampler=sampler)
        instance.adopt(self.lease(instance), self.clock.monotonic())
        instance.child = mock.Mock(pid=123)
        try:
            instance.start_watchdog()
            self.assertTrue(entered.wait(1))
            self.clock.advance(90)
            self.assertTrue(instance.fence_event.wait(1))
            instance.watchdog.join(timeout=1)
            fence.fence.assert_called_once()
            self.assertFalse(instance.io_watch.confirmed)
        finally:
            blocker.set(); instance.child_done.set()
            if instance.io_watch.pending: instance.io_watch.pending.join(timeout=1)

    def test_confirmed_stall_latches_no_renewal_and_fences_once_even_if_status_write_hangs(self):
        blocker, published = threading.Event(), threading.Event()
        fence, client = mock.Mock(), mock.Mock()
        instance = guardian.Guardian(self.config, client=client, clock=self.clock, fencer=fence)
        instance.adopt(self.lease(instance), self.clock.monotonic())
        instance.child = mock.Mock(pid=123)
        confirmed = mock.Mock(confirmed=True)
        confirmed.poll.return_value = True
        def publish(*_):
            published.set(); blocker.wait(3)
        try:
            with mock.patch.object(guardian, "PrimaryIoWatch", return_value=confirmed), mock.patch.object(instance, "publish", side_effect=publish):
                instance.start_watchdog()
                self.assertTrue(instance.fence_event.wait(1))
                instance.watchdog.join(timeout=1)
                self.assertTrue(published.wait(1))
                self.assertTrue(instance.stop_event.is_set())
                fence.fence.assert_called_once()
                instance._fence_once()
                fence.fence.assert_called_once()
                with self.assertRaises(guardian.RemoteError): instance.call("POST", "/v1/lease/renew", instance.lease_body())
                with self.assertRaises(guardian.RemoteError): instance.adopt(self.lease(instance), self.clock.monotonic())
                client.request.assert_not_called()
        finally:
            blocker.set(); instance.child_done.set()

    def test_public_lease_contains_compact_evidence_and_cannot_republish_an_active_permit_after_stall(self):
        instance = guardian.Guardian(self.config, client=mock.Mock(), clock=self.clock, fencer=mock.Mock())
        instance.adopt(self.lease(instance), self.clock.monotonic())
        watch = guardian.PrimaryIoWatch(POLICY, 123, os.getpid(), self.clock)
        self.clock.advance(300)
        watch.observe(sample())
        for _ in range(37): self.clock.advance(5); watch.observe(sample())
        self.assertTrue(watch.confirmed)
        instance.io_watch = watch
        instance.publish("active")
        raw = Path(self.config["leaseFile"]).read_text()
        state = json.loads(raw)
        self.assertEqual(state["state"], "io_stalled")
        self.assertEqual(state["validUntilUnixMs"], 0)
        self.assertEqual(state["reason"], "PRIMARY_IO_STALL")
        self.assertEqual(state["primaryIoWatch"]["evidence"]["wbtInflight"], 96)
        self.assertLess(len(raw), 4096)
        self.assertNotIn(self.config["token"], raw)
        self.assertNotIn("private-lease-id", raw)
        self.assertNotIn("/proc/", raw)
        self.assertNotIn("command", raw)


if __name__ == "__main__":
    unittest.main()
