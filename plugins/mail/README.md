# Mail notifications

Tells Claude Code, Codex and Pi sessions about new [identity mail](../../extensions/mail/README.md) at startup and after each tool call. Install once globally; managed and direct sessions share it.

```sh
mise run plugins   # builds out/plugins; rerun after updating Botlake
claude plugin marketplace add "$PWD/out/plugins" && claude plugin install botlake-mail@botlake
codex plugin marketplace add "$PWD/out/plugins" && codex plugin add botlake-mail@botlake
```

```json
// ~/.pi/agent/settings.json
{ "packages": [{ "source": "/path/to/botlake/out/plugins/botlake-mail" }] }
```

Needs Bun and `bl` on `PATH` (`BL_BIN` overrides). Codex asks to trust the hooks via `/hooks`. Don't also load the adapter per run (`pi -e`, `codex --config hooks.*`): it would run twice. Sessions outside a lake that selects Mail stay silent.
