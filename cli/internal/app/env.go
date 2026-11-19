package app

import (
	"errors"
	"strings"
)

const envUsage = `Usage:
  botlake env add NAME=VALUE
  botlake env remove NAME

Add or replace a variable (NAME= sets an empty value), or unset it.
Changes apply to future supervisor-launched processes that inherit its
environment. Running processes and caller-supplied environments are unchanged.
Changes last until the supervisor exits. BL_HOME selects the supervisor.
Values passed as arguments may be visible in process listings or shell history.
`

const envSyntax = "usage: botlake env add NAME=VALUE | botlake env remove NAME"

type envChange struct {
	Name  string  `json:"name"`
	Value *string `json:"value,omitempty"`
}

func envHelp(path []string) int {
	if len(path) == 0 || len(path) == 1 && (path[0] == "add" || path[0] == "remove") {
		return writeHelp(envUsage)
	}
	return cliFailure(errors.New(envSyntax), false)
}

func envCLI(args []string) int {
	if len(args) == 0 || len(args) == 1 && isHelpArg(args[0]) {
		return envHelp(nil)
	}
	if args[0] == "help" {
		return envHelp(args[1:])
	}
	if len(args) == 2 && (args[1] == "--help" || args[1] == "-h") {
		return envHelp(args[:1])
	}
	if len(args) != 2 || (args[0] != "add" && args[0] != "remove") {
		return cliFailure(errors.New(envSyntax), false)
	}

	change := envChange{Name: args[1]}
	if args[0] == "add" {
		name, value, ok := strings.Cut(args[1], "=")
		if !ok {
			return cliFailure(errors.New("usage: botlake env add NAME=VALUE"), false)
		}
		change = envChange{Name: name, Value: &value}
	}
	return Relay(request("env-"+args[0], "", change))
}

func changeSupervisorEnv(req Request, set func(string, string) error, unset func(string) error) (map[string]string, error) {
	var change envChange
	if err := decode(req.Payload, &change); err != nil {
		return nil, err
	}
	if change.Name == "" || strings.ContainsAny(change.Name, "=\x00") {
		return nil, errors.New("environment variable name must be nonempty and contain neither '=' nor NUL")
	}

	action := strings.TrimPrefix(req.Operation, "env-")
	if action == "add" {
		if change.Value == nil {
			return nil, errors.New("env add requires a value (use an empty string to set an empty value)")
		}
		if err := set(change.Name, *change.Value); err != nil {
			return nil, err
		}
	} else {
		if change.Value != nil {
			return nil, errors.New("env remove takes only a name")
		}
		if err := unset(change.Name); err != nil {
			return nil, err
		}
	}
	return map[string]string{"name": change.Name, "action": action}, nil
}
