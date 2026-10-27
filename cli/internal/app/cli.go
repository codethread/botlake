package app

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func workspace(args []string) (string, []string, error) {
	target := ""
	result := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			result = append(result, args[i:]...)
			break
		}
		value, inline := strings.CutPrefix(args[i], "--workspace=")
		if args[i] == "--workspace" || inline {
			if target != "" {
				return "", nil, errors.New("--workspace may only be supplied once")
			}
			if inline {
				target = value
			} else {
				i++
				if i == len(args) {
					return "", nil, errors.New("--workspace requires a value")
				}
				target = args[i]
			}
			if target == "" {
				return "", nil, errors.New("--workspace requires a value")
			}
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
			if _, err := os.Stat(filepath.Join(cwd, ".botlake/config.json")); err == nil {
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
func Botlake(args []string) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Fprintln(os.Stdout, "botlake init [--workspace DIR] [--name NAME]\nbotlake start | status | stop | restart-host | host-status\nbotlake lake start|restart|stop|status --workspace PATH|NAME\nbotlake lake list\nbotlake lake eval [--workspace PATH|NAME] [--timeout DURATION] CODE|@FILE|-\nbotlake bin list|build|run [--workspace PATH|NAME] [NAME] [ARGS]")
		return 0
	}
	fail := func(err error) int {
		return cliFailure(err, false)
	}
	switch args[0] {
	case "--version":
		if len(args) != 1 {
			return fail(errors.New("usage: botlake --version"))
		}
		return printVersion()
	case "init":
		return initWorkspace(args[1:])
	case "start":
		if len(args) != 1 {
			return fail(errors.New("usage: botlake start (foreground daemon)"))
		}
		if err := Serve(); err != nil {
			return fail(err)
		}
		return 0
	case "lake":
		if len(args) < 2 {
			return fail(errors.New("usage: botlake lake start|restart|stop|status|list|eval"))
		}
		action := args[1]
		if action == "eval" {
			return evalCLI(args[2:])
		}
		if action == "list" {
			if len(args) != 2 {
				return fail(errors.New("usage: botlake lake list"))
			}
			return Relay(request("lake-list", "", nil))
		}
		switch action {
		case "start", "restart", "stop", "status":
		default:
			return fail(fmt.Errorf("unknown lake command: %s", action))
		}
		flags := flag.NewFlagSet("botlake lake "+action, flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		target := flags.String("workspace", "", "workspace path or published name")
		if err := flags.Parse(args[2:]); err != nil {
			return fail(err)
		}
		if flags.NArg() != 0 {
			return fail(errors.New("select a workspace with --workspace PATH|NAME"))
		}
		selection := []string{}
		if *target != "" {
			selection = []string{"--workspace", *target}
		}
		selected, _, err := workspace(selection)
		if err != nil {
			return fail(err)
		}
		return Relay(request("lake-"+action, selected, nil))
	case "bin":
		return binCLI(args[1:])
	case "status", "stop", "restart-host", "host-status":
		if len(args) != 1 {
			return fail(fmt.Errorf("usage: botlake %s", args[0]))
		}
		return Relay(request(args[0], "", nil))
	default:
		return fail(fmt.Errorf("unknown Botlake command: %s", args[0]))
	}
}
