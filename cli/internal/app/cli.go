package app

import (
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

//go:embed completions.zsh
var zshCompletions string

func warnAudienceEnvironment() {
	if _, present := os.LookupEnv("BL_AUDIENCE"); present {
		fmt.Fprintln(os.Stderr, "warning: BL_AUDIENCE is set at lake startup; it is session-scoped, not a lake default, and will be removed from managed agent launches")
	}
}

func Botlake(args []string) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Fprintln(os.Stdout, "botlake init [--workspace DIR] [--name NAME]\nbotlake start | status | stop | restart-host | host-status\nbotlake lake start|restart|stop|status --workspace PATH|NAME\nbotlake lake list\nbotlake lake eval [--workspace PATH|NAME] [--timeout DURATION] CODE|@FILE|-\nbotlake bin list|build|run [--workspace PATH|NAME] [NAME] [ARGS]\nbotlake completions zsh")

		return 0
	}

	fail := func(err error) int {
		return cliFailure(err, false)
	}

	switch args[0] {
	case "completions":
		if len(args) != 2 || args[1] != "zsh" {
			return fail(errors.New("usage: botlake completions zsh"))
		}
		if _, err := io.WriteString(os.Stdout, zshCompletions); err != nil {
			return fail(err)
		}
		return 0
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
		warnAudienceEnvironment()
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
		if *target == "" {
			selected, err := defaultWorkspace("")
			if err != nil {
				return fail(err)
			}

			*target = selected
		}
		var payload any
		if action == "start" || action == "restart" {
			warnAudienceEnvironment()
			payload = map[string]any{"env": environment()}
		}
		return Relay(request("lake-"+action, *target, payload))
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
