package app

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"botlake/internal/process"
)

type Request struct {
	Protocol  int             `json:"protocol_version"`
	ID        string          `json:"request_id"`
	Operation string          `json:"operation"`
	Workspace string          `json:"workspace,omitempty"`
	CWD       string          `json:"cwd,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type Frame struct {
	OK          bool   `json:"ok"`
	Result      any    `json:"result,omitempty"`
	Error       any    `json:"error,omitempty"`
	Diagnostics string `json:"diagnostics,omitempty"`
}

type Member struct {
	Path string            `json:"path"`
	Name string            `json:"name"`
	Env  map[string]string `json:"-"`
}

type lakeOptions struct {
	Env map[string]string `json:"env"`
}

type hostRuntimeStatus struct {
	CoreVersion string `json:"coreVersion"`
}

const (
	lakeInstallStart   = "lake-install-start"
	lakeInstallTimeout = 2 * time.Minute
)

type Daemon struct {
	mu                                  sync.Mutex
	lifecycle                           sync.Mutex
	members                             map[string]Member
	lakes                               map[string]*lakeProcess
	custodies                           map[string]*process.Custody
	host                                *exec.Cmd
	hostDone                            chan struct{}
	hostReady                           bool
	hostError                           string
	stopping                            bool
	listener                            net.Listener
	home, core, hostSocket, coreVersion string
}

func Home() string {
	if home := os.Getenv("BL_HOME"); home != "" {
		return home
	}

	home, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}

	return filepath.Join(home, ".botlake")
}

func Core() string {
	if path := os.Getenv("BL_CORE"); path != "" {
		return path
	}

	_, file, _, _ := runtime.Caller(0)

	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../packages/core"))
}

func socket() string { return filepath.Join(Home(), "botlake.sock") }

func canonical(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}

	return filepath.EvalSymlinks(absolute)
}

func errFrame(err error) Frame {
	return Frame{Error: map[string]any{"type": "error", "code": "botlake", "message": err.Error()}}
}

func encode(w io.Writer, frame any) { _ = json.NewEncoder(w).Encode(frame) }

func decode(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(target); err != nil {
		return err
	}

	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("expected one JSON value")
	}

	return nil
}

func (d *Daemon) hostCall(path string, body any) (net.Conn, error) {
	conn, err := net.DialTimeout("unix", d.hostSocket, time.Second)
	if err != nil {
		return nil, err
	}

	if err := json.NewEncoder(conn).Encode(map[string]any{"type": path, "body": body}); err != nil {
		conn.Close()

		return nil, err
	}

	return conn, nil
}

func (d *Daemon) control(action, workspace string, env map[string]string) error {
	body := map[string]any{"action": action, "workspace": workspace}
	if env != nil {
		body["env"] = env
	}
	conn, err := d.hostCall("/control", body)
	if err != nil {
		return err
	}

	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(25 * time.Second))
	var frame Frame
	if err := json.NewDecoder(conn).Decode(&frame); err != nil {
		return err
	}

	if !frame.OK {
		return hostFrameError(frame.Error)
	}

	return nil
}

func hostFrameError(value any) error {
	if frame, ok := value.(map[string]any); ok {
		if message, ok := frame["message"].(string); ok {
			return fmt.Errorf("host: %s", message)
		}
	}

	return fmt.Errorf("host: %v", value)
}

func (d *Daemon) readHostStatus() (hostRuntimeStatus, error) {
	conn, err := d.hostCall("/control", map[string]any{"action": "status"})
	if err != nil {
		return hostRuntimeStatus{}, err
	}

	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var frame struct {
		OK     bool              `json:"ok"`
		Result hostRuntimeStatus `json:"result"`
		Error  any               `json:"error"`
	}
	if err := json.NewDecoder(conn).Decode(&frame); err != nil {
		return hostRuntimeStatus{}, err
	}
	if !frame.OK {
		return hostRuntimeStatus{}, hostFrameError(frame.Error)
	}
	if frame.Result.CoreVersion == "" {
		return hostRuntimeStatus{}, errors.New("Bun host did not report its loaded @botlake/core version")
	}

	return frame.Result, nil
}

func (d *Daemon) bootHost() error {
	_ = os.Remove(d.hostSocket)
	cmd := exec.Command("bun", filepath.Join(d.core, "src/runtime/host.ts"), d.hostSocket, socket())
	log, err := os.OpenFile(filepath.Join(d.home, "host.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}

	defer log.Close()
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.Dir = d.core
	if err := cmd.Start(); err != nil {
		return err
	}

	d.mu.Lock()

	d.host = cmd
	d.hostReady = false
	d.hostError = ""
	d.hostDone = make(chan struct{})
	done := d.hostDone
	d.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		close(done)
		d.mu.Lock()

		recover := !d.stopping && d.host == cmd && d.hostReady
		if d.host == cmd {
			d.hostReady = false
			d.coreVersion = ""
		}

		d.mu.Unlock()

		if recover {
			go d.recoverHost(cmd)
		}
	}()
	deadline := time.Now().Add(15 * time.Second)

	for time.Now().Before(deadline) {
		select {
		case <-done:
			return errors.New("Bun host exited during startup; inspect host.log")
		default:
		}

		if status, err := d.readHostStatus(); err == nil {
			d.mu.Lock()

			select {
			case <-done:
				d.mu.Unlock()
				return errors.New("Bun host exited during startup; inspect host.log")
			default:
			}

			d.hostReady = true
			d.coreVersion = status.CoreVersion
			d.mu.Unlock()

			return nil
		}

		time.Sleep(20 * time.Millisecond)
	}

	_ = cmd.Process.Kill()

	return errors.New("Bun host readiness timed out")
}

func (d *Daemon) recoverHost(previous *exec.Cmd) {
	d.lifecycle.Lock()
	defer d.lifecycle.Unlock()
	d.mu.Lock()

	if d.stopping || d.host != previous {
		d.mu.Unlock()

		return
	}

	d.mu.Unlock()

	if err := d.restoreHost(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}

// Re-read every member before publishing any replacement routes. Config changes
// may rename workspaces, including introducing collisions across the pool.
func (d *Daemon) restoreHost() error {
	d.mu.Lock()

	paths := make([]string, 0, len(d.members))
	previous := d.members

	for path := range d.members {
		paths = append(paths, path)
	}

	d.members = map[string]Member{}
	d.mu.Unlock()
	sort.Strings(paths)

	err := d.bootHost()
	if err == nil {
		candidates := make([]Member, 0, len(paths))
		names := map[string]int{}

		for _, path := range paths {
			member, readErr := readMember(path)
			if errors.Is(readErr, os.ErrNotExist) {
				fmt.Fprintf(os.Stderr, "warning: skipping lake %s during host recovery: %v\n", path, readErr)
				continue
			}
			if readErr != nil {
				err = errors.Join(err, fmt.Errorf("recover %s: %w", path, readErr))
				continue
			}

			member.Env = previous[path].Env
			candidates = append(candidates, member)
			names[member.Name]++
		}

		for _, member := range candidates {
			if names[member.Name] > 1 {
				err = errors.Join(err, fmt.Errorf("duplicate workspace name: %s", member.Name))
				continue
			}

			if startErr := d.control("start", member.Path, member.Env); startErr != nil {
				err = errors.Join(err, fmt.Errorf("recover %s: %w", member.Path, startErr))
				continue
			}

			d.mu.Lock()

			d.members[member.Path] = member
			d.mu.Unlock()
		}
	}

	d.mu.Lock()

	if err != nil {
		d.hostError = err.Error()
	}

	d.mu.Unlock()

	return err
}

func (d *Daemon) checkName(member Member) error {
	for path, existing := range d.members {
		if path != member.Path && member.Name == existing.Name {
			return fmt.Errorf("duplicate workspace name: %s", member.Name)
		}
	}

	return nil
}

func (d *Daemon) resolve(target, cwd string) (Member, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	isPath := filepath.IsAbs(target) || target == "." || target == ".." || strings.Contains(target, "/")
	if !isPath {
		for _, member := range d.members {
			if member.Name == target && target != "" {
				return member, nil
			}
		}
	}

	path := target
	if !filepath.IsAbs(path) && cwd != "" {
		path = filepath.Join(cwd, path)
	}

	canonicalPath, err := canonical(path)
	if err == nil {
		if member, ok := d.members[canonicalPath]; ok {
			return member, nil
		}
	}

	return Member{}, fmt.Errorf("unknown workspace: %s", target)
}

func (d *Daemon) up(target string, env map[string]string, install func(Member) error) (Member, error) {
	d.lifecycle.Lock()
	defer d.lifecycle.Unlock()
	path, err := canonical(target)
	if err != nil {
		return Member{}, err
	}

	d.mu.Lock()

	if member, ok := d.members[path]; ok {
		d.mu.Unlock()

		return member, nil
	}

	d.mu.Unlock()

	member := Member{Path: path, Name: filepath.Base(path), Env: env}

	if install != nil {
		if err := install(member); err != nil {
			return Member{}, err
		}
	}

	d.mu.Lock()
	if _, ok := d.custodies[path]; !ok {
		custody, err := process.NewCustody(filepath.Join(d.home, "processes", fmt.Sprintf("%x", sha256.Sum256([]byte(path)))))
		if err != nil {
			d.mu.Unlock()

			return Member{}, err
		}

		d.custodies[path] = custody
	}

	d.mu.Unlock()

	lake, err := d.startLake(path, member.Env)
	if err != nil {
		return Member{}, err
	}
	member = lake.member

	d.mu.Lock()
	d.members[path] = member
	d.lakes[path] = lake
	d.mu.Unlock()

	return member, nil
}

func installLake(ctx context.Context, member Member) (string, error) {
	cmd := exec.CommandContext(ctx, "bun", "install", "--no-progress")
	cmd.Dir = filepath.Join(member.Path, ".botlake")
	cmd.Env = make([]string, 0, len(member.Env))
	for key, value := range member.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = 2 * time.Second
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("bun install in %s failed: %w\n%s", cmd.Dir, errors.Join(err, ctx.Err()), bytes.TrimSpace(output))
	}
	return string(output), nil
}

func (d *Daemon) process(req Request) (any, error) {
	path, err := canonical(req.Workspace)
	if err != nil {
		return nil, err
	}

	d.mu.Lock()

	custody := d.custodies[path]
	d.mu.Unlock()

	if custody == nil {
		return nil, errors.New("workspace has no process custody")
	}

	switch req.Operation {
	case "process.launch":
		var p struct {
			Owner string         `json:"owner"`
			Key   string         `json:"key"`
			Spec  map[string]any `json:"launch_spec"`
		}
		if err := decode(req.Payload, &p); err != nil {
			return nil, err
		}
		spec, err := process.ParseLaunchSpec(p.Spec)
		if err != nil {
			return nil, err
		}
		return custody.Launch(p.Owner, p.Key, spec)
	case "process.get":
		var p struct {
			Handle string `json:"handle"`
		}
		if err := decode(req.Payload, &p); err != nil {
			return nil, err
		}
		return custody.Get(p.Handle)
	case "process.list-owned":
		var p struct {
			Owner string `json:"owner"`
		}
		if err := decode(req.Payload, &p); err != nil {
			return nil, err
		}
		return custody.ListOwned(p.Owner)
	case "process.cancel", "process.acknowledge":
		var p struct {
			Owner  string `json:"owner"`
			Handle string `json:"handle"`
		}
		if err := decode(req.Payload, &p); err != nil {
			return nil, err
		}
		if req.Operation == "process.cancel" {
			return custody.Cancel(p.Owner, p.Handle)
		}
		if err := custody.Acknowledge(p.Owner, p.Handle); err != nil {
			return nil, err
		}
		return map[string]bool{"acknowledged": true}, nil
	default:
		return nil, errors.New("unknown process operation")
	}
}

func (d *Daemon) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)

	if !scanner.Scan() {
		return
	}

	var req Request
	if err := decode(scanner.Bytes(), &req); err != nil {
		encode(conn, errFrame(err))

		return
	}

	_ = conn.SetReadDeadline(time.Time{})
	if req.Protocol != protocolVersion || req.ID == "" {
		encode(conn, errFrame(fmt.Errorf("protocol_version=%d and request_id are required", protocolVersion)))

		return
	}

	if strings.HasPrefix(req.Operation, "process.") {
		result, err := d.process(req)
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			encode(conn, Frame{OK: true, Result: result})
		}

		return
	}

	switch req.Operation {
	case "lake-resolve":
		member, err := d.resolve(req.Workspace, req.CWD)
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			encode(conn, Frame{OK: true, Result: member})
		}
	case "invoke":
		var payload map[string]any
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			encode(conn, errFrame(err))

			return
		}
		if payload == nil {
			encode(conn, errFrame(errors.New("invoke payload must be an object")))

			return
		}
		target := req.Workspace
		if peer, ok := payload["workspace"].(string); ok {
			target = peer
		}
		member, err := d.resolve(target, req.CWD)
		if err != nil {
			encode(conn, errFrame(err))

			return
		}
		payload["workspace"] = member.Path
		payload["request_id"] = req.ID
		d.mu.Lock()
		lake := d.lakes[member.Path]
		d.mu.Unlock()
		if lake == nil {
			encode(conn, errFrame(errors.New("workspace is not running")))
			return
		}
		response, err := d.invokeLake(lake, payload)
		if err != nil {
			var lifecycle *lakeLifecycleError
			if errors.As(err, &lifecycle) {
				encode(conn, Frame{Error: map[string]any{
					"type": "error", "code": lifecycle.Code, "message": lifecycle.Message,
					"details": map[string]any{"workspace": lifecycle.Workspace, "delivery": lifecycle.Delivery},
				}})
			} else {
				encode(conn, errFrame(fmt.Errorf("response ended; request delivery uncertain and was not replayed: %w", err)))
			}
			return
		}
		defer response.Close()
		go func() { _, _ = io.Copy(io.Discard, conn); _ = response.Close() }()
		_, _ = io.Copy(conn, response)
	case "lake-start", lakeInstallStart:
		var options lakeOptions
		if err := decode(req.Payload, &options); err != nil {
			encode(conn, errFrame(err))
			return
		}

		target := req.Workspace
		if member, err := d.resolve(target, req.CWD); err == nil {
			target = member.Path
		}
		if !filepath.IsAbs(target) && req.CWD != "" {
			target = filepath.Join(req.CWD, target)
		}
		var install func(Member) error
		var diagnostics string
		if req.Operation == lakeInstallStart {
			ctx, cancel := context.WithTimeout(context.Background(), lakeInstallTimeout)
			defer cancel()
			go func() {
				_, _ = io.Copy(io.Discard, conn)
				cancel()
			}()
			install = func(member Member) error {
				var err error
				diagnostics, err = installLake(ctx, member)
				return err
			}
		}
		member, err := d.up(target, options.Env, install)
		frame := Frame{OK: true, Result: member}
		if err != nil {
			frame = errFrame(err)
		}
		frame.Diagnostics = diagnostics
		encode(conn, frame)
	case "lake-restart", "lake-stop":
		var options lakeOptions
		if err := decode(req.Payload, &options); err != nil {
			encode(conn, errFrame(err))
			return
		}

		d.lifecycle.Lock()
		member, err := d.resolve(req.Workspace, req.CWD)
		if err == nil {
			d.mu.Lock()
			lake := d.lakes[member.Path]
			d.mu.Unlock()
			restarting := req.Operation == "lake-restart"
			reason := "stop"
			if restarting {
				reason = "restart"
			}
			err = d.stopLake(lake, reason)
			d.mu.Lock()
			delete(d.members, member.Path)
			delete(d.lakes, member.Path)
			d.mu.Unlock()
			if err == nil && restarting {
				var replacement *lakeProcess
				replacement, err = d.startLake(member.Path, options.Env)
				if err == nil {
					member = replacement.member
					d.mu.Lock()
					d.members[member.Path] = member
					d.lakes[member.Path] = replacement
					d.mu.Unlock()
				}
			}
		}
		d.lifecycle.Unlock()
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			encode(conn, Frame{OK: true, Result: member})
		}
	case "restart-host":
		d.lifecycle.Lock()
		d.mu.Lock()
		lakes := make([]*lakeProcess, 0, len(d.lakes))
		for _, lake := range d.lakes {
			lakes = append(lakes, lake)
		}
		d.mu.Unlock()
		var restartErr error
		for _, lake := range lakes {
			if err := d.stopLake(lake, "restart"); err != nil {
				restartErr = errors.Join(restartErr, err)
			}
			d.mu.Lock()
			delete(d.members, lake.member.Path)
			delete(d.lakes, lake.member.Path)
			d.mu.Unlock()
		}
		if restartErr == nil {
			for _, previous := range lakes {
				lake, err := d.startLake(previous.member.Path, previous.member.Env)
				if err != nil {
					restartErr = errors.Join(restartErr, fmt.Errorf("restart %s: %w", previous.member.Path, err))
					continue
				}
				d.mu.Lock()
				d.members[lake.member.Path] = lake.member
				d.lakes[lake.member.Path] = lake
				d.mu.Unlock()
			}
		}
		d.lifecycle.Unlock()
		if restartErr != nil {
			encode(conn, errFrame(restartErr))
		} else {
			encode(conn, Frame{OK: true, Result: map[string]bool{"ready": true}})
		}
	case "lake-status":
		d.lifecycle.Lock()
		member, err := d.resolve(req.Workspace, req.CWD)
		if err == nil {
			d.mu.Lock()
			_, running := d.lakes[member.Path]
			d.mu.Unlock()
			if !running {
				err = errors.New("workspace is not running")
			}
		}
		d.lifecycle.Unlock()
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			d.mu.Lock()
			lake := d.lakes[member.Path]
			d.mu.Unlock()
			encode(conn, Frame{OK: true, Result: map[string]any{"path": member.Path, "name": member.Name, "ready": true, "coreVersion": lake.info["coreVersion"], "pid": lake.cmd.Process.Pid}})
		}
	case "lake-info":
		d.lifecycle.Lock()
		member, err := d.resolve(req.Workspace, req.CWD)
		if err != nil {
			d.lifecycle.Unlock()
			encode(conn, errFrame(err))
			return
		}
		d.mu.Lock()
		lake := d.lakes[member.Path]
		d.mu.Unlock()
		d.lifecycle.Unlock()
		if lake == nil {
			encode(conn, errFrame(errors.New("workspace is not running")))
			return
		}
		encode(conn, Frame{OK: true, Result: lake.info})
	case "status", "lake-list":
		d.mu.Lock()
		members := make([]Member, 0, len(d.members))
		for _, member := range d.members {
			members = append(members, member)
		}
		sort.Slice(members, func(i, j int) bool { return members[i].Path < members[j].Path })
		lakePids := map[string]int{}
		var coreVersion string
		for path, lake := range d.lakes {
			lakePids[path] = lake.cmd.Process.Pid
			if coreVersion == "" {
				coreVersion, _ = lake.info["coreVersion"].(string)
			}
		}
		d.mu.Unlock()
		if req.Operation == "lake-list" {
			encode(conn, Frame{OK: true, Result: members})
		} else {
			encode(conn, Frame{OK: true, Result: map[string]any{
				"pid": os.Getpid(), "supervisorVersion": Version, "supervisorBuildId": buildID(), "protocolVersion": protocolVersion,
				"hostPid": 0, "hostReady": true, "hostError": "", "coreVersion": coreVersion, "lakePids": lakePids, "members": members,
			}})
		}
	case "host-status":
		d.mu.Lock()
		var coreVersion string
		for _, lake := range d.lakes {
			coreVersion, _ = lake.info["coreVersion"].(string)
			break
		}
		d.mu.Unlock()
		encode(conn, Frame{OK: true, Result: map[string]any{"coreVersion": coreVersion, "members": len(d.lakes)}})
	case "stop":
		encode(conn, Frame{OK: true, Result: map[string]bool{"stopping": true}})
		go d.shutdown()
	default:
		encode(conn, errFrame(fmt.Errorf("unknown Botlake operation: %s", req.Operation)))
	}
}

func (d *Daemon) shutdown() {
	d.lifecycle.Lock()
	defer d.lifecycle.Unlock()
	d.mu.Lock()

	if d.stopping {
		d.mu.Unlock()

		return
	}

	d.stopping = true
	host := d.host
	done := d.hostDone
	custodies := make([]*process.Custody, 0, len(d.custodies))

	for _, custody := range d.custodies {
		custodies = append(custodies, custody)
	}

	d.mu.Unlock()

	_ = host
	_ = done
	var lakeStops sync.WaitGroup
	for _, lake := range d.lakes {
		lakeStops.Add(1)
		go func(lake *lakeProcess) {
			defer lakeStops.Done()
			if err := d.stopLake(lake, "stop"); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
		}(lake)
	}
	lakeStops.Wait()

	for _, custody := range custodies {
		if err := custody.Shutdown(); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}

	_ = d.listener.Close()
	_ = os.Remove(d.hostSocket)
}

func Serve() error {
	home := Home()
	if err := os.MkdirAll(home, 0700); err != nil {
		return err
	}

	lock, err := os.OpenFile(filepath.Join(home, "botlake.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}

	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("Botlake is already running")
	}

	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	_ = os.Remove(socket())
	listener, err := net.Listen("unix", socket())
	if err != nil {
		return err
	}

	defer listener.Close()
	if err := os.Chmod(socket(), 0600); err != nil {
		return err
	}

	defer os.Remove(socket())
	d := &Daemon{home: home, core: Core(), hostSocket: filepath.Join(home, "host.sock"), members: map[string]Member{}, lakes: map[string]*lakeProcess{}, custodies: map[string]*process.Custody{}, listener: listener}

	encode(os.Stdout, map[string]bool{"ready": true})

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, os.Interrupt)
	defer signal.Stop(signals)

	go func() { <-signals; d.shutdown() }()

	for {
		conn, err := listener.Accept()
		if err != nil {
			d.mu.Lock()

			stopping := d.stopping
			d.mu.Unlock()

			if stopping {
				return nil
			}

			return err
		}

		go d.handle(conn)
	}
}

func Dial(req Request, output io.Writer) error {
	conn, err := net.DialTimeout("unix", socket(), time.Second)
	if err != nil {
		return fmt.Errorf("Botlake is unreachable; run botlake start: %w", err)
	}

	defer conn.Close()
	timeout := 30 * time.Second
	if req.Operation == lakeInstallStart {
		timeout += lakeInstallTimeout
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return err
	}

	_, err = io.Copy(output, conn)

	return err
}

func request(operation, target string, payload any) Request {
	data, _ := json.Marshal(payload)
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}

	return Request{Protocol: protocolVersion, ID: rand.Text(), Operation: operation, Workspace: target, CWD: cwd, Payload: data}
}
