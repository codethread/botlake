package process

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// LaunchSpec is the parsed, shell-free description of one native process.
type LaunchSpec struct {
	Argv  []string
	CWD   string
	Env   map[string]string
	Stdin *string
}

// OutputRefs identify Mill-retained process output files.
type OutputRefs struct {
	StdoutRef string `json:"stdout_ref"`
	StderrRef string `json:"stderr_ref"`
}

// ExitResult records ordinary process completion.
type ExitResult struct {
	Code   int     `json:"code"`
	Signal *string `json:"signal"`
}

// Stop values classify how a cancelled process tree actually stopped. They are
// generic process facts: a consumer must not read StopForced or StopUncertain
// as work that finished on its own terms.
const (
	// StopGraceful means the whole tree was gone within the grace period after
	// the terminate signal, with no escalation.
	StopGraceful = "graceful"
	// StopForced means Mill had to escalate to a kill signal, and the tree was
	// confirmed gone afterwards.
	StopForced = "forced"
	// StopUncertain means Mill could establish neither fact: there was no live
	// leader to signal, signalling failed, or the group outlived the kill.
	StopUncertain = "uncertain"
)

// CancellationResult records Mill-requested process cancellation. Stop retains
// the escalation evidence that would otherwise be lost once the tree is gone,
// and ObservedExit retains the leader's wait status seen under cancellation.
type CancellationResult struct {
	Reason       string      `json:"reason"`
	Stop         string      `json:"stop"`
	ObservedExit *ExitResult `json:"observed_exit,omitempty"`
}

// LaunchFailure records a process that could not be started.
type LaunchFailure struct {
	Message string `json:"message"`
}

// Record is the data-first custody projection. Handle is the only addressable
// process identity; PID is intentionally absent from this public shape.
type Record struct {
	Handle        string              `json:"handle"`
	Owner         string              `json:"owner"`
	Key           string              `json:"key"`
	Phase         string              `json:"phase"`
	Output        OutputRefs          `json:"output"`
	Exit          *ExitResult         `json:"exit,omitempty"`
	Cancellation  *CancellationResult `json:"cancellation,omitempty"`
	LaunchFailure *LaunchFailure      `json:"launch_failure,omitempty"`
}

type custodyRecord struct {
	Record
	spec        LaunchSpec
	cmd         *exec.Cmd
	stdout      *os.File
	stderr      *os.File
	cancelled   string
	stop        string
	done        chan struct{}
	cleanupErr  error
	treeDone    chan struct{}
	treeErr     error
	reapClaimed bool
}

// Custody owns process trees for one Mill-selected workspace.
type Custody struct {
	mu           sync.Mutex
	root         string
	byHandle     map[string]*custodyRecord
	reservations map[string]string
	closed       bool
	removeAll    func(string) error
	signalGroup  func(int, syscall.Signal) error
}

// NewCustody creates an in-memory Mill-lifetime custody store rooted at root.
func NewCustody(root string) (*Custody, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("custody output root must not be blank")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create custody output root: %w", err)
	}
	return &Custody{root: root, byHandle: map[string]*custodyRecord{}, reservations: map[string]string{}, removeAll: os.RemoveAll, signalGroup: signalProcessGroup}, nil
}

