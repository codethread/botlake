package app

import (
	_ "embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

//go:embed completions.zsh
var zshCompletions string

const botlakeUsage = `Usage:
  botlake <command> [flags]

Commands:
  init               Initialize workspace configuration
  start              Run the foreground supervisor
  status             Show supervisor and active-lake status
  stop               Stop the supervisor and its lakes
  restart-host       Restart the Bun host and restore active lakes
  host-status        Inspect the Bun host
  lake <command>     Manage a workspace lake or evaluate code
  bin <command>      List, build or run extension-provided programs
  completions zsh    Print the zsh completion script
  --version          Print this CLI's build and protocol versions

Use "botlake COMMAND --help", "botlake GROUP COMMAND --help", or
"botlake help COMMAND [SUBCOMMAND]" for details. Commands that select a
workspace use --workspace, then BL_WORKSPACE, then the main Git checkout.
BL_HOME selects the supervisor home (default: ~/.botlake).
`

const lakeUsage = `Usage:
  botlake lake <command> [flags]

Commands:
  start       Start a workspace lake
  restart     Reload its configuration and restart it
  stop        Stop a workspace lake
  status      Inspect a workspace lake
  info        Show active-lake package and extension metadata
  list        List active lakes
  eval        Run trusted JavaScript against a running lake

Workspace selection: --workspace PATH|NAME overrides BL_WORKSPACE; otherwise use
the main Git checkout. Outside Git, set BL_WORKSPACE or pass --workspace.
New lakes require a path; published names select active lakes.
"botlake help lake COMMAND" shows details.
`

func warnAudienceEnvironment() {
	if _, present := os.LookupEnv("BL_AUDIENCE"); present {
		fmt.Fprintln(os.Stderr, "warning: BL_AUDIENCE is set at lake startup; it is session-scoped, not a lake default, and will be removed from managed agent launches")
	}
}

func isHelpArg(arg string) bool { return arg == "help" || arg == "--help" || arg == "-h" }

func writeHelp(text string) int {
	if _, err := io.WriteString(os.Stdout, text); err != nil {
		return cliFailure(err, false)
	}

	return 0
}

func helpCLI(path []string) int {
	if len(path) == 0 {
		return writeHelp(botlakeUsage)
	}

	switch path[0] {
	case "init":
		if len(path) == 1 {
			return writeHelp(initUsage)
		}
	case "start", "status", "stop", "restart-host", "host-status":
		if len(path) == 1 {
			return writeHelp(supervisorCommandHelp(path[0]))
		}
	case "lake":
		if len(path) == 1 {
			return writeHelp(lakeUsage)
		}
		if len(path) == 2 {
			switch path[1] {
			case "start", "restart", "stop", "status", "info", "list", "eval":
				return writeHelp(lakeCommandHelp(path[1]))
			}
		}
	case "bin":
		return binHelp(path[1:])
	case "completions":
		if len(path) == 1 || (len(path) == 2 && path[1] == "zsh") {
			return writeHelp(completionsUsage)
		}
	case "--version":
		if len(path) == 1 {
			return writeHelp("Usage:\n  botlake --version\n\nPrint this executable's CLI version, build ID and wire protocol version as JSON. This is offline; use botlake status for the running supervisor and loaded core.\n")
		}
	}

	return cliFailure(fmt.Errorf("unknown help topic: botlake %s", strings.Join(path, " ")), false)
}

func supervisorCommandHelp(command string) string {
	common := "The supervisor home is BL_HOME (default: ~/.botlake)."
	switch command {
	case "start":
		return `Usage:
  botlake start

Run the supervisor in the foreground and start its Bun host. Keep this process
running while using lakes. BL_HOME selects the supervisor home (default:
~/.botlake); BL_CORE can select the core package (default: this checkout).
`
	case "status":
		return `Usage:
  botlake status

Show the running supervisor build/protocol, loaded core version, Bun host readiness
and registered lakes. activeProcesses maps canonical lake paths to nonterminal
supervisor-owned processes ({handle, owner, key}), including custody retained for
stopped lakes. owner/key are opaque consumer identifiers for further inspection.
Empty arrays mean no active custody records; terminal evidence is excluded.
This is an in-memory snapshot, not a restart lock: new activity can start afterwards.
` + common + "\n"
	case "stop":
		return `Usage:
  botlake stop

Stop the supervisor and its managed lakes. ` + common + "\n"
	case "restart-host":
		return `Usage:
  botlake restart-host

Restart the Bun host and restore currently active lakes from their workspace
configuration. ` + common + "\n"
	case "host-status":
		return `Usage:
  botlake host-status

Inspect Bun host readiness, loaded core version and runtime status. ` + common + "\n"
	default:
		return botlakeUsage
	}
}

func lakeCommandHelp(command string) string {
	flags := `Flags:
  --workspace PATH|NAME  Select a workspace (overrides BL_WORKSPACE)
`
	selection := `
Without either selection, use the main Git checkout (shared by linked worktrees).
Outside Git, set BL_WORKSPACE or pass --workspace. A new lake needs a path;
published names refer to active lakes.
`
	common := flags + selection
	switch command {
	case "start":
		return `Usage:
  botlake lake start [--workspace PATH|NAME] [--install]

Start the selected workspace lake. An already-running lake is returned as-is.

` + flags + "  --install              Run bun install in .botlake before starting\n" + selection
	case "restart":
		return `Usage:
  botlake lake restart [--workspace PATH|NAME]

Reload the selected workspace configuration and restart its lake.

` + common
	case "stop":
		return `Usage:
  botlake lake stop [--workspace PATH|NAME]

Stop the selected lake without stopping the supervisor.

` + common
	case "status":
		return `Usage:
  botlake lake status [--workspace PATH|NAME]

Report whether the selected lake is ready and the loaded core version.

` + common
	case "info":
		return `Usage:
  botlake lake info [--workspace PATH|NAME]

Show the running lake's startup snapshot as JSON:
{path,name,packageJson,coreVersion,minimumCore,extensions:[{name,description,specifier,module,source,packageJson,readme}]}.

Extensions follow selection order. Their name is the runtime extension name,
not the package name. description comes from package.json, or null when absent.
Paths are absolute; packageJson and readme
are null when absent. module is the selected entry; source is its defining
module, preserved by configured factories. Configuration edits appear after
restart. This command neither loads modules nor starts inactive lakes.

` + common
	case "list":
		return `Usage:
  botlake lake list

List currently active lakes and their published workspace names. This command
does not start or discover inactive workspaces.
`
	case "eval":
		return evalUsage
	default:
		return lakeUsage
	}
}

const completionsUsage = `Usage:
  botlake completions zsh

Print the zsh completion script to stdout. Source it or redirect it to a file;
generation is offline and does not contact the supervisor.
`

func Botlake(args []string) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		return helpCLI(nil)
	}
	if args[0] == "help" {
		return helpCLI(args[1:])
	}

	fail := func(err error) int {
		return cliFailure(err, false)
	}

	switch args[0] {
	case "completions":
		if (len(args) == 2 && isHelpArg(args[1])) || (len(args) == 3 && args[1] == "zsh" && isHelpArg(args[2])) {
			return writeHelp(completionsUsage)
		}
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
		if len(args) == 2 && isHelpArg(args[1]) {
			return writeHelp(supervisorCommandHelp("start"))
		}
		if len(args) != 1 {
			return fail(errors.New("usage: botlake start (foreground daemon)"))
		}
		warnAudienceEnvironment()
		if err := Serve(); err != nil {
			return fail(err)
		}
		return 0
	case "lake":
		if len(args) == 1 || len(args) == 2 && isHelpArg(args[1]) {
			return writeHelp(lakeUsage)
		}
		if args[1] == "help" {
			return helpCLI(append([]string{"lake"}, args[2:]...))
		}
		action := args[1]
		if action == "eval" {
			return evalCLI(args[2:])
		}
		if action == "list" {
			if len(args) == 3 && isHelpArg(args[2]) {
				return writeHelp(lakeCommandHelp("list"))
			}
			if len(args) != 2 {
				return fail(errors.New("usage: botlake lake list"))
			}
			return Relay(request("lake-list", "", nil))
		}
		switch action {
		case "start", "restart", "stop", "status", "info":
		default:
			return fail(fmt.Errorf("unknown lake command: %s", action))
		}
		flags := flag.NewFlagSet("botlake lake "+action, flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		target := flags.String("workspace", "", "workspace path or published name")
		install := false
		if action == "start" {
			flags.BoolVar(&install, "install", false, "install the lake's dependencies before starting")
		}
		if err := flags.Parse(args[2:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return writeHelp(lakeCommandHelp(action))
			}
			return fail(err)
		}
		if flags.NArg() == 1 && flags.Arg(0) == "help" {
			return writeHelp(lakeCommandHelp(action))
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
		operation := "lake-" + action
		if install {
			operation = lakeInstallStart
		}
		return Relay(request(operation, *target, payload))
	case "bin":
		return binCLI(args[1:])
	case "status", "stop", "restart-host", "host-status":
		if len(args) == 2 && isHelpArg(args[1]) {
			return writeHelp(supervisorCommandHelp(args[0]))
		}
		if len(args) != 1 {
			return fail(fmt.Errorf("usage: botlake %s", args[0]))
		}
		return Relay(request(args[0], "", nil))
	default:
		return fail(fmt.Errorf("unknown Botlake command: %s", args[0]))
	}
}
