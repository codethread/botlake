# Mail notifications

Announces new [identity mail](../../extensions/mail/README.md) after tool calls in Claude Code, Codex and Pi. Claude Code and Codex also announce waiting mail at startup. Antigravity CLI announces waiting mail at session start and before model invocations, not while idle. Install once globally.

```sh
mise run plugins   # builds out/plugins; rerun after updating Botlake
claude plugin marketplace add "$PWD/out/plugins" && claude plugin install botlake-mail@botlake
codex plugin marketplace add "$PWD/out/plugins" && codex plugin add botlake-mail@botlake
```

```json
// ~/.pi/agent/settings.json
{ "packages": [{ "source": "/path/to/botlake/out/plugins/botlake-mail" }] }
```

For Antigravity CLI, install either or both built directories directly (no marketplace registration):

```sh
mise run plugins
agy plugin install "$PWD/out/plugins/botlake-identity"
agy plugin install "$PWD/out/plugins/botlake-mail"
agy plugin list
```

To verify with the real CLI, run `agy plugin validate` on each directory, start a fresh `agy` conversation in a lake, and inspect `/hooks`. Send mail to that conversation’s Botlake identity from another session, then submit a prompt. The next invocation should see the sender and subject; the message should be delivered, not acknowledged. The integration follows Google's [plugin](https://antigravity.google/docs/build-plugins/) and [hook](https://antigravity.google/docs/hooks/) docs; live CLI verification is pending.

Needs Bun and `bl` on `PATH` (`BL_BIN` overrides). Codex asks to trust the hooks via `/hooks`. Don't also load the adapter per run (`pi -e`, `codex --config hooks.*`): it would run twice. Sessions outside a lake that selects Mail stay silent.

## Mail at an idle prompt

Leave the Claude Code or Pi terminal open. Every five seconds while idle, the plugin checks for unannounced mail. A nonempty batch starts one turn in the same session, with sender and subject summaries and the inbox command. Empty checks do not call the model. Delivery records the handoff to the session; it does not acknowledge the mail.

Claude Code shows the turn as a prompt from the botlake-mail plugin. Claude runs the idle check from the plugin’s hooks module (`claude.ts`), an early-access Claude Code API verified on 2.1.327.

To try it, let the session finish a turn. From another session in the same lake, send mail to its Botlake identity and leave its prompt untouched:

```sh
bl --identity sender mail send RECIPIENT 'Review ready' 'Please check the revised patch.'
```

There is no idle-age cutoff. A turn can still run after the provider’s prompt cache expires, at the cost of processing uncached input. Headless sessions (`claude -p`, `pi -p`, managed runs) do not start turns this way. Once the terminal closes, the plugin stops; resuming a stopped managed run is a separate [Mail–Agents policy](../../extensions/mail-agents/README.md).
