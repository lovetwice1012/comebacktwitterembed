package main

import (
	"os/exec"
	"strings"
)

// Only the management service's main process owns its systemd readiness and
// watchdog socket. Child commands must not announce themselves on that socket.
func isolateSystemdNotificationEnvironment(cmd *exec.Cmd) {
	environment := cmd.Environ()
	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(name) {
		case "NOTIFY_SOCKET", "WATCHDOG_PID", "WATCHDOG_USEC", "WATCHDOG_DEVICE":
			continue
		}
		filtered = append(filtered, entry)
	}
	cmd.Env = filtered
}
