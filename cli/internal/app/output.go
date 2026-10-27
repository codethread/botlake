package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/term"
)

type presentation struct {
	json bool
	tier string
	path []string
}

func isDiscovery(name string) bool {
	return name == "help" || name == "about" || name == "prime" || name == "primer"
}

func terminalWidth(file *os.File) int {
	width, _, err := term.GetSize(int(file.Fd()))
	if err != nil || width < 1 {
		return 80
	}
	return width
}

func cliFailure(err error, forceJSON bool) int {
	raw, _ := json.Marshal(map[string]any{"type": "local", "code": "cli", "message": err.Error(), "details": nil})
	return renderError(raw, forceJSON)
}

func renderError(raw json.RawMessage, forceJSON bool) int {
	mode := os.Getenv("BOTLAKE_ERROR_FORMAT")
	if forceJSON || mode == "json" {
		fmt.Fprintln(os.Stderr, string(raw))
		return 1
	}
	var failure struct {
		Code, Message string
		Details       json.RawMessage
	}
	if err := json.Unmarshal(raw, &failure); err != nil {
		fmt.Fprintln(os.Stderr, string(raw))
		return 1
	}
	pretty := mode == "pretty" || (mode == "" && term.IsTerminal(int(os.Stderr.Fd())))
	prefix := "error"
	if failure.Code != "" {
		prefix += " [" + failure.Code + "]"
	}
	_, noColor := os.LookupEnv("NO_COLOR")
	if pretty && !noColor && term.IsTerminal(int(os.Stderr.Fd())) {
		prefix = "\x1b[1;31m" + prefix + "\x1b[0m"
	}
	fmt.Fprintf(os.Stderr, "%s: %s\n", prefix, failure.Message)
	if len(failure.Details) > 0 && string(failure.Details) != "null" {
		var out bytes.Buffer
		if pretty && json.Indent(&out, failure.Details, "  ", "  ") == nil {
			fmt.Fprintln(os.Stderr, "  "+out.String())
		} else {
			fmt.Fprintln(os.Stderr, string(failure.Details))
		}
	}
	return 1
}

func Relay(req Request) int { return relay(req, presentation{}) }

