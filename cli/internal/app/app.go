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
	"strings"
	"sync"
	"syscall"
	"time"

	"millstrand/internal/process"
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
	Path string `json:"path"`
	Name string `json:"name"`
}
type Daemon struct {
	mu                     sync.Mutex
	lifecycle              sync.Mutex
	members                map[string]Member
	custodies              map[string]*process.Custody
	host                   *exec.Cmd
	hostDone               chan struct{}
	stopping               bool
	listener               net.Listener
	home, repo, hostSocket string
}

func Home() string {
	if home := os.Getenv("MILL_HOME"); home != "" {
		return home
	}
	home, err := os.UserHomeDir()
	if err != nil {
		panic(err)
	}
	return filepath.Join(home, ".millstrand-ts")
}
func Repo() string {
	if path := os.Getenv("MILLSTRAND_SOURCE"); path != "" {
		return path
	}
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
}
func socket() string { return filepath.Join(Home(), "mill.sock") }
func canonical(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}
func errFrame(err error) Frame {
	return Frame{Error: map[string]any{"type": "error", "code": "mill", "message": err.Error()}}
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
func (d *Daemon) control(action, workspace string) error {
	conn, err := d.hostCall("/control", map[string]any{"action": action, "workspace": workspace})
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
	cmd := exec.Command("bun", filepath.Join(d.repo, "src/runtime/host.ts"), d.hostSocket, socket())
	log, err := os.OpenFile(filepath.Join(d.home, "host.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.Dir = d.repo
	if err := cmd.Start(); err != nil {
		return err
	}
	d.mu.Lock()
	d.host = cmd
	d.hostDone = make(chan struct{})
	done := d.hostDone
	d.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		close(done)
		d.mu.Lock()
		stopping := d.stopping
		d.mu.Unlock()
		if !stopping {
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
		if err := d.control("status", ""); err == nil {
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
	members := make([]Member, 0, len(d.members))
	for _, member := range d.members {
		members = append(members, member)
	}
	d.mu.Unlock()
	if err := d.bootHost(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return
	}
	for _, member := range members {
		if err := d.control("start", member.Path); err != nil {
			fmt.Fprintf(os.Stderr, "recover %s: %v\n", member.Path, err)
			d.mu.Lock()
			delete(d.members, member.Path)
			d.mu.Unlock()
		}
	}
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
func (d *Daemon) up(target string) (Member, error) {
	d.lifecycle.Lock()
	defer d.lifecycle.Unlock()
	path, err := canonical(target)
	if err != nil {
		return Member{}, err
	}
	raw, err := os.ReadFile(filepath.Join(path, ".millstrand/config.json"))
	if err != nil {
		return Member{}, err
	}
	var config struct {
		Name      string          `json:"name"`
		Spools    []string        `json:"spools"`
		Harnesses json.RawMessage `json:"harnesses"`
	}
	if err := decode(raw, &config); err != nil {
		return Member{}, err
	}
	member := Member{Path: path, Name: config.Name}
	d.mu.Lock()
	if _, ok := d.members[path]; ok {
		d.mu.Unlock()
		return member, nil
	}
	for _, existing := range d.members {
		if member.Name != "" && member.Name == existing.Name {
			d.mu.Unlock()
			return Member{}, fmt.Errorf("duplicate workspace name: %s", member.Name)
		}
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
	if err := d.control("start", path); err != nil {
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
	case "invoke":
		var payload map[string]any
		if err := json.Unmarshal(req.Payload, &payload); err != nil {
			encode(conn, errFrame(err))
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
	case "up":
		target := req.Workspace
		if !filepath.IsAbs(target) && req.CWD != "" {
			target = filepath.Join(req.CWD, target)
		}
		member, err := d.up(target)
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			encode(conn, Frame{OK: true, Result: member})
		}
	case "restart", "down":
		d.lifecycle.Lock()
		member, err := d.resolve(req.Workspace, req.CWD)
		if err == nil && req.Operation == "restart" {
			var config struct {
				Name      string          `json:"name"`
				Spools    []string        `json:"spools"`
				Harnesses json.RawMessage `json:"harnesses"`
			}
			raw, readErr := os.ReadFile(filepath.Join(member.Path, ".millstrand/config.json"))
			if readErr != nil {
				err = readErr
			} else {
				err = decode(raw, &config)
			}
			if err == nil {
				d.mu.Lock()
				for path, existing := range d.members {
					if path != member.Path && config.Name != "" && existing.Name == config.Name {
						err = fmt.Errorf("duplicate workspace name: %s", config.Name)
					}
				}
				d.mu.Unlock()
				member.Name = config.Name
			}
		}
		if err == nil {
			action := "restart"
			if req.Operation == "down" {
				action = "stop"
			}
			err = d.control(action, member.Path)
			if req.Operation == "restart" {
				d.mu.Lock()
				if err == nil {
					d.members[member.Path] = member
				} else {
					delete(d.members, member.Path)
				}
				d.mu.Unlock()
			}
			if err == nil && req.Operation == "down" {
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
		members := make([]Member, 0, len(d.members))
		for _, member := range d.members {
			members = append(members, member)
		}
		d.mu.Unlock()
		err := previous.Process.Kill()
		if err == nil {
			<-done
			err = d.bootHost()
		}
		if err == nil {
			for _, member := range members {
				if startErr := d.control("start", member.Path); startErr != nil {
					d.mu.Lock()
					delete(d.members, member.Path)
					d.mu.Unlock()
					err = errors.Join(err, startErr)
				}
			}
		}
		d.lifecycle.Unlock()
		if err != nil {
			encode(conn, errFrame(err))
		} else {
			encode(conn, Frame{OK: true, Result: map[string]bool{"ready": true}})
		}
	case "status":
		d.mu.Lock()
		members := make([]Member, 0, len(d.members))
		for _, member := range d.members {
			members = append(members, member)
		}
		pid := d.host.Process.Pid
		d.mu.Unlock()
		encode(conn, Frame{OK: true, Result: map[string]any{"pid": os.Getpid(), "hostPid": pid, "members": members}})
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
		encode(conn, errFrame(fmt.Errorf("unknown Mill operation: %s", req.Operation)))
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
	lock, err := os.OpenFile(filepath.Join(home, "mill.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("Mill is already running")
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
	d := &Daemon{home: home, repo: Repo(), hostSocket: filepath.Join(home, "host.sock"), members: map[string]Member{}, custodies: map[string]*process.Custody{}, listener: listener}
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
		return fmt.Errorf("Mill is unreachable; run mill start: %w", err)
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
func Start() error {
	var existing bytes.Buffer
	if err := Dial(request("status", "", nil), &existing); err == nil {
		var frame Frame
		if json.Unmarshal(existing.Bytes(), &frame) == nil && frame.OK {
			return nil
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(Home(), 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(Home(), "mill.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(exe, "serve")
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		var output bytes.Buffer
		if err := Dial(request("status", "", nil), &output); err == nil {
			var frame Frame
			if json.Unmarshal(output.Bytes(), &frame) == nil && frame.OK {
				return nil
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	return errors.New("Mill start timed out; inspect mill.log")
}
func workspace(args []string) (string, []string, error) {
	target := ""
	result := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--workspace" {
			i++
			if i == len(args) {
				return "", nil, errors.New("--workspace requires a value")
			}
			target = args[i]
		} else {
			result = append(result, args[i])
		}
	}
	if target == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return "", nil, err
		}
		for {
			if _, err := os.Stat(filepath.Join(cwd, ".millstrand/config.json")); err == nil {
				target = cwd
				break
			}
			parent := filepath.Dir(cwd)
			if parent == cwd {
				return "", nil, errors.New("no workspace; pass --workspace path|name")
			}
			cwd = parent
		}
	}
	return target, result, nil
}
func Relay(req Request) int {
	var output bytes.Buffer
	if req.Operation != "invoke" {
		if err := Dial(req, &output); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		var frame Frame
		if err := json.Unmarshal(output.Bytes(), &frame); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if !frame.OK {
			encode(os.Stderr, frame.Error)
			return 1
		}
		encode(os.Stdout, frame.Result)
		return 0
	}
	conn, err := net.DialTimeout("unix", socket(), time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer conn.Close()
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 16*1024*1024)
	stream := false
	for scanner.Scan() {
		line := scanner.Bytes()
		var frame map[string]json.RawMessage
		if !json.Valid(line) {
			fmt.Fprintln(os.Stderr, "malformed JSON response")
			return 1
		}
		objectErr := json.Unmarshal(line, &frame)
		if !stream && objectErr != nil {
			fmt.Fprintln(os.Stderr, objectErr)
			return 1
		}
		if !stream {
			if bytes.Equal(frame["stream"], []byte("true")) {
				stream = true
				continue
			}
			if bytes.Equal(frame["ok"], []byte("true")) {
				fmt.Fprintln(os.Stdout, string(frame["result"]))
				return 0
			}
			fmt.Fprintln(os.Stderr, string(frame["error"]))
			return 1
		}
		if bytes.Equal(frame["done"], []byte("true")) && string(frame["request_id"]) == fmt.Sprintf("%q", req.ID) {
			if bytes.Equal(frame["success"], []byte("true")) {
				return 0
			}
			fmt.Fprintln(os.Stderr, string(frame["error"]))
			return 1
		}
		fmt.Fprintln(os.Stdout, string(line))
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
	} else {
		fmt.Fprintln(os.Stderr, "response ended without a terminal frame")
	}
	return 1
}
func Strand(args []string) int {
	target, args, err := workspace(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	timeout := 30 * time.Second
	filtered := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--timeout" {
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "--timeout requires a duration")
				return 1
			}
			var parseErr error
			timeout, parseErr = time.ParseDuration(args[i])
			if parseErr != nil || timeout <= 0 {
				fmt.Fprintln(os.Stderr, "invalid timeout")
				return 1
			}
		} else {
			argument := args[i]
			if strings.HasPrefix(argument, "@") {
				absolute, err := filepath.Abs(argument[1:])
				if err != nil {
					fmt.Fprintln(os.Stderr, err)
					return 1
				}
				argument = "@" + absolute
			}
			filtered = append(filtered, argument)
		}
	}
	args = filtered
	name := "help"
	if len(args) > 0 {
		name = args[0]
		args = args[1:]
	}
	payload := map[string]any{"name": name, "argv": args, "timeout_ms": timeout.Milliseconds()}
	if len(args) == 2 && args[0] == "--payload" {
		var input any
		raw := []byte(args[1])
		if strings.HasPrefix(args[1], "@") {
			raw, err = os.ReadFile(args[1][1:])
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 1
			}
		}
		if err := json.Unmarshal(raw, &input); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		delete(payload, "argv")
		payload["input"] = input
	}
	return Relay(request("invoke", target, payload))
}
func Mill(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "mill start|serve|up PATH|restart PATH|down PATH|restart-host|status|host-status|bin NAME|stop")
		return 1
	}
	switch args[0] {
	case "serve":
		if err := Serve(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	case "start":
		if err := Start(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	case "bin":
		target, rest, err := workspace(args[1:])
		if err != nil || len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "mill bin NAME --workspace PATH|NAME [ARGS]")
			return 1
		}
		return Relay(request("invoke", target, map[string]any{"name": rest[0], "argv": rest[1:], "bin": true}))
	default:
		target := ""
		if len(args) > 1 {
			target = args[1]
		}
		return Relay(request(args[0], target, nil))
	}
}
