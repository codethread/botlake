package app

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const initUsage = `Usage:
  botlake init [--workspace DIR] [--name NAME]

Initialize inert .botlake/lake.ts configuration with Batteries selected and
latest-version dependencies for core and Batteries in .botlake/package.json. Add .botlake/.gitignore entries for
node_modules and the lake database. Create .botlake/bunfig.toml with isolated
installs and a seven-day minimum release age, excluding core and Batteries.
Existing bunfig.toml files are preserved. Run bun install --frozen-lockfile in
.botlake unless a root bun.lock exists; then print manual installation and
workspace guidance instead. Report guidance and install output on stderr.
Existing package fields are preserved; if lake.ts already exists, init reports it
and makes no changes.

Flags:
  --workspace DIR  Workspace directory (overrides BL_WORKSPACE)
  --name NAME      Published workspace name (default: directory basename)

Without --workspace, use BL_WORKSPACE (a directory for init), then Git discovery
of the main checkout, including from linked worktrees and subdirectories.
Outside Git, set BL_WORKSPACE or pass --workspace. Names start with a letter
and contain only letters, digits, underscores or hyphens.

Examples:
  botlake init
  botlake init --workspace /path/to/project --name work
`

const initBunfig = `[install]
linker = "isolated"
minimumReleaseAge = 604800 # 7 days
minimumReleaseAgeExcludes = [
  "@botlake/core",
  "@botlake/extension-batteries",
]
`

func initWorkspace(args []string) int {
	fail := func(err error) int { return cliFailure(err, false) }
	if len(args) == 1 && args[0] == "help" {
		return writeHelp(initUsage)
	}
	flags := flag.NewFlagSet("botlake init", flag.ContinueOnError)
	flags.SetOutput(io.Discard)

	target := flags.String("workspace", "", "workspace directory (overrides BL_WORKSPACE)")
	name := flags.String("name", "", "published workspace name (defaults to directory basename)")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return writeHelp(initUsage)
		}

		return fail(err)
	}

	if flags.NArg() == 1 && flags.Arg(0) == "help" {
		return writeHelp(initUsage)
	}
	if flags.NArg() != 0 {
		return fail(errors.New("usage: botlake init [--workspace DIR] [--name NAME]"))
	}

	var path string
	var err error
	if *target == "" {
		path, err = defaultWorkspace("")
	} else {
		path = *target
	}

	if err != nil {
		return fail(err)
	}
	path, err = canonical(path)
	if err != nil {
		return fail(err)
	}

	rootFiles := map[string]bool{}
	for _, name := range []string{"bun.lock", "bunfig.toml"} {
		_, err := os.Stat(filepath.Join(path, name))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return fail(err)
		}
		rootFiles[name] = err == nil
	}
	if _, err := io.WriteString(os.Stderr, initBunGuidance(rootFiles["bun.lock"], rootFiles["bunfig.toml"])+"\n"); err != nil {
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

	lakePath := filepath.Join(path, ".botlake", "lake.ts")
	if _, statErr := os.Stat(lakePath); statErr == nil {
		if *name != "" {
			return fail(errors.New("workspace already exists; edit .botlake/lake.ts to change its name"))
		}
		encode(os.Stdout, map[string]any{"workspace": path, "name": filepath.Base(path), "created": false})
		return 0
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fail(statErr)
	}

	publishedName := *name
	if publishedName == "" {
		publishedName = filepath.Base(path)
	}

	if !workspaceName.MatchString(publishedName) {
		return fail(errors.New("invalid workspace name; pass --name starting with a letter, followed by letters, digits, underscores or hyphens"))
	}

	dependencies := map[string]string{}
	if raw, exists := manifest["dependencies"]; exists {
		if err := json.Unmarshal(raw, &dependencies); err != nil {
			return fail(err)
		}
		if dependencies == nil {
			return fail(errors.New("package dependencies must be an object"))
		}
	}
	for _, name := range []string{"@botlake/core", "@botlake/extension-batteries"} {
		if _, exists := dependencies[name]; !exists {
			dependencies[name] = "latest"
		}
	}
	manifest["dependencies"], err = json.Marshal(dependencies)
	if err != nil {
		return fail(err)
	}

	filePath := filepath.Join(path, ".botlake", "package.json")
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return fail(err)
	}

	ignorePath := filepath.Join(path, ".botlake", ".gitignore")
	ignore, err := os.ReadFile(ignorePath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	content := string(ignore)
	for _, pattern := range []string{"/node_modules/", "/world.db*"} {
		found := false
		for line := range strings.SplitSeq(content, "\n") {
			if strings.TrimSpace(line) == pattern {
				found = true
				break
			}
		}
		if !found {
			if content != "" && !strings.HasSuffix(content, "\n") {
				content += "\n"
			}
			content += pattern + "\n"
		}
	}
	if err := os.WriteFile(ignorePath, []byte(content), 0644); err != nil {
		return fail(err)
	}

	bunfig, err := os.OpenFile(filepath.Join(path, ".botlake", "bunfig.toml"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil && !errors.Is(err, os.ErrExist) {
		return fail(err)
	}
	if err == nil {
		_, writeErr := io.WriteString(bunfig, initBunfig)
		if err := errors.Join(writeErr, bunfig.Close()); err != nil {
			return fail(err)
		}
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

	lakeSource := "import { createLake } from \"@botlake/core\";\nimport { batteries } from \"@botlake/extension-batteries\";\n\nexport const lake = createLake({"
	if *name != "" {
		lakeSource += " name: " + fmt.Sprintf("%q", publishedName) + ","
	}
	lakeSource += " extensions: [batteries()] });\n"
	if err := os.WriteFile(lakePath, []byte(lakeSource), 0644); err != nil {
		return fail(err)
	}

	if !rootFiles["bun.lock"] {
		if err := installInitializedWorkspace(path, os.Stderr); err != nil {
			return fail(err)
		}
	}

	encode(os.Stdout, map[string]any{"workspace": path, "name": publishedName, "created": true})

	return 0
}

func installInitializedWorkspace(workspace string, output io.Writer) error {
	cmd := exec.Command("bun", "install", "--frozen-lockfile")
	cmd.Dir = filepath.Join(workspace, ".botlake")
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("workspace configuration created, but bun install --frozen-lockfile in %s failed: %w; fix the install error and rerun that command in .botlake", cmd.Dir, err)
	}
	return nil
}

func initBunGuidance(lockfile, bunfig bool) string {
	switch {
	case lockfile && bunfig:
		return "Root bun.lock and bunfig.toml found. Skipping installation: run bun install --frozen-lockfile in .botlake yourself, or add .botlake to the root package.json workspaces and run bun install from the root. Extend the root bunfig.toml install policy as needed."
	case lockfile:
		return "Root bun.lock found. Skipping installation: run bun install --frozen-lockfile in .botlake yourself, or add .botlake to the root package.json workspaces and run bun install from the root. No root bunfig.toml found; consider adding one to configure repository-wide installs."
	case bunfig:
		return "No root bun.lock found; root bunfig.toml found. Extend its install policy as needed."
	default:
		return "No root bun.lock and no root bunfig.toml found."
	}
}
