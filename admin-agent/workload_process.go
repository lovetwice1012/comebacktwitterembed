package main

import (
	"errors"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const heartbeatIdentityFreshness = 90 * time.Second

// procFiles pins each process directory while verifying and reading evidence.
// A recycled numeric PID must not redirect later reads to a different process.
type procFiles struct {
	root, cgroups string
	processes     map[int]*os.Root
}

func (p *procFiles) close() {
	for _, root := range p.processes {
		_ = root.Close()
	}
}

func readSmallFile(file *os.File, limit int64) ([]byte, error) {
	defer file.Close()
	data, e := io.ReadAll(io.LimitReader(file, limit+1))
	if e == nil && int64(len(data)) > limit {
		e = errors.New("process evidence exceeded its bound")
	}
	return data, e
}

func (p *procFiles) directory(pid int) (*os.Root, error) {
	if pid <= 0 {
		return nil, errors.New("invalid PID")
	}
	if root := p.processes[pid]; root != nil {
		return root, nil
	}
	root, e := os.OpenRoot(filepath.Join(p.root, strconv.Itoa(pid)))
	if e == nil {
		p.processes[pid] = root
	}
	return root, e
}

func (p *procFiles) read(pid int, name string) ([]byte, error) {
	root, e := p.directory(pid)
	if e != nil {
		return nil, e
	}
	file, e := root.Open(name)
	if e != nil {
		return nil, e
	}
	return readSmallFile(file, 256<<10)
}

func exactProcessID(value any) int {
	var n int64
	switch v := value.(type) {
	case int:
		n = int64(v)
	case int64:
		n = v
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Trunc(v) != v || v > math.MaxInt32 {
			return 0
		}
		n = int64(v)
	case string:
		var e error
		n, e = strconv.ParseInt(v, 10, 32)
		if e != nil {
			return 0
		}
	default:
		return 0
	}
	if n <= 0 || n > math.MaxInt32 {
		return 0
	}
	return int(n)
}

func processStartTicks(data []byte, pid int) string {
	s := string(data)
	open, end := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if open < 1 || end <= open || strings.TrimSpace(s[:open]) != strconv.Itoa(pid) {
		return ""
	}
	fields := strings.Fields(s[end+1:])
	// stat field 22 is starttime; fields[0] is field 3 (state).
	if len(fields) < 20 {
		return ""
	}
	start, e := strconv.ParseUint(fields[19], 10, 64)
	if e != nil || start == 0 {
		return ""
	}
	return fields[19]
}

func isBotNodeCommand(comm, command []byte) bool {
	name := strings.TrimSpace(string(comm))
	if name != "node" && name != "nodejs" {
		return false
	}
	args := strings.Split(strings.TrimRight(string(command), "\x00"), "\x00")
	if len(args) < 2 {
		return false
	}
	if first := path.Base(args[0]); first != "node" && first != "nodejs" {
		return false
	}
	for _, arg := range args[1:] {
		if path.Base(arg) == "index.js" {
			return true
		}
	}
	return false
}

type systemdCgroup struct{ hierarchy, name string }

func parseSystemdCgroup(data []byte) (systemdCgroup, bool) {
	var legacy, unified systemdCgroup
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 || !strings.HasPrefix(parts[2], "/") || path.Clean(parts[2]) != parts[2] || parts[2] == "/" {
			continue
		}
		if parts[0] == "0" && parts[1] == "" {
			unified = systemdCgroup{"unified", parts[2]}
		}
		for _, controller := range strings.Split(parts[1], ",") {
			if controller == "name=systemd" {
				legacy = systemdCgroup{"systemd", parts[2]}
			}
		}
	}
	// Hybrid hosts expose both hierarchies in /proc. systemd still owns the
	// explicit name=systemd hierarchy there, mounted at /sys/fs/cgroup/systemd;
	// selecting 0:: would incorrectly look for a pure-v2 root membership file.
	if legacy.name != "" {
		return legacy, true
	}
	return unified, unified.name != ""
}

func (p *procFiles) group(pid int) (systemdCgroup, bool) {
	data, e := p.read(pid, "cgroup")
	if e != nil {
		return systemdCgroup{}, false
	}
	return parseSystemdCgroup(data)
}

