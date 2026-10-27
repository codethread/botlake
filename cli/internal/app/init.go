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
	manifest, err := readWorkspacePackage(path)
	missing := errors.Is(err, os.ErrNotExist)
	if err != nil && !missing {
		return fail(err)
	}
	if missing {
		manifest = map[string]json.RawMessage{"private": json.RawMessage("true"), "type": json.RawMessage(`"module"`)}
	}
	if _, exists := manifest["botlake"]; exists {
		member, err := readMember(path)
		if err != nil {
			return fail(err)
		}
		if *name != "" && *name != member.Name {
			return fail(errors.New("workspace already exists; edit botlake.name in .botlake/package.json to change its name"))
		}
		encode(os.Stdout, map[string]any{"workspace": path, "name": member.Name, "created": false})
		return 0
	}
	publishedName := *name
	if publishedName == "" {
		publishedName = filepath.Base(path)
	}
	if !workspaceName.MatchString(publishedName) {
		return fail(errors.New("invalid workspace name; pass --name starting with a letter, followed by letters, digits, underscores or hyphens"))
	}
	config := map[string]any{"extensions": []string{}}
	if *name != "" {
		config["name"] = *name
	}
	manifest["botlake"], err = json.Marshal(config)
	if err != nil {
		return fail(err)
	}
	filePath := filepath.Join(path, ".botlake", "package.json")
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return fail(err)
	}
	mode := os.O_WRONLY | os.O_TRUNC
	if missing {
		mode = os.O_WRONLY | os.O_CREATE | os.O_EXCL
	}
	file, err := os.OpenFile(filePath, mode, 0644)
	if err != nil {
		return fail(err)
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	writeErr := encoder.Encode(manifest)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return fail(err)
	}
	encode(os.Stdout, map[string]any{"workspace": path, "name": publishedName, "created": true})
	return 0
}
