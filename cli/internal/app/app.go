package app

import (
	"bufio"
	"bytes"
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
	OK     bool `json:"ok"`
	Result any  `json:"result,omitempty"`
	Error  any  `json:"error,omitempty"`
}

type Member struct {
	Path string            `json:"path"`
	Name string            `json:"name"`
	Env  map[string]string `json:"-"`
}

type lakeOptions struct {
	Env map[string]string `json:"env"`
}

type Daemon struct {
	mu                     sync.Mutex
	lifecycle              sync.Mutex
	members                map[string]Member
	custodies              map[string]*process.Custody
	host                   *exec.Cmd
	hostDone               chan struct{}
	hostReady              bool
	hostError              string
	stopping               bool
	listener               net.Listener
	home, core, hostSocket string
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
		return fmt.Errorf("host: %v", frame.Error)
	}

	return nil
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

		if err := d.control("status", "", nil); err == nil {
			d.mu.Lock()

			select {
			case <-done:
				d.mu.Unlock()
				return errors.New("Bun host exited during startup; inspect host.log")
			default:
			}

			d.hostReady = true
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

func (d *Daemon) up(target string, env map[string]string) (Member, error) {
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

	member, err := readMember(path)
	if err != nil {
		return Member{}, err
	}
	member.Env = env

	d.mu.Lock()

	if err := d.checkName(member); err != nil {
		d.mu.Unlock()

		return Member{}, err
	}

	if _, ok := d.custodies[path]; !ok {
		custody, err := process.NewCustody(filepath.Join(d.home, "processes", fmt.Sprintf("%x", sha256.Sum256([]byte(path)))))
		if err != nil {
			d.mu.Unlock()

			return Member{}, err
		}

		d.custodies[path] = custody
	}

	d.mu.Unlock()

	if err := d.control("start", path, member.Env); err != nil {
		return Member{}, err
	}

	d.mu.Lock()

	d.members[path] = member
	d.mu.Unlock()

	return member, nil
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
	if req.Protocol != 1 || req.ID == "" {
		encode(conn, errFrame(errors.New("protocol_version=1 and request_id are required")))

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
		response, err := d.hostCall("/invoke", payload)
		if err != nil {
			encode(conn, errFrame(fmt.Errorf("request delivery uncertain; not replayed: %w", err)))

			return
		}
		defer response.Close()
		go func() { _, _ = io.Copy(io.Discard, conn); _ = response.Close() }()
		_, _ = io.Copy(conn, response)
	case "lake-start":
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
		member, err := d.up(target, options.Env)
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			encode(conn, Frame{OK: true, Result: member})
		}
	case "lake-restart", "lake-stop":
		var options lakeOptions
		if err := decode(req.Payload, &options); err != nil {
			encode(conn, errFrame(err))
			return
		}

		d.lifecycle.Lock()
		member, err := d.resolve(req.Workspace, req.CWD)
		if err == nil && req.Operation == "lake-restart" {
			member, err = readMember(member.Path)
			member.Env = options.Env
			if err == nil {
				d.mu.Lock()

				err = d.checkName(member)
				d.mu.Unlock()
			}
		}

		if err == nil {
			action := "restart"
			if req.Operation == "lake-stop" {
				action = "stop"
			}

			err = d.control(action, member.Path, member.Env)
			if req.Operation == "lake-restart" {
				d.mu.Lock()

				if err == nil {
					d.members[member.Path] = member
				} else {
					delete(d.members, member.Path)
				}

				d.mu.Unlock()
			}

			if req.Operation == "lake-stop" {
				d.mu.Lock()
				delete(d.members, member.Path)
				d.mu.Unlock()
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
		previous := d.host
		done := d.hostDone
		d.mu.Unlock()
		err := previous.Process.Kill()
		if err == nil || errors.Is(err, os.ErrProcessDone) {
			<-done

			err = d.restoreHost()
		}
		d.lifecycle.Unlock()
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			encode(conn, Frame{OK: true, Result: map[string]bool{"ready": true}})
		}
	case "lake-status":
		d.lifecycle.Lock()
		member, err := d.resolve(req.Workspace, req.CWD)
		if err == nil {
			err = d.control("member-status", member.Path, nil)
		}
		d.lifecycle.Unlock()
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			encode(conn, Frame{OK: true, Result: map[string]any{"path": member.Path, "name": member.Name, "ready": true}})
		}
	case "status", "lake-list":
		d.mu.Lock()
		members := make([]Member, 0, len(d.members))
		for _, member := range d.members {
			members = append(members, member)
		}
		sort.Slice(members, func(i, j int) bool { return members[i].Path < members[j].Path })
		pid := d.host.Process.Pid
		ready, hostError := d.hostReady, d.hostError
		d.mu.Unlock()
		if req.Operation == "lake-list" {
			encode(conn, Frame{OK: true, Result: members})
		} else {
			encode(conn, Frame{OK: true, Result: map[string]any{"pid": os.Getpid(), "hostPid": pid, "hostReady": ready, "hostError": hostError, "members": members}})
		}
	case "host-status":
		response, err := d.hostCall("/control", map[string]any{"action": "status"})
		if err != nil {
			encode(conn, errFrame(err))

			return
		}
		defer response.Close()
		_, _ = io.Copy(conn, response)
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

	if host != nil {
		_ = host.Process.Signal(syscall.SIGTERM)

		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = host.Process.Kill()
		}
	}

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
	d := &Daemon{home: home, core: Core(), hostSocket: filepath.Join(home, "host.sock"), members: map[string]Member{}, custodies: map[string]*process.Custody{}, listener: listener}
	if err := d.bootHost(); err != nil {
		return err
	}

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
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
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

	return Request{Protocol: 1, ID: rand.Text(), Operation: operation, Workspace: target, CWD: cwd, Payload: data}
}