func (p *procFiles) members(group systemdCgroup) (map[int]bool, error) {
	root, e := os.OpenRoot(p.cgroups)
	if e != nil {
		return nil, e
	}
	defer root.Close()
	name := strings.TrimPrefix(group.name, "/")
	if group.hierarchy == "systemd" {
		name = path.Join("systemd", name)
	}
	file, e := root.Open(filepath.FromSlash(path.Join(name, "cgroup.procs")))
	if e != nil {
		return nil, e
	}
	data, e := readSmallFile(file, 256<<10)
	if e != nil {
		return nil, e
	}
	members := map[int]bool{}
	for _, value := range strings.Fields(string(data)) {
		if pid := exactProcessID(value); pid > 0 {
			members[pid] = true
		}
	}
	return members, nil
}

func freshProcessHeartbeat(heartbeat Object, occurred, persisted string, at time.Time) bool {
	if heartbeat["timestampInferred"] == true || first(heartbeat, "triggerType", "trigger_type") == "diagnostic" || first(heartbeat, "triggerType", "trigger_type") == "admin_operation" {
		return false
	}
	for _, stamp := range []string{occurred, persisted} {
		t, e := time.Parse(time.RFC3339Nano, stamp)
		if e != nil || at.Sub(t) < -30*time.Second || at.Sub(t) > heartbeatIdentityFreshness {
			return false
		}
	}
	return exactProcessID(nested(heartbeat, "details")["pid"]) > 0
}

