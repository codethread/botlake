package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

const binUsage = "botlake bin list [--workspace PATH|NAME]\nbotlake bin build [--workspace PATH|NAME] NAME\nbotlake bin run [--workspace PATH|NAME] NAME [ARGS...]\n"

type binPlan struct {
	Operation   string `json:"operation"`
	Bin         string `json:"bin"`
	Description string `json:"description"`
	Runnable    *bool  `json:"runnable"`
	Exec        struct {
		Path    string            `json:"path"`
		Command string            `json:"command"`
		Env     map[string]string `json:"env"`
	} `json:"exec"`
	Build *struct {
		Argv []string `json:"argv"`
		CWD  string   `json:"cwd"`
	} `json:"build"`
}

func binCLI(args []string) int {
	fail := func(err error) int { return cliFailure(err, true) }
	flags := flag.NewFlagSet("botlake bin", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	target := flags.String("workspace", "", "workspace path or published name")
	if err := flags.Parse(args); err != nil && !errors.Is(err, flag.ErrHelp) {
		return fail(err)
	}
	args = flags.Args()
	if len(args) == 0 || args[0] == "help" {
		fmt.Fprint(os.Stdout, binUsage)
		return 0
	}
	action := args[0]
	if action != "list" && action != "build" && action != "run" {
		return fail(fmt.Errorf("unknown bin command: %s", action))
	}
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(os.Stdout, binUsage)
			return 0
		}
		return fail(err)
	}
	args = flags.Args()
	if (action == "list" && len(args) != 0) || (action == "build" && len(args) != 1) || (action == "run" && len(args) == 0) {
		return fail(errors.New(binUsage))
	}
	if *target == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return fail(err)
		}
		*target, err = enclosingWorkspace(cwd)
		if err != nil {
			return fail(err)
		}
	}
	input := map[string]any{"command": "list"}
	if action != "list" {
		input = map[string]any{"command": "plan", "name": args[0]}
	}
	var response bytes.Buffer
	if err := Dial(request("invoke", *target, map[string]any{"name": "bins", "input": input}), &response); err != nil {
		return fail(err)
	}
	var frame struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(response.Bytes(), &frame); err != nil {
		return fail(err)
	}
	if !frame.OK {
		return renderError(frame.Error, true)
	}
	if action == "list" {
		fmt.Fprintln(os.Stdout, string(frame.Result))
		return 0
	}
	var plan binPlan
	if err := json.Unmarshal(frame.Result, &plan); err != nil {
		return fail(err)
	}
	if err := plan.validate(args[0]); err != nil {
		return fail(err)
	}
	env := binEnvironment(plan.Exec.Env)
	if action == "build" {
		if plan.Build == nil {
			return fail(fmt.Errorf("bin %s has no build recipe", plan.Bin))
		}
		cmd := exec.Command(plan.Build.Argv[0], plan.Build.Argv[1:]...)
		cmd.Dir, cmd.Env = plan.Build.CWD, env
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			return fail(fmt.Errorf("bin %s build failed: %w", plan.Bin, err))
		}
		encode(os.Stdout, map[string]any{"operation": "bin build", "bin": plan.Bin, "exit": 0})
		return 0
	}
	if plan.Runnable != nil && !*plan.Runnable {
		if plan.Build != nil {
			return fail(fmt.Errorf("bin %s is not built; run botlake bin build %s", plan.Bin, plan.Bin))
		}
		return fail(fmt.Errorf("bin %s is not executable: %s", plan.Bin, plan.Exec.Path))
	}
	path := plan.Exec.Path
	if path == "" {
		var err error
		path, err = exec.LookPath(plan.Exec.Command)
		if err != nil {
			return fail(err)
		}
	}
	// Replacing this client preserves the caller's cwd, descriptors, terminal,
	// signals and exit status. The daemon never owns an interactive bin.
	if err := syscall.Exec(path, append([]string{path}, args[1:]...), env); err != nil {
		return fail(err)
	}
	return 0
}

func (p binPlan) validate(name string) error {
	if p.Operation != "bins plan" || p.Bin != name || p.Exec.Env == nil || (p.Exec.Path == "") == (p.Exec.Command == "") {
		return errors.New("malformed bin plan")
	}
	if p.Exec.Path != "" && (!filepath.IsAbs(p.Exec.Path) || p.Runnable == nil) {
		return errors.New("bin path must be absolute and include runnable status")
	}
	if p.Exec.Command != "" && (strings.ContainsAny(p.Exec.Command, `/\`) || p.Runnable != nil) {
		return errors.New("bin command must be a bare executable name")
	}
	for key, value := range p.Exec.Env {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			return errors.New("invalid bin environment")
		}
	}
	if p.Build != nil {
		if len(p.Build.Argv) == 0 || !filepath.IsAbs(p.Build.CWD) {
			return errors.New("invalid bin build recipe")
		}
		for _, arg := range p.Build.Argv {
			if arg == "" {
				return errors.New("empty bin build argument")
			}
		}
	}
	return nil
}

func binEnvironment(overlay map[string]string) []string {
	values := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		values[key] = value
	}
	for key, value := range overlay {
		values[key] = value
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(values))
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}