// ParseLaunchSpec parses boundary data exactly once before process launch.
func ParseLaunchSpec(value map[string]any) (LaunchSpec, error) {
	if value == nil {
		return LaunchSpec{}, errors.New("launch_spec must be an object")
	}
	for key := range value {
		if key != "argv" && key != "cwd" && key != "env" && key != "stdin" {
			return LaunchSpec{}, fmt.Errorf("launch_spec contains unknown field %q", key)
		}
	}
	var argvValue []any
	switch values := value["argv"].(type) {
	case []any:
		argvValue = values
	case []string:
		argvValue = make([]any, len(values))
		for i, item := range values {
			argvValue[i] = item
		}
	default:
		argvValue = nil
	}
	if len(argvValue) == 0 {
		return LaunchSpec{}, errors.New("launch_spec argv must be a non-empty array")
	}
	argv := make([]string, len(argvValue))
	for i, item := range argvValue {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return LaunchSpec{}, fmt.Errorf("launch_spec argv[%d] must be a non-blank string", i)
		}
		argv[i] = text
	}
	cwd, ok := value["cwd"].(string)
	if !ok || !filepath.IsAbs(cwd) || strings.TrimSpace(cwd) == "" {
		return LaunchSpec{}, errors.New("launch_spec cwd must be an absolute string")
	}
	env := map[string]string{}
	if raw, present := value["env"]; present {
		entries := map[string]any{}
		switch typed := raw.(type) {
		case map[string]any:
			entries = typed
		case map[string]string:
			for key, value := range typed {
				entries[key] = value
			}
		default:
			return LaunchSpec{}, errors.New("launch_spec env must be an object")
		}
		for key, rawValue := range entries {
			if strings.TrimSpace(key) == "" {
				return LaunchSpec{}, errors.New("launch_spec env keys must not be blank")
			}
			text, ok := rawValue.(string)
			if !ok {
				return LaunchSpec{}, fmt.Errorf("launch_spec env[%q] must be a string", key)
			}
			env[key] = text
		}
	}
	var stdin *string
	if raw, present := value["stdin"]; present && raw != nil {
		text, ok := raw.(string)
		if !ok {
			return LaunchSpec{}, errors.New("launch_spec stdin must be a string or null")
		}
		stdin = &text
	}
	return LaunchSpec{Argv: argv, CWD: cwd, Env: env, Stdin: stdin}, nil
}

func sameSpec(a, b LaunchSpec) bool {
	if a.CWD != b.CWD || len(a.Argv) != len(b.Argv) || len(a.Env) != len(b.Env) {
		return false
	}
	for i := range a.Argv {
		if a.Argv[i] != b.Argv[i] {
			return false
		}
	}
	for key, value := range a.Env {
		if b.Env[key] != value {
			return false
		}
	}
	if a.Stdin == nil || b.Stdin == nil {
		return a.Stdin == nil && b.Stdin == nil
	}
	return *a.Stdin == *b.Stdin
}

func newHandle() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return "process-" + hex.EncodeToString(bytes[:]), nil
}

// Launch reserves owner/key before starting a process. Equal repeats converge
// on the existing record; conflicting specifications fail loudly.
func (c *Custody) Launch(owner, key string, spec LaunchSpec) (Record, error) {
	if strings.TrimSpace(owner) == "" || strings.TrimSpace(key) == "" {
		return Record{}, errors.New("custody owner and key must not be blank")
	}
	if err := validateLaunchSpec(spec); err != nil {
		return Record{}, err
	}
	reservation := owner + "\x00" + key
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return Record{}, errors.New("custody service is closed")
	}
	if handle, exists := c.reservations[reservation]; exists {
		row := c.byHandle[handle]
		if row == nil {
			return Record{}, fmt.Errorf("custody key %q for owner %q was already acknowledged and cannot be relaunched", key, owner)
		}
		if !sameSpec(row.spec, spec) {
			return Record{}, fmt.Errorf("custody key %q for owner %q was already reserved with a different launch spec", key, owner)
		}
		return row.Record, nil
	}
	handle, err := newHandle()
	if err != nil {
		return Record{}, fmt.Errorf("allocate custody handle: %w", err)
	}
	dir := filepath.Join(c.root, handle)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Record{}, fmt.Errorf("create custody output directory: %w", err)
	}
	stdoutPath := filepath.Join(dir, "stdout.log")
	stderrPath := filepath.Join(dir, "stderr.log")
	stdout, err := os.OpenFile(stdoutPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return Record{}, fmt.Errorf("create custody stdout: %w", err)
	}
	stderr, err := os.OpenFile(stderrPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		_ = stdout.Close()
		return Record{}, fmt.Errorf("create custody stderr: %w", err)
	}
	row := &custodyRecord{Record: Record{Handle: handle, Owner: owner, Key: key, Phase: "starting", Output: OutputRefs{StdoutRef: stdoutPath, StderrRef: stderrPath}}, spec: spec, stdout: stdout, stderr: stderr, done: make(chan struct{})}
	c.byHandle[handle] = row
	c.reservations[reservation] = handle
	cmd := exec.Command(spec.Argv[0], spec.Argv[1:]...)
	cmd.Dir = spec.CWD
	cmd.Env = mergedEnv(spec.Env)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if spec.Stdin != nil {
		cmd.Stdin = strings.NewReader(*spec.Stdin)
	}
	row.cmd = cmd
	if err := cmd.Start(); err != nil {
		row.Phase = "terminal"
		row.LaunchFailure = &LaunchFailure{Message: err.Error()}
		_ = stdout.Close()
		_ = stderr.Close()
		return row.Record, nil
	}
	go c.wait(row)
	return row.Record, nil
}

