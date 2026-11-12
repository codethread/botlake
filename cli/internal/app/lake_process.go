package app

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const lakeWireVersion = 1

type lakeProcess struct {
	member       Member
	generation   string
	info         map[string]any
	cmd          *exec.Cmd
	control      io.WriteCloser
	exited       chan struct{}
	waitErr      error
	intentional  atomic.Bool
	messages     <-chan lakeMessage
	messageErr   <-chan error
	socket       string
	admission    sync.Mutex
	drainReason  string
	drainStarted chan struct{}
}

type lakeMessage struct {
	Version     int            `json:"v"`
	Kind        string         `json:"kind"`
	Generation  string         `json:"generation"`
	WireVersion int            `json:"wire_version"`
	Name        string         `json:"name"`
	CoreVersion string         `json:"core_version"`
	Info        map[string]any `json:"info"`
	Phase       string         `json:"phase"`
	Error       any            `json:"error"`
}

func (d *Daemon) startLake(path string, env map[string]string) (*lakeProcess, error) {
	generation, err := randomGeneration()
	if err != nil {
		return nil, err
	}
	runDir := filepath.Join(d.home, "lakes", generation)
	socket := filepath.Join(d.home, "l-"+generation[:8]+".sock")
	if err := os.MkdirAll(runDir, 0700); err != nil {
		return nil, err
	}
	cleanup := func() { _ = os.RemoveAll(runDir); _ = os.Remove(socket) }

	botlakeDir, err := canonical(filepath.Join(path, ".botlake"))
	if err != nil {
		cleanup()
		return nil, err
	}
	lease, err := os.OpenFile(filepath.Join(botlakeDir, "world.db.botlake.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		cleanup()
		return nil, err
	}
	if err := syscall.Flock(int(lease.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lease.Close()
		cleanup()
		return nil, errors.New("lake database is already owned by another supervisor")
	}

	controlRead, controlWrite, err := os.Pipe()
	if err != nil {
		lease.Close()
		cleanup()
		return nil, err
	}
	replyRead, replyWrite, err := os.Pipe()
	if err != nil {
		controlRead.Close()
		controlWrite.Close()
		lease.Close()
		cleanup()
		return nil, err
	}

	runner := filepath.Join(botlakeDir, "node_modules", "@botlake", "core", "src", "runtime", "runner.ts")
	if _, err := os.Stat(runner); err != nil {
		runner = filepath.Join(path, "node_modules", "@botlake", "core", "src", "runtime", "runner.ts")
		if _, err := os.Stat(runner); err != nil {
			controlRead.Close()
			controlWrite.Close()
			replyRead.Close()
			replyWrite.Close()
			lease.Close()
			cleanup()
			return nil, fmt.Errorf("lake runner is unavailable from the workspace install: %w", err)
		}
	}
	launch, err := json.Marshal(map[string]any{
		"workspace": path, "generation": generation, "socket": socket,
		"botlakeSocket": socketPath(d.home), "env": env,
	})
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("bun", runner)
	cmd.Dir = botlakeDir
	cmd.Stdin = controlRead
	cmd.ExtraFiles = []*os.File{replyWrite, lease}
	cmd.Env = append(os.Environ(), "BOTLAKE_LAUNCH="+string(launch))
	log, err := os.OpenFile(filepath.Join(runDir, "runtime.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		log.Close()
		controlRead.Close()
		controlWrite.Close()
		replyRead.Close()
		replyWrite.Close()
		lease.Close()
		cleanup()
		return nil, err
	}
	// The child is the sole owner of its inherited lease after spawn.
	controlRead.Close()
	replyWrite.Close()
	lease.Close()
	log.Close()

	lake := &lakeProcess{
		generation:   generation,
		cmd:          cmd,
		control:      controlWrite,
		exited:       make(chan struct{}),
		socket:       socket,
		drainStarted: make(chan struct{}),
	}
	go func() {
		lake.waitErr = cmd.Wait()
		close(lake.exited)
		cleanup()
	}()
	scanner := bufio.NewScanner(replyRead)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	deadline := time.After(15 * time.Second)
	messages := make(chan lakeMessage, 1)
	errorsCh := make(chan error, 1)
	go func() {
		defer replyRead.Close()
		for scanner.Scan() {
			var message lakeMessage
			if err := decode(scanner.Bytes(), &message); err != nil {
				errorsCh <- err
				return
			}
			messages <- message
		}
		if err := scanner.Err(); err != nil {
			errorsCh <- err
		} else {
			errorsCh <- io.EOF
		}
	}()

	fail := func(err error) (*lakeProcess, error) {
		_ = controlWrite.Close()
		_ = cmd.Process.Kill()
		<-lake.exited
		return nil, err
	}
	var prepared lakeMessage
	select {
	case prepared = <-messages:
	case err := <-errorsCh:
		return fail(fmt.Errorf("lake exited before prepared: %w", err))
	case <-deadline:
		return fail(errors.New("lake startup timed out before prepared"))
	}
	if prepared.Kind == "failed" {
		return fail(fmt.Errorf("lake %s failed: %v", prepared.Phase, prepared.Error))
	}
	if prepared.Kind != "prepared" || prepared.Version != lakeWireVersion || prepared.WireVersion != lakeWireVersion || prepared.Generation != generation {
		return fail(errors.New("lake returned an incompatible prepared handshake"))
	}
	if !workspaceName.MatchString(prepared.Name) {
		return fail(fmt.Errorf("invalid workspace name %q", prepared.Name))
	}
	member := Member{Path: path, Name: prepared.Name, Env: env}
	d.mu.Lock()
	err = d.checkName(member)
	d.mu.Unlock()
	if err != nil {
		return fail(err)
	}
	if err := json.NewEncoder(controlWrite).Encode(map[string]any{"v": lakeWireVersion, "kind": "activate", "generation": generation}); err != nil {
		return fail(err)
	}

	var ready lakeMessage
	select {
	case ready = <-messages:
	case err := <-errorsCh:
		return fail(fmt.Errorf("lake exited before ready: %w", err))
	case <-deadline:
		return fail(errors.New("lake startup timed out before ready"))
	}
	if ready.Kind == "failed" {
		return fail(fmt.Errorf("lake %s failed: %v", ready.Phase, ready.Error))
	}
	if ready.Kind != "ready" || ready.Generation != generation {
		return fail(errors.New("lake returned an invalid ready handshake"))
	}
	if ready.Info["name"] != prepared.Name || ready.Info["coreVersion"] != prepared.CoreVersion || ready.Info["path"] != path {
		return fail(errors.New("lake ready metadata does not match prepared handshake"))
	}
	lake.member, lake.info = member, ready.Info
	lake.messages, lake.messageErr = messages, errorsCh
	go d.watchLake(lake)
	return lake, nil
}

func (d *Daemon) watchLake(lake *lakeProcess) {
	<-lake.exited
	if lake.intentional.Load() {
		return
	}
	d.lifecycle.Lock()
	defer d.lifecycle.Unlock()
	d.mu.Lock()
	current := d.lakes[lake.member.Path]
	if current != lake || d.stopping {
		d.mu.Unlock()
		return
	}
	delete(d.members, lake.member.Path)
	delete(d.lakes, lake.member.Path)
	d.mu.Unlock()
	replacement, err := d.startLake(lake.member.Path, lake.member.Env)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Lake recovery failed for %s: %v\n", lake.member.Path, err)
		return
	}
	d.mu.Lock()
	d.members[replacement.member.Path] = replacement.member
	d.lakes[replacement.member.Path] = replacement
	d.mu.Unlock()
}

func (d *Daemon) stopLake(lake *lakeProcess, reason string) error {
	if lake == nil {
		return errors.New("workspace is not running")
	}
	lake.admission.Lock()
	if lake.drainReason != "" {
		lake.admission.Unlock()
		return errors.New("lake is already draining")
	}
	lake.drainReason = reason
	close(lake.drainStarted)
	lake.admission.Unlock()
	lake.intentional.Store(true)
	_ = json.NewEncoder(lake.control).Encode(map[string]any{"v": lakeWireVersion, "kind": "drain", "generation": lake.generation, "reason": reason, "finish_ms": 5000})
	_ = lake.control.Close()
	select {
	case message := <-lake.messages:
		if message.Kind == "failed" {
			<-lake.exited
			return fmt.Errorf("lake %s failed: %v", message.Phase, message.Error)
		}
		if message.Kind != "stopped" {
			return fmt.Errorf("invalid lake stop message: %s", message.Kind)
		}
	case err := <-lake.messageErr:
		if !errors.Is(err, io.EOF) {
			return err
		}
	case <-time.After(10 * time.Second):
		_ = lake.cmd.Process.Kill()
		<-lake.exited
		return errors.New("lake shutdown timed out")
	}
	<-lake.exited
	if lake.waitErr != nil {
		return fmt.Errorf("lake exited during stop: %w", lake.waitErr)
	}
	return nil
}

func (d *Daemon) invokeLake(lake *lakeProcess, payload map[string]any) (io.ReadCloser, error) {
	lake.admission.Lock()
	if lake.drainReason != "" {
		reason := lake.drainReason
		lake.admission.Unlock()
		return nil, newLakeLifecycleError(lake.member.Path, reason, "not-admitted")
	}
	invocationID, err := randomGeneration()
	if err != nil {
		lake.admission.Unlock()
		return nil, err
	}
	lake.admission.Unlock()

	requestID, ok := payload["request_id"].(string)
	if !ok || requestID == "" {
		return nil, errors.New("invocation request ID is required")
	}
	payload["workspace"] = lake.member.Path
	payload["generation"] = lake.generation
	payload["invocation_id"] = invocationID
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", lake.socket)
	}}
	client := &http.Client{Transport: transport}
	request, err := http.NewRequest(http.MethodPost, "http://lake/v1/invoke", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		transport.CloseIdleConnections()
		if reason := lake.currentDrainReason(); reason != "" {
			return nil, newLakeLifecycleError(lake.member.Path, reason, "uncertain")
		}
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024+1))
		transport.CloseIdleConnections()
		return nil, fmt.Errorf("lake rejected invocation: %s", bytes.TrimSpace(raw))
	}

	reader, writer := io.Pipe()
	go relayLakeInvocation(lake, requestID, invocationID, &transportBody{ReadCloser: response.Body, transport: transport}, writer)
	return reader, nil
}

