package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestSystemdEnvironmentChildHelper(t *testing.T) {
	if os.Getenv("CBTE_TEST_PROCESS_ENV") != "1" {
		return
	}
	values := Object{}
	for _, key := range []string{"NOTIFY_SOCKET", "WATCHDOG_PID", "WATCHDOG_USEC", "WATCHDOG_DEVICE", "CBTE_TEST_PROCESS_KEEP", "NOTIFY_SOCKET_PROXY"} {
		values[key] = os.Getenv(key)
	}
	_ = json.NewEncoder(os.Stdout).Encode(values)
	os.Exit(0)
}

func TestConfigureProcessStripsSystemdWatchdogOnlyFromChildren(t *testing.T) {
	executable, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	parent := map[string]string{"NOTIFY_SOCKET": "@cbte-fixture-notify", "WATCHDOG_PID": "12345", "WATCHDOG_USEC": "15000000", "WATCHDOG_DEVICE": "/dev/watchdog-fixture"}
	for key, value := range parent {
		t.Setenv(key, value)
	}
	t.Setenv("CBTE_TEST_PROCESS_ENV", "1")
	t.Setenv("CBTE_TEST_PROCESS_KEEP", "inherited-value")
	t.Setenv("NOTIFY_SOCKET_PROXY", "unrelated-value")
	for _, explicitEnvironment := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		cmd := exec.CommandContext(ctx, executable, "-test.run=^TestSystemdEnvironmentChildHelper$")
		expected := "inherited-value"
		if explicitEnvironment {
			cmd.Env = append(os.Environ(), "CBTE_TEST_PROCESS_KEEP=explicit-value")
			expected = "explicit-value"
		}
		configureProcess(cmd)
		output, e := cmd.Output()
		cancel()
		if e != nil {
			t.Fatal(e)
		}
		var child Object
		if e = json.Unmarshal(output, &child); e != nil {
			t.Fatal(e)
		}
		for key, value := range parent {
			if child[key] != "" {
				t.Fatalf("child inherited systemd notification setting %s", key)
			}
			if os.Getenv(key) != value {
				t.Fatalf("parent notification setting was changed: %s", key)
			}
		}
		if child["CBTE_TEST_PROCESS_KEEP"] != expected || child["NOTIFY_SOCKET_PROXY"] != "unrelated-value" {
			t.Fatal("ordinary child configuration was lost")
		}
	}
}

func TestSystemdEnvironmentFilterHandlesExplicitCaseVariants(t *testing.T) {
	cmd := exec.Command("fixture-not-executed")
	cmd.Env = []string{"notify_socket=fixture", "Watchdog_Pid=7", "WATCHDOG_USEC=8", "watchdog_device=fixture", "PATH=retained", "CBTE_WORKER=kept"}
	isolateSystemdNotificationEnvironment(cmd)
	values := map[string]string{}
	for _, entry := range cmd.Env {
		name, value, _ := strings.Cut(entry, "=")
		values[strings.ToUpper(name)] = value
	}
	for _, key := range []string{"NOTIFY_SOCKET", "WATCHDOG_PID", "WATCHDOG_USEC", "WATCHDOG_DEVICE"} {
		if _, exists := values[key]; exists {
			t.Fatalf("notification environment was not isolated: %s", key)
		}
	}
	if values["PATH"] != "retained" || values["CBTE_WORKER"] != "kept" {
		t.Fatal("explicit child environment values were lost")
	}
}