func validateLaunchSpec(spec LaunchSpec) error {
	if len(spec.Argv) == 0 || spec.CWD == "" || !filepath.IsAbs(spec.CWD) {
		return errors.New("launch spec requires a non-empty argv and absolute cwd")
	}
	for i, arg := range spec.Argv {
		if strings.TrimSpace(arg) == "" {
			return fmt.Errorf("launch spec argv[%d] must not be blank", i)
		}
	}
	if info, err := os.Stat(spec.CWD); err != nil || !info.IsDir() {
		if err == nil {
			return errors.New("launch spec cwd must be a directory")
		}
		return fmt.Errorf("launch spec cwd is unavailable: %w", err)
	}
	for key := range spec.Env {
		if strings.TrimSpace(key) == "" {
			return errors.New("launch spec env keys must not be blank")
		}
	}
	return nil
}

func mergedEnv(additions map[string]string) []string {
	values := map[string]string{}
	for _, entry := range os.Environ() {
		parts := strings.SplitN(entry, "=", 2)
		values[parts[0]] = parts[1]
	}
	for key, value := range additions {
		values[key] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	entries := make([]string, 0, len(keys))
	for _, key := range keys {
		entries = append(entries, key+"="+values[key])
	}
	return entries
}

func (c *Custody) wait(row *custodyRecord) {
	c.mu.Lock()
	if row.cancelled == "" {
		row.Phase = "running"
	}
	c.mu.Unlock()
	if observeErr := observeProcessExit(row.cmd.Process.Pid); observeErr != nil {
		// Observation is an internal synchronization aid, not a reason to
		// abandon the child. Reap it after any in-flight tree cleanup and retain
		// the observer failure as cleanup evidence.
		c.mu.Lock()
		treeDone := row.treeDone
		c.mu.Unlock()
		if treeDone != nil {
			<-treeDone
		}
		c.finishWait(row, row.cmd.Wait(), observeErr)
		return
	}

	// The observer deliberately does not reap.  If cancellation won the race,
	// the group cleanup retains the unreaped leader as a stable PGID anchor until
	// all descendants are gone.  Otherwise claim reaping before releasing the
	// mutex so a concurrent Cancel waits for this ordinary terminal fact instead
	// of sending to a possibly recycled group.
	c.mu.Lock()
	if row.cancelled == "" {
		row.reapClaimed = true
		c.mu.Unlock()
	} else {
		treeDone := row.treeDone
		c.mu.Unlock()
		if treeDone != nil {
			<-treeDone
		}
	}
	c.finishWait(row, row.cmd.Wait(), nil)
}

func (c *Custody) finishWait(row *custodyRecord, err, observeErr error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if row.cancelled != "" {
		stop := row.stop
		if stop == "" {
			// Cancellation was requested but no signalled tree cleanup resolved,
			// so Mill never observed how the tree stopped.
			stop = StopUncertain
		}
		row.Phase = "terminal"
		row.Exit = nil
		row.Cancellation = &CancellationResult{Reason: row.cancelled, Stop: stop, ObservedExit: exitResult(row.cmd, err)}
	} else {
		row.Phase = "terminal"
		row.Cancellation = nil
		row.Exit = exitResult(row.cmd, err)
	}
	row.cleanupErr = errors.Join(observeErr, row.stdout.Close(), row.stderr.Close())
	close(row.done)
}

func exitResult(cmd *exec.Cmd, err error) *ExitResult {
	result := &ExitResult{Code: 0}
	if cmd.ProcessState != nil {
		result.Code = cmd.ProcessState.ExitCode()
		if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			signal := status.Signal().String()
			result.Signal = &signal
		}
	} else if err != nil {
		result.Code = -1
	}
	return result
}

