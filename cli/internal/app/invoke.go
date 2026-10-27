package app

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"golang.org/x/term"
)

var Version = "0.1.0"

func printVersion() int {
	build := "development"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				build = setting.Value
			}
		}
	}
	encode(os.Stdout, map[string]any{"version": Version, "build_id": build, "protocol_version": 1})
	return 0
}

type payloadFlags []string

func (p *payloadFlags) String() string { return strings.Join(*p, ", ") }
func (p *payloadFlags) Set(value string) error {
	*p = append(*p, value)
	return nil
}

type invocationFlags struct {
	workspace, cwd, worktree, common, timeout, input string
	stdin, dryRun, version, help, json, inputSet     bool
	payloads                                         payloadFlags
}

func BL(args []string) int {
	var p invocationFlags
	flags := flag.NewFlagSet("bl", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&p.workspace, "workspace", "", "workspace path or published name")
	flags.StringVar(&p.cwd, "cwd", "", "invocation working directory")
	flags.StringVar(&p.worktree, "worktree-root", "", "explicit Git worktree root")
	flags.StringVar(&p.common, "git-common-dir", "", "explicit Git common directory")
	flags.StringVar(&p.timeout, "timeout", "30s", "invocation deadline")
	flags.StringVar(&p.input, "input", "", "JSON input, @file, or - for stdin")
	flags.Var(&p.payloads, "payload", "named text payload: name=path (repeatable)")
	flags.BoolVar(&p.stdin, "stdin", false, "read stdin into the stdin payload")
	flags.BoolVar(&p.dryRun, "dry-run", false, "print the request without invoking it")
	flags.BoolVar(&p.version, "version", false, "print CLI and protocol versions")
	flags.BoolVar(&p.help, "help", false, "show dispatcher help")
	flags.BoolVar(&p.help, "h", false, "show dispatcher help")
	flags.BoolVar(&p.json, "json", false, "force machine-readable output")
	if err := flags.Parse(args); err != nil {
		return cliFailure(err, p.json)
	}
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "input" {
			p.inputSet = true
		}
	})
	args = flags.Args()
	if p.version {
		return printVersion()
	}
	if p.help && len(args) > 0 {
		return cliFailure(fmt.Errorf("--help must follow the operation: bl %s --help", args[0]), p.json)
	}
	if p.help || len(args) == 0 {
		if p.json {
			encode(os.Stdout, blUsage)
		} else {
			fmt.Fprint(os.Stdout, blUsage)
		}
		return 0
	}
	if mode := os.Getenv("BOTLAKE_ERROR_FORMAT"); mode != "" && mode != "plain" && mode != "pretty" && mode != "json" {
		return cliFailure(errors.New("BOTLAKE_ERROR_FORMAT must be plain, pretty or json"), p.json)
	}
	name, argv := args[0], append([]string{}, args[1:]...)
	view := presentation{json: p.json}
	if isDiscovery(name) {
		view.tier = name
		if len(argv) > 0 && argv[0] == "--json" {
			view.json = true
			argv = argv[1:]
		}
		view.path = argv
	} else if len(argv) > 0 && (argv[len(argv)-1] == "--help" || argv[len(argv)-1] == "-h") {
		view.tier = "help"
		view.path = append([]string{name}, argv[:len(argv)-1]...)
	}
	if p.inputSet && (len(argv) > 0 || p.stdin || len(p.payloads) > 0) {
		return cliFailure(errors.New("--input cannot be combined with operation arguments or named payloads"), view.json)
	}
	duration, err := time.ParseDuration(p.timeout)
	if err != nil || duration.Milliseconds() <= 0 {
		return cliFailure(fmt.Errorf("invalid --timeout %q: expected a duration of at least 1ms", p.timeout), view.json)
	}
	cwd := p.cwd
	if cwd == "" {
		cwd, err = os.Getwd()
	} else {
		cwd, err = canonical(cwd)
	}
	if err != nil {
		return cliFailure(err, view.json)
	}
	if p.workspace == "" || p.worktree == "" || p.common == "" {
		worktree, common, gitErr := gitContext(cwd)
		if p.workspace == "" {
			if gitErr != nil {
				return cliFailure(gitErr, view.json)
			}
			p.workspace, err = workspaceFromCommonDir(common)
			if err != nil {
				return cliFailure(err, view.json)
			}
		}
		// Explicit workspaces can be outside Git; context flags always win.
		if gitErr == nil {
			if p.worktree == "" {
				p.worktree = worktree
			}
			if p.common == "" {
				p.common = common
			}
		}
	}
	payloads, err := loadPayloads(p)
	if err != nil {
		return cliFailure(err, view.json)
	}
	for i, argument := range argv {
		prefix, value := "", argument
		if strings.HasPrefix(argument, "--") {
			if key, rest, found := strings.Cut(argument, "="); found {
				prefix, value = key+"=", rest
			}
		}
		if strings.HasPrefix(value, "@") {
			path, err := filepath.Abs(value[1:])
			if err != nil {
				return cliFailure(err, view.json)
			}
			argv[i] = prefix + "@" + path
		}
	}
	isTTY := term.IsTerminal(int(os.Stdout.Fd()))
	var columns any
	if isTTY {
		columns = terminalWidth(os.Stdout)
	}
	payload := map[string]any{
		"name": name, "argv": argv, "payloads": payloads, "timeout_ms": duration.Milliseconds(),
		"cwd": cwd, "is_tty": isTTY, "tty_col": columns,
	}
	if p.worktree != "" {
		payload["worktree_root"] = p.worktree
	}
	if p.common != "" {
		payload["git_common_dir"] = p.common
	}
	if p.inputSet {
		raw := []byte(p.input)
		if p.input == "-" {
			raw, err = io.ReadAll(os.Stdin)
		} else if strings.HasPrefix(p.input, "@") {
			raw, err = os.ReadFile(p.input[1:])
		}
		if err != nil {
			return cliFailure(err, view.json)
		}
		if !json.Valid(raw) {
			return cliFailure(errors.New("--input requires exactly one JSON value"), view.json)
		}
		delete(payload, "argv")
		payload["input"] = json.RawMessage(raw)
	}
	req := request("invoke", p.workspace, payload)
	req.CWD = cwd
	if p.dryRun {
		req.ID = "<dry-run>"
		encode(os.Stdout, req)
		return 0
	}
	return relay(req, view)
}

