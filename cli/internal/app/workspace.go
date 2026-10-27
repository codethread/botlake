package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var workspaceName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]*$`)

func readWorkspacePackage(path string) (map[string]json.RawMessage, error) {
	raw, err := os.ReadFile(filepath.Join(path, ".botlake", "package.json"))
	if err != nil {
		return nil, err
	}
	var manifest map[string]json.RawMessage
	if err := decode(raw, &manifest); err != nil {
		return nil, err
	}
	if manifest == nil {
		return nil, errors.New(".botlake/package.json must be an object")
	}
	return manifest, nil
}

func readMember(path string) (Member, error) {
	manifest, err := readWorkspacePackage(path)
	if err != nil {
		return Member{}, err
	}
	raw, ok := manifest["botlake"]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return Member{}, errors.New(".botlake/package.json must contain a botlake object")
	}
	var config struct {
		Name   json.RawMessage `json:"name"`
		Spools []string        `json:"spools"`
	}
	if err := decode(raw, &config); err != nil {
		return Member{}, fmt.Errorf(".botlake/package.json botlake: %w", err)
	}
	name := filepath.Base(path)
	if config.Name != nil {
		if err := json.Unmarshal(config.Name, &name); err != nil {
			return Member{}, err
		}
		if bytes.Equal(bytes.TrimSpace(config.Name), []byte("null")) {
			return Member{}, errors.New("botlake.name must be a string")
		}
	}
	if !workspaceName.MatchString(name) {
		return Member{}, fmt.Errorf("invalid workspace name %q; set botlake.name in .botlake/package.json to a letter followed by letters, digits, underscores or hyphens", name)
	}
	return Member{Path: path, Name: name}, nil
}

func defaultWorkspace(cwd string) (string, error) {
	_, common, err := gitContext(cwd)
	if err != nil {
		return "", err
	}
	return workspaceFromCommonDir(common)
}

// Linked worktrees share the main checkout's configuration, not their own copy.
func workspaceFromCommonDir(common string) (string, error) {
	if filepath.Base(common) != ".git" {
		return "", fmt.Errorf("unsupported Git layout: common Git directory must be a repository .git directory, got %s; pass --workspace", common)
	}
	return filepath.Dir(common), nil
}

// Read .git and commondir directly; no Git process is needed for routing.
func gitContext(cwd string) (worktree, common string, err error) {
	if cwd == "" {
		cwd = "."
	}
	worktree, err = canonical(cwd)
	if err != nil {
		return "", "", err
	}
	var marker string
	for {
		if filepath.Base(worktree) == ".git" {
			return "", "", errors.New("cwd is inside Git metadata, not a worktree; pass --workspace")
		}
		marker = filepath.Join(worktree, ".git")
		if _, err := os.Lstat(marker); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", "", err
		}
		parent := filepath.Dir(worktree)
		if parent == worktree {
			return "", "", errors.New("no Git worktree found; run git init or pass --workspace")
		}
		worktree = parent
	}
	info, err := os.Stat(marker)
	if err != nil {
		return "", "", err
	}
	gitdir := marker
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return "", "", fmt.Errorf("invalid Git marker %s: expected directory or gitdir file", marker)
		}
		gitdir, err = readGitPath(marker, "gitdir: ")
		if err != nil {
			return "", "", err
		}
	}
	gitdir, err = canonical(gitdir)
	if err != nil {
		return "", "", err
	}
	if _, err := os.Stat(filepath.Join(gitdir, "HEAD")); err != nil {
		return "", "", err
	}
	common, err = readGitPath(filepath.Join(gitdir, "commondir"), "")
	if errors.Is(err, os.ErrNotExist) {
		return worktree, gitdir, nil
	}
	if err != nil {
		return "", "", err
	}
	info, err = os.Stat(common)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("Git common directory is not a directory: %s", common)
	}
	common, err = canonical(common)
	if err != nil {
		return "", "", err
	}
	return worktree, common, nil
}

// Relative metadata paths are resolved from the file containing them.
func readGitPath(file, prefix string) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	path, ok := strings.CutPrefix(strings.TrimRight(string(data), "\r\n"), prefix)
	if !ok || path == "" {
		return "", fmt.Errorf("invalid Git path in %s", file)
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(filepath.Dir(file), path)
	}
	return path, nil
}