// Get returns a record by opaque handle.
func (c *Custody) Get(handle string) (Record, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	row, ok := c.byHandle[handle]
	if !ok {
		return Record{}, fmt.Errorf("unknown custody handle %q", handle)
	}
	return row.Record, nil
}

// ListOwned returns all unacknowledged records for owner.
func (c *Custody) ListOwned(owner string) ([]Record, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows := []Record{}
	for _, row := range c.byHandle {
		if row.Owner == owner {
			rows = append(rows, row.Record)
		}
	}
	return rows, nil
}

// Cancel requests process-tree cancellation and leaves the terminal fact
// enumerable. Repeated cancellation is idempotent.
func (c *Custody) Cancel(owner, handle string) (Record, error) {
	c.mu.Lock()
	row, ok := c.byHandle[handle]
	if !ok {
		c.mu.Unlock()
		return Record{}, fmt.Errorf("unknown custody handle %q", handle)
	}
	if row.Owner != owner {
		c.mu.Unlock()
		return Record{}, errors.New("custody handle belongs to a different owner")
	}
	if row.Phase == "terminal" && row.treeDone == nil {
		record := row.Record
		c.mu.Unlock()
		return record, nil
	}
	if row.reapClaimed {
		done := row.done
		record := row.Record
		c.mu.Unlock()
		if !waitDoneUntil(done, time.Now().Add(5*time.Second)) {
			return record, fmt.Errorf("custody process for handle %q did not finish reaping", handle)
		}
		return c.Get(handle)
	}
	var pid int
	var treeDone chan struct{}
	var shouldTerminate bool
	if row.cancelled == "" {
		row.cancelled = "cancelled by owner"
		if row.cmd != nil && row.cmd.Process != nil {
			pid = row.cmd.Process.Pid
			row.treeDone = make(chan struct{})
			treeDone = row.treeDone
			shouldTerminate = true
		}
	} else {
		treeDone = row.treeDone
	}
	record := row.Record
	c.mu.Unlock()
	if shouldTerminate {
		stop, err := terminateProcessTreeWithSignal(pid, c.signalGroup)
		c.mu.Lock()
		row.treeErr = err
		row.stop = stop
		close(treeDone)
		c.mu.Unlock()
		if err != nil {
			return record, fmt.Errorf("cancel custody process group for handle %q: %w", handle, err)
		}
	} else if treeDone != nil {
		if !waitDoneUntil(treeDone, time.Now().Add(5*time.Second)) {
			return record, fmt.Errorf("cancel custody process group for handle %q did not finish", handle)
		}
		c.mu.Lock()
		err := row.treeErr
		record = row.Record
		c.mu.Unlock()
		if err != nil {
			return record, fmt.Errorf("cancel custody process group for handle %q: %w", handle, err)
		}
	}
	if !waitDoneUntil(row.done, time.Now().Add(5*time.Second)) {
		return record, fmt.Errorf("custody process for handle %q did not publish terminal evidence", handle)
	}
	return c.Get(handle)
}

// Acknowledge removes a terminal record but retains its reservation tombstone.
func (c *Custody) Acknowledge(owner, handle string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	row, ok := c.byHandle[handle]
	if !ok {
		return fmt.Errorf("unknown custody handle %q", handle)
	}
	if row.Owner != owner {
		return errors.New("custody handle belongs to a different owner")
	}
	if row.Phase != "terminal" {
		return errors.New("custody handle is not terminal")
	}
	if err := c.removeAll(filepath.Dir(row.Output.StdoutRef)); err != nil {
		return fmt.Errorf("remove custody output directory: %w", err)
	}
	delete(c.byHandle, handle)
	return nil
}

