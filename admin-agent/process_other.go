//go:build !linux

package main

import (
	"net"
	"os/exec"
	"time"
)

func platformDiskSnapshot(dir string) Object {
	return Object{"available": false, "reason": "Linux statfs collector required"}
}
func configureProcess(cmd *exec.Cmd) {
	isolateSystemdNotificationEnvironment(cmd)
	cmd.WaitDelay = 2 * time.Second
}
func peerAllowed(conn *net.UnixConn, uid int) bool { return false }