// Only systemd's trusted MainPID can be inspected before the membership check.
// A child/grandchild PID from telemetry must first occur in that unit's cgroup.procs.
func workloadProcessEvidence(procRoot, cgroupRoot string, unit, heartbeat, previous Object, occurred, persisted string, at time.Time) (Object, Object) {
	mainPID := exactProcessID(unit["MainPID"])
	identity := Object{"available": false, "unitMainPID": mainPID, "unitInvocationID": unit["InvocationID"], "checkedAt": at.UTC().Format(timestampLayout)}
	unavailable := func(reason string) (Object, Object) {
		identity["reason"] = reason
		return identity, Object{"available": false, "reason": reason, "scope": "bot_workload_process"}
	}
	if mainPID == 0 {
		return unavailable("unit_main_pid_unavailable")
	}
	files := &procFiles{root: procRoot, cgroups: cgroupRoot, processes: map[int]*os.Root{}}
	defer files.close()
	mainStat, e := files.read(mainPID, "stat")
	mainStart := processStartTicks(mainStat, mainPID)
	if e != nil || mainStart == "" {
		return unavailable("unit_main_identity_unavailable")
	}
	mainComm, _ := files.read(mainPID, "comm")
	mainCommand, _ := files.read(mainPID, "cmdline")
	mainIsBot := isBotNodeCommand(mainComm, mainCommand)
	identity["wrapped"] = !mainIsBot
	identity["unitMainStartTicks"] = mainStart
	pid, start, source := mainPID, mainStart, "unit_main_process"
	var group systemdCgroup
	if !mainIsBot {
		var ok bool
		group, ok = files.group(mainPID)
		if !ok || group.name != str(unit["ControlGroup"]) || str(unit["InvocationID"]) == "" {
			return unavailable("supervisor_unit_cgroup_unverified")
		}
		identity["unitControlGroup"] = group.name
		identity["unitCgroupHierarchy"] = group.hierarchy
		source = "fresh_authenticated_heartbeat"
		if freshProcessHeartbeat(heartbeat, occurred, persisted, at) {
			pid = exactProcessID(nested(heartbeat, "details")["pid"])
		} else {
			if previous["available"] != true || previous["verifiedFromFreshHeartbeat"] != true || exactProcessID(previous["unitMainPID"]) != mainPID || str(previous["unitInvocationID"]) != str(unit["InvocationID"]) || str(previous["unitMainStartTicks"]) != mainStart || str(previous["unitControlGroup"]) != group.name {
				return unavailable("supervisor_has_no_verified_bot_pid")
			}
			pid = exactProcessID(previous["pid"])
			if pid != exactProcessID(nested(heartbeat, "details")["pid"]) || first(previous, "heartbeatBootId") != first(heartbeat, "bootId", "boot_id") {
				return unavailable("retained_heartbeat_identity_changed")
			}
			source = "retained_verified_heartbeat"
		}
		members, e := files.members(group)
		if e != nil || !members[mainPID] {
			return unavailable("unit_membership_unavailable")
		}
		if pid == mainPID || !members[pid] {
			return unavailable("heartbeat_pid_outside_bot_workload")
		}
		// Candidate process files are read only after its membership is established.
		candidateGroup, ok := files.group(pid)
		if !ok || candidateGroup != group {
			return unavailable("heartbeat_pid_cgroup_mismatch")
		}
		stat, e := files.read(pid, "stat")
		start = processStartTicks(stat, pid)
		comm, _ := files.read(pid, "comm")
		command, _ := files.read(pid, "cmdline")
		if e != nil || start == "" || !isBotNodeCommand(comm, command) {
			return unavailable("heartbeat_pid_is_not_bot_node_command")
		}
		if source == "retained_verified_heartbeat" && str(previous["processStartTicks"]) != start {
			return unavailable("retained_workload_pid_reused")
		}
		identity["verifiedFromFreshHeartbeat"] = true
		identity["heartbeatBootId"] = first(heartbeat, "bootId", "boot_id")
		identity["verifiedAt"] = at.UTC().Format(timestampLayout)
		if source == "retained_verified_heartbeat" {
			identity["verifiedAt"] = previous["verifiedAt"]
		}
	}
	evidence := func(name string) Object {
		data, e := files.read(pid, name)
		if e != nil {
			return Object{"available": false, "error": e.Error()}
		}
		return Object{"available": true, "raw": string(data), "truncated": false}
	}
	process := Object{"available": true, "pid": pid, "scope": "bot_workload_process", "identitySource": source, "status": evidence("status"), "io": evidence("io"), "stat": evidence("stat")}
	root, _ := files.directory(pid)
	fd, e := root.Open("fd")
	if e == nil {
		entries, readErr := fd.ReadDir(65537)
		_ = fd.Close()
		if readErr != nil && readErr != io.EOF {
			process["fdCountUnavailable"] = readErr.Error()
		} else if len(entries) > 65536 {
			process["fdCountLowerBound"] = 65536
		} else {
			process["fdCount"] = len(entries)
		}
	} else {
		process["fdCountUnavailable"] = e.Error()
	}
	// The pinned directories prevent PID-reuse reads. Recheck membership before publishing.
	finalStat, _ := files.read(pid, "stat")
	finalMain, _ := files.read(mainPID, "stat")
	if processStartTicks(finalStat, pid) != start || processStartTicks(finalMain, mainPID) != mainStart {
		return unavailable("process_identity_changed_during_collection")
	}
	if !mainIsBot {
		members, e := files.members(group)
		currentGroup, ok := files.group(pid)
		currentMainGroup, mainOK := files.group(mainPID)
		if e != nil || !members[pid] || !members[mainPID] || !ok || !mainOK || currentGroup != group || currentMainGroup != group {
			return unavailable("process_ownership_changed_during_collection")
		}
	}
	identity["available"], identity["pid"], identity["processStartTicks"], identity["source"] = true, pid, start, source
	return identity, process
}

func verifiedHeartbeatMatchesWorkload(snapshot Object) bool {
	identity := nested(snapshot, "workloadIdentity")
	unit := nested(snapshot, "unit")
	heartbeat := nested(snapshot, "heartbeat")
	if heartbeat["timestampInferred"] == true {
		return false
	}
	return identity["available"] == true && exactProcessID(identity["pid"]) > 0 && exactProcessID(identity["pid"]) == exactProcessID(nested(nested(snapshot, "heartbeat"), "details")["pid"]) && exactProcessID(identity["unitMainPID"]) == exactProcessID(unit["MainPID"]) && str(identity["unitInvocationID"]) == str(unit["InvocationID"])
}