// Shutdown cancels every live owned process tree and waits for each terminal
// fact and its output descriptors to settle before returning.
func (c *Custody) Shutdown() error {
	c.mu.Lock()
	c.closed = true
	rows := make([]*custodyRecord, 0, len(c.byHandle))
	type treeTarget struct {
		row   *custodyRecord
		pid   int
		done  chan struct{}
		start bool
	}
	treeTargets := make([]treeTarget, 0, len(c.byHandle))
	for _, row := range c.byHandle {
		if row.Phase != "terminal" {
			if row.reapClaimed {
				rows = append(rows, row)
				continue
			}
			if row.cancelled == "" {
				row.cancelled = "Mill shutdown"
			}
			if row.cmd != nil && row.cmd.Process != nil {
				start := row.treeDone == nil
				if start {
					row.treeDone = make(chan struct{})
				}
				treeTargets = append(treeTargets, treeTarget{row: row, pid: row.cmd.Process.Pid, done: row.treeDone, start: start})
			}
			rows = append(rows, row)
		}
	}
	c.mu.Unlock()

	type treeResult struct {
		row *custodyRecord
		err error
	}
	treeResults := make(chan treeResult, len(rows))
	for _, target := range treeTargets {
		go func(target treeTarget) {
			var err error
			if target.start {
				var stop string
				stop, err = terminateProcessTreeWithSignal(target.pid, c.signalGroup)
				c.mu.Lock()
				target.row.treeErr = err
				target.row.stop = stop
				close(target.done)
				c.mu.Unlock()
			} else {
				<-target.done
				c.mu.Lock()
				err = target.row.treeErr
				c.mu.Unlock()
			}
			treeResults <- treeResult{row: target.row, err: err}
		}(target)
	}

	var failures []error
	for range treeTargets {
		result := <-treeResults
		if result.err != nil {
			failures = append(failures,
				fmt.Errorf("custody handle %q process-tree cleanup failed: %w", result.row.Handle, result.err))
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for _, row := range rows {
		if !waitDoneUntil(row.done, deadline) {
			failures = append(failures,
				fmt.Errorf("custody handle %q did not terminalize before shutdown deadline", row.Handle))
			continue
		}
		c.mu.Lock()
		cleanupErr := row.cleanupErr
		phase := row.Phase
		c.mu.Unlock()
		if phase != "terminal" {
			failures = append(failures,
				fmt.Errorf("custody handle %q completed shutdown in phase %q", row.Handle, phase))
		}
		if cleanupErr != nil {
			failures = append(failures,
				fmt.Errorf("custody handle %q output cleanup failed: %w", row.Handle, cleanupErr))
		}
	}
	return errors.Join(failures...)
}

const processTreeGracePeriod = 2 * time.Second

func signalProcessGroup(pid int, signal syscall.Signal) error {
	if pid <= 0 {
		return fmt.Errorf("invalid process group pid %d", pid)
	}
	if err := syscall.Kill(-pid, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("signal process group %d with %s: %w", pid, signal, err)
	}
	return nil
}

func waitProcessGroupGone(pid, leaderPID int, timeout time.Duration) (bool, error) {
	deadline := time.Now().Add(timeout)
	for {
		exists, err := processGroupHasLiveMembers(pid, leaderPID)
		if err != nil {
			return false, err
		}
		if !exists {
			return true, nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false, nil
		}
		timer := time.NewTimer(minDuration(remaining, 10*time.Millisecond))
		<-timer.C
		timer.Stop()
	}
}

// terminateProcessTreeWithSignal stops one process tree and reports how it
// stopped. The stop classification is retained cancellation evidence, so it is
// returned alongside any failure rather than being collapsed into it.
func terminateProcessTreeWithSignal(pid int, signalGroup func(int, syscall.Signal) error) (string, error) {
	if err := signalGroup(pid, syscall.SIGTERM); err != nil {
		return StopUncertain, err
	}
	gone, err := waitProcessGroupGone(pid, pid, processTreeGracePeriod)
	if err != nil {
		return StopUncertain, err
	}
	if gone {
		return StopGraceful, nil
	}
	if err := signalGroup(pid, syscall.SIGKILL); err != nil {
		return StopUncertain, err
	}
	gone, err = waitProcessGroupGone(pid, pid, processTreeGracePeriod)
	if err != nil {
		return StopUncertain, err
	}
	if !gone {
		return StopUncertain, fmt.Errorf("process group %d survived SIGKILL", pid)
	}
	return StopForced, nil
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func waitDoneUntil(done <-chan struct{}, deadline time.Time) bool {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		select {
		case <-done:
			return true
		default:
			return false
		}
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}
