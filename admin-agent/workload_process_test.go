package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type workloadFixture struct {
	proc, cgroups string
	unit          Object
	when          time.Time
}

func newWorkloadFixture(t *testing.T) workloadFixture {
	t.Helper()
	root := t.TempDir()
	f := workloadFixture{proc: filepath.Join(root, "proc"), cgroups: filepath.Join(root, "cgroup"), unit: Object{"MainPID": "100", "InvocationID": "guardian-invocation", "ControlGroup": "/system.slice/cbte.service", "ActiveState": "active", "Job": "0"}, when: time.Now().UTC()}
	f.process(t, 100, "python3", "/usr/bin/python3\x00recovery/guardian.py\x00", "1000", "/system.slice/cbte.service", "guardian-resource")
	return f
}

func processStatFixture(pid int, name, start string) string {
	fields := make([]string, 20)
	for i := range fields {
		fields[i] = "0"
	}
	fields[0], fields[19] = "S", start
	return fmt.Sprintf("%d (%s) %s\n", pid, name, strings.Join(fields, " "))
}

func fixtureFile(t *testing.T, filename, data string) {
	t.Helper()
	if e := os.MkdirAll(filepath.Dir(filename), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filename, []byte(data), 0600); e != nil {
		t.Fatal(e)
	}
}

func (f workloadFixture) process(t *testing.T, pid int, comm, command, start, group, marker string) {
	t.Helper()
	root := filepath.Join(f.proc, strconv.Itoa(pid))
	for name, value := range map[string]string{"stat": processStatFixture(pid, comm, start), "comm": comm + "\n", "cmdline": command, "cgroup": "0::" + group + "\n", "status": marker, "io": marker + "-io", "fd/0": "fd0", "fd/1": "fd1"} {
		fixtureFile(t, filepath.Join(root, filepath.FromSlash(name)), value)
	}
}

func (f workloadFixture) members(t *testing.T, pids ...int) {
	var text strings.Builder
	for _, pid := range pids {
		fmt.Fprintln(&text, pid)
	}
	fixtureFile(t, filepath.Join(f.cgroups, "system.slice", "cbte.service", "cgroup.procs"), text.String())
}

func (f workloadFixture) heartbeat(pid int) Object {
	return Object{"kind": "runtime.heartbeat", "boot_id": "bot-boot", "details": Object{"pid": float64(pid)}}
}

func (f workloadFixture) collect(heartbeat, previous Object, occurred time.Time) (Object, Object) {
	return workloadProcessEvidence(f.proc, f.cgroups, f.unit, heartbeat, previous, occurred.Format(timestampLayout), f.when.Format(timestampLayout), f.when)
}

func TestWrappedBotUsesChildAndGrandchildResources(t *testing.T) {
	for _, pid := range []int{200, 300} {
		t.Run(strconv.Itoa(pid), func(t *testing.T) {
			f := newWorkloadFixture(t)
			f.process(t, 250, "python3", "/usr/bin/python3\x00recovery/start_workload.py\x00", "1500", "/system.slice/cbte.service", "wrapper-resource")
			f.process(t, pid, "node", "/usr/local/bin/node\x00/root/comebacktwitterembed/index.js\x00", "2000", "/system.slice/cbte.service", "actual-bot-resource")
			f.members(t, 100, 250, pid)
			identity, process := f.collect(f.heartbeat(pid), Object{}, f.when)
			if identity["available"] != true || exactProcessID(identity["pid"]) != pid || identity["wrapped"] != true || str(identity["source"]) != "fresh_authenticated_heartbeat" {
				t.Fatalf("wrong workload identity: %v", identity)
			}
			if str(nested(process, "status")["raw"]) != "actual-bot-resource" || exactProcessID(process["pid"]) != pid {
				t.Fatalf("guardian resources were exposed as Bot: %v", process)
			}
			if str(f.unit["MainPID"]) != "100" || str(identity["unitInvocationID"]) != "guardian-invocation" {
				t.Fatal("control identity was replaced by workload identity")
			}
		})
	}
}

