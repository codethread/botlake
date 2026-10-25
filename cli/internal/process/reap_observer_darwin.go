//go:build darwin

package process

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/unix"
)

func registerProcessExitDarwin(kqueue int, change unix.Kevent_t) error {
	_, err := unix.Kevent(kqueue, []unix.Kevent_t{change}, nil, nil)
	return err
}

// Darwin's idtype_t enum is not exported by x/sys/unix.
const darwinPID = 1 // P_PID; P_ALL=0, P_PGID=2

// observeProcessExit reports exit without consuming the child's wait status.
// kqueue NOTE_EXIT observes the child while leaving it waitable, pinning its
// PID and PGID until cancellation has finished tearing down descendants.
func observeProcessExit(pid int) error {
	return observeProcessExitWith(pid, registerProcessExitDarwin, processExitWaitableDarwin)
}

func observeProcessExitWith(
	pid int,
	registerProcessExit func(int, unix.Kevent_t) error,
	processExitWaitable func(int) (bool, error),
) error {
	kqueue, err := unix.Kqueue()
	if err != nil {
		return fmt.Errorf("create process exit kqueue: %w", err)
	}
	defer func() { _ = unix.Close(kqueue) }()
	change := unix.Kevent_t{Ident: uint64(pid), Filter: unix.EVFILT_PROC, Flags: unix.EV_ADD | unix.EV_ONESHOT, Fflags: unix.NOTE_EXIT}
	if err := registerProcessExit(kqueue, change); err != nil {
		// A child can become a waitable zombie between Start and this EV_ADD.
		// Confirm that exact race without consuming its status; ESRCH by itself
		// is not enough to turn an observer failure into success.
		if errors.Is(err, unix.ESRCH) {
			waitable, waitErr := processExitWaitable(pid)
			if waitErr == nil && waitable {
				return nil
			}
			if waitErr != nil {
				return fmt.Errorf("watch process %d exit: %w", pid, errors.Join(err, waitErr))
			}
		}
		return fmt.Errorf("watch process %d exit: %w", pid, err)
	}
	events := make([]unix.Kevent_t, 1)
	for {
		n, err := unix.Kevent(kqueue, nil, events, nil)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return fmt.Errorf("observe process %d exit: %w", pid, err)
		}
		if n == 1 {
			return nil
		}
	}
}

// processExitWaitableDarwin checks for a waitable child without consuming its
// status. The single Cmd.Wait owner still performs the eventual reap.
func processExitWaitableDarwin(pid int) (bool, error) {
	var info darwinSiginfo
	_, _, err := unix.Syscall6(
		unix.SYS_WAITID, //nolint:staticcheck // x/sys exposes no Darwin waitid wrapper; this direct syscall is required for WNOWAIT.
		uintptr(darwinPID),
		uintptr(pid),
		uintptr(unsafe.Pointer(&info)),
		uintptr(unix.WEXITED|unix.WNOWAIT),
		0,
		0,
	)
	if err != 0 {
		return false, fmt.Errorf("check process %d waitability: %w", pid, err)
	}
	return info.pid == int32(pid), nil
}

// darwinSiginfo matches the stable prefix and size of Darwin's LP64
// siginfo_t. Only si_pid is needed; the padding keeps waitid's copyout within
// the supplied buffer on both amd64 and arm64.
type darwinSiginfo struct {
	signo  int32
	errno  int32
	code   int32
	pid    int32
	uid    uint32
	status int32
	addr   uintptr
	value  uintptr
	band   int64
	pad    [7]uint64
}

func processGroupHasLiveMembers(pgid, leaderPID int) (bool, error) {
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return false, fmt.Errorf("read process table: %w", err)
	}
	for _, process := range processes {
		// The leader is intentionally left as the sole allowed zombie: it pins
		// the PGID until this cleanup has finished. Descendant zombies still
		// occupy their PIDs and are counted so callers do not report cleanup
		// complete while an orphaned descendant remains observable.
		if int(process.Eproc.Pgid) == pgid && (int(process.Proc.P_pid) != leaderPID || process.Proc.P_stat != 5) {
			return true, nil
		}
	}
	return false, nil
}