func loadPayloads(p invocationFlags) (map[string]string, error) {
	paths := map[string]string{}
	for _, spec := range p.payloads {
		name, path, ok := strings.Cut(spec, "=")
		if !ok || strings.TrimSpace(name) == "" || path == "" {
			return nil, fmt.Errorf("malformed --payload %q: expected name=path", spec)
		}
		if _, exists := paths[name]; exists || (name == "stdin" && p.stdin) {
			return nil, fmt.Errorf("duplicate payload slot: %s", name)
		}
		paths[name] = path
	}
	payloads := map[string]string{}
	for name, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read payload %s: %w", name, err)
		}
		payloads[name] = string(data)
	}
	if p.stdin {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return nil, fmt.Errorf("read stdin: %w", err)
		}
		payloads["stdin"] = string(data)
	}
	return payloads, nil
}

const blUsage = `Usage:
  bl [flags] <operation> [arguments...]

Global flags (before the operation):
  --workspace PATH|NAME    Select a workspace or published name
  --cwd DIR               Set invocation context and workspace discovery directory
  --worktree-root DIR     Override the Git worktree context
  --git-common-dir DIR    Override the Git common-directory context
  --stdin                 Attach stdin as text; refer to it with :stdin
  --payload NAME=PATH     Attach a named text file (repeatable); use :payload/NAME
  --input JSON|@FILE|-     Supply the entire JSON operation input; - reads stdin
  --timeout DURATION      Set the deadline (default 30s; e.g. 5s or 1500ms)
  --json                  Force JSON output, including help and errors
  --dry-run               Print the request without invoking it
  --version               Print CLI/build/protocol versions
  -h, --help              Show this dispatcher help without a running workspace

Without --workspace, Git's common directory selects the main checkout's lake.
Linked worktrees share its configuration and data. Outside Git, pass --workspace.
Git context overrides do not change workspace selection.

Workspace operations:
  bl help                        List selected operations
  bl help OP [SUBCOMMAND...]      Discover flags, positionals and subcommands
  bl OP [SUBCOMMAND...] --help    Discover the same command
  bl prime OP                    Read its runbook (also: primer)
  bl about OP                    Read its explanation and schema metadata
  bl help --json OP              Print machine-readable discovery

Examples (with Batteries selected):
  printf 'notes' | bl --stdin note NODE_ID :stdin
  bl --payload attrs=attrs.json add "Title" --attributes :payload/attrs
  printf '{"title":"Title"}' | bl --input - add

Help is formatted for a terminal. Redirected output remains JSON/NDJSON.
Operation arguments belong to the selected extension; -- ends its flag parsing.
NO_COLOR disables color. BOTLAKE_ERROR_FORMAT selects plain|pretty|json errors.
`
