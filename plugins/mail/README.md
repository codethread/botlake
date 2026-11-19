# Mail notifications

Announces new [identity mail](../../extensions/mail/README.md) after tool calls in Claude Code, Codex and Pi. Claude Code and Codex also announce waiting mail at startup. Install once globally; managed and direct sessions share the plugin.

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

## Mail at an idle Pi prompt

Leave the Pi terminal open. Every five seconds while idle, the plugin checks for unannounced mail. A nonempty batch starts one turn in the same session, with sender and subject summaries and the inbox command. Empty checks do not call the model. Delivery records the handoff to Pi; it does not acknowledge the mail.

To try it, let Pi finish a turn. From another session in the same lake, send mail to Pi’s Botlake identity and leave its prompt untouched:

```sh
bl --identity sender mail send RECIPIENT 'Review ready' 'Please check the revised patch.'
```

There is no idle-age cutoff. A turn can still run after the provider’s prompt cache expires, at the cost of processing uncached input. Headless Pi sessions do not start turns this way. Once the terminal closes, the plugin stops; resuming a stopped managed run is a separate [Mail–Agents policy](../../extensions/mail-agents/README.md).
