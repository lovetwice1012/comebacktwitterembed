//go:build linux

package main

import (
	"errors"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func platformDiskSnapshot(dir string) Object {
	var st syscall.Statfs_t
	if e := syscall.Statfs(dir, &st); e != nil {
		return Object{"available": false, "error": e.Error()}
	}
	return Object{"available": true, "freeBytes": st.Bavail * uint64(st.Bsize), "totalBytes": st.Blocks * uint64(st.Bsize), "freeInodes": st.Ffree, "totalInodes": st.Files}
}

func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		e := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(e, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return e
	}
	cmd.WaitDelay = 2 * time.Second
}
func peerAllowed(conn *net.UnixConn, uid int) bool {
	raw, e := conn.SyscallConn()
	if e != nil {
		return false
	}
	allowed := false
	e = raw.Control(func(fd uintptr) {
		cred, x := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		allowed = x == nil && (int(cred.Uid) == uid || cred.Uid == 0)
	})
	return e == nil && allowed
}
