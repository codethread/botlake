package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const evalUsage = `Usage:
  mill weaver eval [--workspace PATH|NAME] [--cwd DIR] [--timeout DURATION] CODE|@FILE|-

Run a trusted JavaScript async function body in a caller-side Bun process.
Use return to produce one JSON result. Inline code, caller-relative @files and
stdin (-) are supported. Flags precede the source; -- ends flag parsing.

Bindings:
  q                 Predicate builders from @millstrand/core (and/or/not,
                    eq/ne/lt/lte/gt/gte/inArray, attr/param, exists/missing,
                    edgeOut/edgeIn).
  api.call(OP, INPUT) Invoke a selected operation with JSON input; returns its
                    JSON result. Streaming operations are not supported.

The workspace must already be running; omission discovers it from --cwd or the
caller's directory. The default deadline is 30s across execution and all calls.
Console and process output go to stderr. Only the returned JSON goes to stdout.
This is not a sandbox or a read-only API: scripts have the caller's permissions,
operations may mutate data, and completed mutations are not rolled back on error.
Calls do not share a snapshot. List/ready retain their limits (default 100).

Examples (Batteries must be selected for list/ready/edge):
  mill weaver eval 'return await api.call("query", {});'
  mill weaver eval 'return await api.call("ready", {where:q.eq(q.attr("kanban/type"),"feature"),limit:20});'
  mill weaver eval --workspace work @report.js
  mill weaver eval --timeout 5s - < report.js
`

func evalCLI(args []string) int {
	fail := func(err error) int { return cliFailure(err, true) }
	flags := flag.NewFlagSet("mill weaver eval", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	target := flags.String("workspace", "", "workspace path or published name")
	cwd := flags.String("cwd", "", "caller working directory")
	timeout := flags.String("timeout", "30s", "overall evaluation deadline")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(os.Stdout, evalUsage)
			return 0
		}
		return fail(err)
	}
	if flags.NArg() != 1 {
		return fail(errors.New(evalUsage))
	}
	duration, err := time.ParseDuration(*timeout)
	if err != nil || duration.Milliseconds() <= 0 {
		return fail(fmt.Errorf("invalid --timeout %q: expected a duration of at least 1ms", *timeout))
	}
	if *cwd == "" {
		*cwd, err = os.Getwd()
	} else {
		*cwd, err = canonical(*cwd)
	}
	if err != nil {
		return fail(err)
	}
	if *target == "" {
		*target, err = enclosingWorkspace(*cwd)
		if err != nil {
			return fail(err)
		}
	}
	source, filename := flags.Arg(0), "mill-weaver-eval.js"
	if source == "-" {
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fail(err)
		}
		source = string(raw)
	} else if strings.HasPrefix(source, "@") {
		filename = source[1:]
		if !filepath.IsAbs(filename) {
			filename = filepath.Join(*cwd, filename)
		}
		raw, err := os.ReadFile(filename)
		if err != nil {
			return fail(err)
		}
		source = string(raw)
	}
	core, err := filepath.Abs(Core())
	if err != nil {
		return fail(err)
	}
	socketPath, err := filepath.Abs(socket())
	if err != nil {
		return fail(err)
	}
	interrupt, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(interrupt, duration)
	defer cancel()
	deadline, _ := ctx.Deadline()
	input, err := json.Marshal(map[string]any{
		"socket": socketPath, "workspace": *target, "cwd": *cwd,
		"source": source, "filename": filename, "deadline": deadline.UnixMilli(),
	})
	if err != nil {
		return fail(err)
	}
	// A separate result descriptor keeps arbitrary script stdout out of JSON output.
	result, err := os.CreateTemp("", "mill-eval-*")
	if err != nil {
		return fail(err)
	}
	defer result.Close()
	defer os.Remove(result.Name())
	cmd := exec.CommandContext(ctx, "bun", filepath.Join(core, "src/runtime/eval.ts"))
	cmd.Dir = *cwd
	cmd.Stdin = strings.NewReader(string(input))
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	cmd.ExtraFiles = []*os.File{result}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		} else {
			return err
		}
	}
	runErr := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fail(errors.New("eval deadline exceeded; completed operations are not rolled back"))
	}
	if ctx.Err() != nil {
		return fail(errors.New("eval interrupted; completed operations are not rolled back"))
	}
	if _, err := result.Seek(0, io.SeekStart); err != nil {
		return fail(err)
	}
	raw, err := io.ReadAll(result)
	if err != nil {
		return fail(err)
	}
	if len(raw) == 0 {
		if runErr != nil {
			return fail(runErr)
		}
		return fail(errors.New("eval exited without a result; use return instead of process.exit"))
	}
	var frame struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := decode(raw, &frame); err != nil {
		return fail(err)
	}
	if !frame.OK {
		return renderError(frame.Error, true)
	}
	if runErr != nil {
		return fail(runErr)
	}
	return renderResult(frame.Result, presentation{json: true})
}