func TestWrappedBotMembershipUsesActualV1V2AndHybridSystemdHierarchy(t *testing.T) {
	group := "/system.slice/cbte.service"
	for _, scenario := range []struct {
		name, processGroups, hierarchy, mount string
	}{
		{"full-v1", "7:cpu,cpuacct:" + group + "\n1:name=systemd:" + group + "\n", "systemd", "systemd"},
		{"full-v2", "0::" + group + "\n", "unified", ""},
		{"hybrid-legacy-first", "1:name=systemd:" + group + "\n0::" + group + "\n", "systemd", "systemd"},
		{"hybrid-unified-first", "0::" + group + "\n1:name=systemd:" + group + "\n", "systemd", "systemd"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			f := newWorkloadFixture(t)
			f.process(t, 200, "node", "/usr/local/bin/node\x00index.js\x00", "2000", group, "actual-bot")
			for _, pid := range []int{100, 200} {
				fixtureFile(t, filepath.Join(f.proc, strconv.Itoa(pid), "cgroup"), scenario.processGroups)
			}
			fixtureFile(t, filepath.Join(f.cgroups, scenario.mount, "system.slice", "cbte.service", "cgroup.procs"), "100\n200\n")
			if strings.HasPrefix(scenario.name, "hybrid") {
				// Real hybrid layout: the separate unified tree is below unified/;
				// no pure-v2 cgroup.procs exists directly at the cgroup mount root.
				fixtureFile(t, filepath.Join(f.cgroups, "unified", "system.slice", "cbte.service", "cgroup.procs"), "999\n")
			}
			identity, process := f.collect(f.heartbeat(200), Object{}, f.when)
			if identity["available"] != true || exactProcessID(identity["pid"]) != 200 || identity["unitCgroupHierarchy"] != scenario.hierarchy || str(nested(process, "status")["raw"]) != "actual-bot" {
				t.Fatalf("failed %s process binding: %#v %#v", scenario.name, identity, process)
			}
			retained, _ := f.collect(f.heartbeat(200), identity, f.when.Add(-5*time.Minute))
			if retained["available"] != true || retained["source"] != "retained_verified_heartbeat" {
				t.Fatalf("hung-workload evidence was lost in %s: %#v", scenario.name, retained)
			}
		})
	}
}

func TestHybridMembershipCannotUseUnifiedTreeToAuthorizeOutsideBot(t *testing.T) {
	f := newWorkloadFixture(t)
	group := "/system.slice/cbte.service"
	fixtureFile(t, filepath.Join(f.proc, "100", "cgroup"), "0::"+group+"\n1:name=systemd:"+group+"\n")
	fixtureFile(t, filepath.Join(f.cgroups, "systemd", "system.slice", "cbte.service", "cgroup.procs"), "100\n")
	// A decoy candidate occurs only in the other hierarchy. Its /proc files do
	// not exist: rejection must precede reading any candidate resources.
	fixtureFile(t, filepath.Join(f.cgroups, "unified", "system.slice", "cbte.service", "cgroup.procs"), "100\n200\n")
	identity, process := f.collect(f.heartbeat(200), Object{}, f.when)
	if identity["available"] != false || identity["reason"] != "heartbeat_pid_outside_bot_workload" || process["status"] != nil {
		t.Fatalf("hybrid fallback authorized an outside process: %#v %#v", identity, process)
	}
}

func TestWrappedProcessWithoutFreshVerifiedHeartbeatIsUnavailable(t *testing.T) {
	f := newWorkloadFixture(t)
	f.members(t, 100, 200)
	for _, heartbeat := range []Object{Object{}, f.heartbeat(200)} {
		identity, process := f.collect(heartbeat, Object{}, f.when.Add(-5*time.Minute))
		if identity["available"] != false || process["available"] != false || process["status"] != nil {
			t.Fatalf("supervisor was substituted for an unverified Bot: %v %v", identity, process)
		}
	}
}

func TestHeartbeatCannotSelectOutsideCgroupOrNonBotProcess(t *testing.T) {
	for _, scenario := range []string{"not-member", "different-group", "python", "next"} {
		t.Run(scenario, func(t *testing.T) {
			f := newWorkloadFixture(t)
			comm, command, group := "node", "/usr/local/bin/node\x00index.js\x00", "/system.slice/cbte.service"
			f.members(t, 100, 200)
			if scenario == "not-member" {
				f.members(t, 100)
				// No candidate /proc directory exists: rejection occurs using only trusted unit membership.
			} else {
				switch scenario {
				case "different-group":
					group = "/system.slice/other.service"
				case "python":
					comm, command = "python3", "/usr/bin/python3\x00index.js\x00"
				case "next":
					command = "/usr/local/bin/node\x00node_modules/next/dist/bin/next\x00start\x00"
				}
				f.process(t, 200, comm, command, "2000", group, "private-candidate-resource")
			}
			identity, process := f.collect(f.heartbeat(200), Object{}, f.when)
			if identity["available"] != false || process["status"] != nil || strings.Contains(encode(process), "private-candidate-resource") {
				t.Fatalf("unverified resource disclosure: %v %v", identity, process)
			}
			if scenario == "not-member" && identity["reason"] != "heartbeat_pid_outside_bot_workload" {
				t.Fatalf("candidate inspected before membership check: %v", identity)
			}
		})
	}
}