type lakeInvokeFrame struct {
	Kind         string          `json:"kind"`
	InvocationID string          `json:"invocation_id"`
	Value        json.RawMessage `json:"value"`
	ContentType  string          `json:"content_type"`
	Error        json.RawMessage `json:"error"`
}

type lakeFrameRead struct {
	frame lakeInvokeFrame
	err   error
}

func relayLakeInvocation(lake *lakeProcess, requestID, invocationID string, body io.ReadCloser, output *io.PipeWriter) {
	defer body.Close()
	defer output.Close()

	frames := make(chan lakeFrameRead, 1)
	go func() {
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 4096), 16*1024*1024)
		for scanner.Scan() {
			var frame lakeInvokeFrame
			if err := decode(scanner.Bytes(), &frame); err != nil {
				frames <- lakeFrameRead{err: err}
				return
			}
			frames <- lakeFrameRead{frame: frame}
		}
		if err := scanner.Err(); err != nil {
			frames <- lakeFrameRead{err: err}
		} else {
			frames <- lakeFrameRead{err: io.ErrUnexpectedEOF}
		}
	}()

	streaming := false
	for {
		var read lakeFrameRead
		if streaming {
			select {
			case <-lake.drainStarted:
				writeLifecycleTerminal(output, requestID, lake.member.Path, lake.currentDrainReason())
				return
			case read = <-frames:
			}
		} else {
			read = <-frames
		}
		if read.err != nil {
			if reason := lake.currentDrainReason(); reason != "" {
				if streaming {
					writeLifecycleTerminal(output, requestID, lake.member.Path, reason)
				} else {
					writeLifecycleFailure(output, lake.member.Path, reason)
				}
				return
			}
			_ = output.CloseWithError(read.err)
			return
		}
		frame := read.frame
		if frame.InvocationID != invocationID {
			_ = output.CloseWithError(errors.New("lake returned a mismatched invocation ID"))
			return
		}
		switch frame.Kind {
		case "result":
			encode(output, map[string]any{"ok": true, "result": frame.Value, "content_type": frame.ContentType})
			return
		case "stream":
			if streaming {
				_ = output.CloseWithError(errors.New("lake returned a duplicate stream opener"))
				return
			}
			streaming = true
			encode(output, map[string]any{"protocol_version": 1, "request_id": requestID, "stream": true})
			select {
			case <-lake.drainStarted:
				writeLifecycleTerminal(output, requestID, lake.member.Path, lake.currentDrainReason())
				return
			default:
			}
		case "item":
			if !streaming || len(frame.Value) == 0 {
				_ = output.CloseWithError(errors.New("lake returned an item outside a stream"))
				return
			}
			if _, err := output.Write(append(frame.Value, '\n')); err != nil {
				return
			}
		case "end":
			if !streaming {
				_ = output.CloseWithError(errors.New("lake ended a stream before opening it"))
				return
			}
			encode(output, map[string]any{"protocol_version": 1, "request_id": requestID, "done": true, "success": true, "result": nil})
			return
		case "error":
			if len(frame.Error) == 0 {
				_ = output.CloseWithError(errors.New("lake returned an empty error"))
				return
			}
			if lakeErrorCode(frame.Error) == "drained" {
				reason := lake.currentDrainReason()
				if reason == "" {
					_ = output.CloseWithError(errors.New("lake reported drain without a lifecycle transition"))
					return
				}
				if streaming {
					writeLifecycleTerminal(output, requestID, lake.member.Path, reason)
				} else {
					writeLifecycleFailure(output, lake.member.Path, reason)
				}
				return
			}
			if streaming {
				encode(output, map[string]any{"protocol_version": 1, "request_id": requestID, "done": true, "success": false, "error": frame.Error})
			} else {
				encode(output, map[string]any{"ok": false, "error": frame.Error})
			}
			return
		default:
			_ = output.CloseWithError(fmt.Errorf("lake returned unknown invocation frame %q", frame.Kind))
			return
		}
	}
}

