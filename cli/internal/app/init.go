package app

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func initWorkspace(args []string) int {
	fail := func(err error) int { return cliFailure(err, false) }
	flags := flag.NewFlagSet("botlake init", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	target := flags.String("workspace", "", "workspace directory (defaults to the main Git checkout)")
	name := flags.String("name", "", "published workspace name (defaults to directory basename)")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprintln(os.Stdout, "botlake init [--workspace DIR] [--name NAME]")
			return 0
		}
		return fail(err)
	}
	if flags.NArg() != 0 {
		return fail(errors.New("usage: botlake init [--workspace DIR] [--name NAME]"))
	}
	var path string
	var err error
	if *target == "" {
		path, err = defaultWorkspace("")
	} else {
		path, err = canonical(*target)
	}
	if err != nil {
		return fail(err)
	}
	config := filepath.Join(path, ".botlake", "config.json")
	if _, err := os.Stat(config); err == nil {
		member, err := readMember(path)
		if err != nil {
			return fail(err)
		}
		if *name != "" && *name != member.Name {
			return fail(errors.New("workspace already exists; edit its config to change its name"))
		}
		encode(os.Stdout, map[string]any{"workspace": path, "name": member.Name, "created": false})
		return 0
	} else if !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	if *name == "" {
		*name = filepath.Base(path)
	}
	if !workspaceName.MatchString(*name) {
		return fail(errors.New("invalid workspace name; pass --name starting with a letter, followed by letters, digits, underscores or hyphens"))
	}
	if err := os.MkdirAll(filepath.Dir(config), 0755); err != nil {
		return fail(err)
	}
	file, err := os.OpenFile(config, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return fail(err)
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	writeErr := encoder.Encode(map[string]any{"name": *name, "spools": []string{}})
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return fail(err)
	}
	encode(os.Stdout, map[string]any{"workspace": path, "name": *name, "created": true})
	return 0
}