func TestRetainedBindingRequiresSameProcessStartCgroupAndUnitInvocation(t *testing.T) {
	f := newWorkloadFixture(t)
	f.process(t, 200, "node", "/usr/local/bin/node\x00index.js\x00", "2000", "/system.slice/cbte.service", "bot")
	f.members(t, 100, 200)
	heartbeat := f.heartbeat(200)
	verified, _ := f.collect(heartbeat, Object{}, f.when)
	stale := f.when.Add(-5 * time.Minute)
	retained, process := f.collect(heartbeat, verified, stale)
	if retained["available"] != true || retained["source"] != "retained_verified_heartbeat" || exactProcessID(process["pid"]) != 200 {
		t.Fatalf("previously verified hung process could not be observed: %v", retained)
	}
	fixtureFile(t, filepath.Join(f.proc, "200", "stat"), processStatFixture(200, "node", "3000"))
	invalid, _ := f.collect(heartbeat, verified, stale)
	if invalid["available"] != false || invalid["reason"] != "retained_workload_pid_reused" {
		t.Fatalf("PID reuse accepted: %v", invalid)
	}
	f.unit["InvocationID"] = "new-guardian-invocation"
	invalid, _ = f.collect(heartbeat, verified, stale)
	if invalid["available"] != false {
		t.Fatalf("old unit binding reused: %v", invalid)
	}
}

func TestUnwrappedNodeStillUsesSystemdMainPIDWithoutTelemetry(t *testing.T) {
	f := newWorkloadFixture(t)
	f.process(t, 100, "node", "/usr/local/bin/node\x00./index.js\x00", "1000", "/system.slice/cbte.service", "legacy-bot-resource")
	identity, process := f.collect(Object{}, Object{}, f.when)
	if identity["available"] != true || identity["wrapped"] != false || identity["source"] != "unit_main_process" || exactProcessID(process["pid"]) != 100 {
		t.Fatalf("legacy unwrapped Node changed: %v %v", identity, process)
	}
}

func TestHeartbeatIdentityUsesOccurrenceAndPersistenceFreshness(t *testing.T) {
	at := time.Now().UTC()
	heartbeat := Object{"details": Object{"pid": 200}}
	if freshProcessHeartbeat(heartbeat, at.Add(-10*time.Minute).Format(timestampLayout), at.Format(timestampLayout), at) {
		t.Fatal("delayed spool ingestion created fresh PID authority")
	}
	if freshProcessHeartbeat(heartbeat, at.Add(time.Minute).Format(timestampLayout), at.Format(timestampLayout), at) {
		t.Fatal("future heartbeat accepted")
	}
	heartbeat["triggerType"] = "diagnostic"
	if freshProcessHeartbeat(heartbeat, at.Format(timestampLayout), at.Format(timestampLayout), at) {
		t.Fatal("diagnostic event accepted as Bot heartbeat")
	}
}

func TestHungRepairUsesVerifiedWorkloadPIDButControlsUnitInvocation(t *testing.T) {
	a := testApp(t)
	a.failures["dashboard.local.unavailable"], a.failures["bot.heartbeat.stale"] = 3, 3
	dbCheck, _, e := a.store.enqueue("diagnostics.db", Object{}, "fixture-db-ok", a.cfg.Owner, "test")
	if e != nil {
		t.Fatal(e)
	}
	if e = a.store.finish(dbCheck.ID, "succeeded", Object{"results": Object{"connection": Object{"status": "ok"}}}, nil); e != nil {
		t.Fatal(e)
	}
	snapshot := Object{"unit": Object{"MainPID": "100", "InvocationID": "guardian-invocation", "ActiveState": "active", "Job": "0"}, "heartbeat": Object{"details": Object{"pid": float64(300)}}, "heartbeatAgeSeconds": float64(600), "workloadIdentity": Object{"available": false}}
	a.maybeRepairHungBot(context.Background(), snapshot, defaultPolicy())
	var count int
	_ = a.store.db.QueryRow("SELECT COUNT(*) FROM actions WHERE type='service.restart'").Scan(&count)
	if count != 0 {
		t.Fatal("unverified workload triggered restart")
	}
	snapshot["workloadIdentity"] = Object{"available": true, "pid": 300, "unitMainPID": 100, "unitInvocationID": "guardian-invocation", "processStartTicks": "3000"}
	a.maybeRepairHungBot(context.Background(), snapshot, defaultPolicy())
	var input string
	if e = a.store.db.QueryRow("SELECT input FROM actions WHERE type='service.restart'").Scan(&input); e != nil {
		t.Fatal(e)
	}
	request := decode(input).(map[string]any)
	if str(request["expectedInvocationId"]) != "guardian-invocation" || exactProcessID(request["observedWorkloadPID"]) != 300 {
		t.Fatalf("restart targeted child identity instead of unit: %v", request)
	}
	// The queue is inspected only; no executor or real restart runs in this test.
}