func (lake *lakeProcess) currentDrainReason() string {
	lake.admission.Lock()
	defer lake.admission.Unlock()
	return lake.drainReason
}

func lakeErrorCode(raw json.RawMessage) string {
	var value struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &value)
	return value.Code
}

func writeLifecycleFailure(output io.Writer, workspace, reason string) {
	errorValue := newLakeLifecycleError(workspace, reason, "uncertain").(*lakeLifecycleError)
	encode(output, map[string]any{
		"ok": false,
		"error": map[string]any{
			"type": "error", "code": errorValue.Code, "message": errorValue.Message,
			"details": map[string]any{"workspace": workspace, "delivery": "uncertain"},
		},
	})
}

func writeLifecycleTerminal(output io.Writer, requestID, workspace, reason string) {
	errorValue := newLakeLifecycleError(workspace, reason, "uncertain").(*lakeLifecycleError)
	encode(output, map[string]any{
		"protocol_version": 1,
		"request_id":       requestID,
		"done":             true,
		"success":          false,
		"error": map[string]any{
			"type": "error", "code": errorValue.Code, "message": errorValue.Message,
			"details": map[string]any{"workspace": workspace, "delivery": "uncertain"},
		},
	})
}

type lakeLifecycleError struct {
	Code      string
	Message   string
	Workspace string
	Delivery  string
}

func (err *lakeLifecycleError) Error() string { return err.Message }

func newLakeLifecycleError(workspace, reason, delivery string) error {
	code := "lake-stopping"
	message := "Lake is stopping"
	if reason == "restart" {
		code = "lake-restarting"
		message = "Lake is restarting"
	}
	return &lakeLifecycleError{Code: code, Message: message, Workspace: workspace, Delivery: delivery}
}

type transportBody struct {
	io.ReadCloser
	transport *http.Transport
}

func (body *transportBody) Close() error {
	err := body.ReadCloser.Close()
	body.transport.CloseIdleConnections()
	return err
}

func randomGeneration() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func socketPath(home string) string { return filepath.Join(home, "botlake.sock") }