func relay(req Request, view presentation) int {
	if req.Operation != "invoke" {
		var output bytes.Buffer
		if err := Dial(req, &output); err != nil {
			return cliFailure(err, view.json)
		}
		var frame struct {
			OK     bool            `json:"ok"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(output.Bytes(), &frame); err != nil {
			return cliFailure(err, view.json)
		}
		if !frame.OK {
			return renderError(frame.Error, view.json)
		}
		return renderResult(frame.Result, view)
	}
	conn, err := net.DialTimeout("unix", socket(), time.Second)
	if err != nil {
		return cliFailure(fmt.Errorf("Botlake is unreachable; run botlake start: %w", err), view.json)
	}
	defer conn.Close()
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return cliFailure(err, view.json)
	}
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 16*1024*1024)
	stream := false
	for scanner.Scan() {
		line := scanner.Bytes()
		if !json.Valid(line) {
			return cliFailure(fmt.Errorf("malformed JSON response"), view.json)
		}
		var frame map[string]json.RawMessage
		objectErr := json.Unmarshal(line, &frame)
		if !stream {
			if objectErr != nil {
				return cliFailure(objectErr, view.json)
			}
			if bytes.Equal(frame["stream"], []byte("true")) {
				stream = true
				continue
			}
			if bytes.Equal(frame["ok"], []byte("true")) {
				return renderResult(frame["result"], view)
			}
			return renderError(frame["error"], view.json)
		}
		if bytes.Equal(frame["done"], []byte("true")) && string(frame["request_id"]) == fmt.Sprintf("%q", req.ID) {
			if bytes.Equal(frame["success"], []byte("true")) {
				return 0
			}
			return renderError(frame["error"], view.json)
		}
		if _, err := fmt.Fprintln(os.Stdout, string(line)); err != nil {
			return cliFailure(err, view.json)
		}
	}
	if err := scanner.Err(); err != nil {
		return cliFailure(err, view.json)
	}
	return cliFailure(fmt.Errorf("response ended without a terminal frame"), view.json)
}

func renderResult(raw json.RawMessage, view presentation) int {
	if !json.Valid(raw) {
		return cliFailure(fmt.Errorf("malformed result"), view.json)
	}
	if view.json || !term.IsTerminal(int(os.Stdout.Fd())) {
		fmt.Fprintln(os.Stdout, string(raw))
		return 0
	}
	if view.tier != "" {
		if err := renderDiscovery(raw, view); err != nil {
			return cliFailure(err, view.json)
		}
		return 0
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		fmt.Fprintln(os.Stdout, text)
		return 0
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, raw, "", "  "); err != nil {
		return cliFailure(err, view.json)
	}
	fmt.Fprintln(os.Stdout, pretty.String())
	return 0
}

type helpArgument struct {
	Name, Key, Type, Description string
	Required, Multiple           bool
}
type helpCommand struct {
	Description string
	Flags       map[string]helpArgument
	Positionals []helpArgument
	Commands    map[string]helpCommand
	Examples    []string
}
type helpOperation struct {
	Name, About, Primer string
	Stream              bool
	CLI                 helpCommand
	JSONSchema          json.RawMessage
}
type helpPrinter struct {
	width int
	color bool
}

func (p helpPrinter) heading(title string) {
	if p.color {
		title = "\x1b[1;36m" + title + "\x1b[0m"
	}
	fmt.Fprintln(os.Stdout, title)
}

func (p helpPrinter) body(text, indent string) {
	width := max(1, p.width-utf8.RuneCountInString(indent))
	for _, paragraph := range strings.Split(text, "\n") {
		line := ""
		for _, word := range strings.Fields(paragraph) {
			if line != "" && utf8.RuneCountInString(line)+1+utf8.RuneCountInString(word) > width {
				fmt.Fprintln(os.Stdout, indent+line)
				line = ""
			}
			if line != "" {
				line += " "
			}
			line += word
		}
		fmt.Fprintln(os.Stdout, indent+line)
	}
}

func (p helpPrinter) row(label, description string) {
	labelWidth := min(28, max(12, p.width/3))
	if utf8.RuneCountInString(label) >= labelWidth || p.width < 45 {
		p.body(label, "  ")
		if description != "" {
			p.body(description, "    ")
		}
		return
	}
	prefix := "  " + label + strings.Repeat(" ", labelWidth-utf8.RuneCountInString(label)) + "  "
	words := strings.Fields(description)
	line := prefix
	for _, word := range words {
		if utf8.RuneCountInString(line)+utf8.RuneCountInString(word) > p.width && line != prefix {
			fmt.Fprintln(os.Stdout, strings.TrimRight(line, " "))
			line = strings.Repeat(" ", labelWidth+4)
		}
		line += word + " "
	}
	fmt.Fprintln(os.Stdout, strings.TrimRight(line, " "))
}

func renderDiscovery(raw json.RawMessage, view presentation) error {
	var operations []helpOperation
	if err := json.Unmarshal(raw, &operations); err != nil {
		return fmt.Errorf("invalid discovery response: %w", err)
	}
	_, noColor := os.LookupEnv("NO_COLOR")
	p := helpPrinter{width: terminalWidth(os.Stdout), color: !noColor && os.Getenv("TERM") != "dumb"}
	if len(view.path) == 0 {
		p.heading("Workspace operations")
		if len(operations) == 0 {
			p.body("No operations are registered. Select extensions in .botlake/package.json (botlake.extensions).", "  ")
		}
		sort.Slice(operations, func(i, j int) bool { return operations[i].Name < operations[j].Name })
		for _, op := range operations {
			p.row(op.Name, op.CLI.Description)
		}
		fmt.Fprintln(os.Stdout)
		p.body("Use bl help OP for arguments, bl prime OP for a runbook, or bl about OP for details.", "")
		return nil
	}
	for _, op := range operations {
		command := "bl " + strings.Join(view.path, " ")
		p.heading(command)
		p.body(op.CLI.Description, "")
		fmt.Fprintln(os.Stdout)
		p.heading("Usage")
		usage := command
		if len(op.CLI.Commands) > 0 {
			usage += " <subcommand>"
		}
		for _, arg := range op.CLI.Positionals {
			label := arg.Name
			if arg.Multiple {
				label += "..."
			}
			if arg.Required {
				usage += " <" + label + ">"
			} else {
				usage += " [" + label + "]"
			}
		}
		if len(op.CLI.Flags) > 0 {
			usage += " [flags]"
		}
		p.body(usage, "  ")
		if len(op.CLI.Commands) > 0 {
			fmt.Fprintln(os.Stdout)
			p.heading("Subcommands")
			for _, name := range sortedKeys(op.CLI.Commands) {
				p.row(name, op.CLI.Commands[name].Description)
			}
		}
		if len(op.CLI.Positionals) > 0 {
			fmt.Fprintln(os.Stdout)
			p.heading("Arguments")
			for _, arg := range op.CLI.Positionals {
				p.row(arg.Name, argumentDescription(arg))
			}
		}
		if len(op.CLI.Flags) > 0 {
			fmt.Fprintln(os.Stdout)
			p.heading("Flags")
			for _, name := range sortedKeys(op.CLI.Flags) {
				arg := op.CLI.Flags[name]
				label := "--" + name
				if arg.Type != "boolean" {
					label += " <" + arg.Type + ">"
				}
				p.row(label, argumentDescription(arg))
			}
		}
		if len(op.CLI.Examples) > 0 {
			fmt.Fprintln(os.Stdout)
			p.heading("Examples")
			for _, example := range op.CLI.Examples {
				p.body(example, "  ")
			}
		}
		if view.tier != "help" && op.About != "" {
			fmt.Fprintln(os.Stdout)
			p.heading("About")
			p.body(op.About, "")
		}
		if (view.tier == "prime" || view.tier == "primer") && op.Primer != "" {
			fmt.Fprintln(os.Stdout)
			p.heading("Runbook")
			p.body(op.Primer, "")
		}
		if op.Stream {
			fmt.Fprintln(os.Stdout)
			p.body("Streams one validated JSON value per line.", "")
		}
		fmt.Fprintln(os.Stdout)
		p.body("Use --json before the operation for machine-readable output. Use bl --help for stdin, payload and other global flags.", "")
	}
	return nil
}

func argumentDescription(arg helpArgument) string {
	parts := []string{arg.Type}
	if arg.Required {
		parts = append(parts, "required")
	}
	if arg.Multiple {
		parts = append(parts, "repeatable")
	}
	text := strings.Join(parts, ", ")
	if arg.Description != "" {
		text += ". " + arg.Description
	}
	return text
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
