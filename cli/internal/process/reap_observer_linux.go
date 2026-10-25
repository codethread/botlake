//go:build linux

package process

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// observeProcessExit reports exit without consuming the child's wait status.
// Keeping the leader waitable pins its PID and PGID while cancellation tears
// down descendants.
func observeProcessExit(pid int) error {
	for {
		var info unix.Siginfo
		err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return fmt.Errorf("waitid pid %d: %w", pid, err)
		}
		return nil
	}
}

func processGroupHasLiveMembers(pgid, leaderPID int) (bool, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false, fmt.Errorf("read process table: %w", err)
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		state, memberPGID, err := linuxProcessGroupState(pid)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return false, err
		}
		// The leader is intentionally left as the sole allowed zombie: it pins
		// the PGID until this cleanup has finished. Descendant zombies still
		// occupy their PIDs and are counted so callers do not report cleanup
		// complete while an orphaned descendant remains observable.
		if memberPGID == pgid && (pid != leaderPID || state != 'Z') {
			return true, nil
		}
	}
	return false, nil
}

func linuxProcessGroupState(pid int) (byte, int, error) {
	value, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, err
	}
	closeParen := strings.LastIndexByte(string(value), ')')
	if closeParen < 0 || closeParen+2 >= len(value) {
		return 0, 0, fmt.Errorf("parse /proc/%d/stat: missing command boundary", pid)
	}
	fields := strings.Fields(string(value[closeParen+2:]))
	// The suffix begins with state (field 3), followed by ppid (4) and pgrp (5).
	if len(fields) < 3 || len(fields[0]) != 1 {
		return 0, 0, fmt.Errorf("parse /proc/%d/stat: short status", pid)
	}
	memberPGID, err := strconv.Atoi(fields[2])
	if err != nil {
		return 0, 0, fmt.Errorf("parse /proc/%d/stat process group: %w", pid, err)
	}
	return fields[0][0], memberPGID, nil
}
