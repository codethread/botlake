# Botlake Mail for Paseo

Wake an idle Paseo agent when it receives Botlake mail. This daemon-only plugin can start a paid model turn even when every phone or desktop client is disconnected. Installing the [identity pill](../paseo/README.md) alone does not enable it.

From a Botlake checkout on the daemon machine:

```sh
bun install --frozen-lockfile
paseo plugin install "$PWD/plugins/paseo-mail"
paseo plugin ls botlake-mail
```

Use a Git checkout with a running lake that selects Batteries, Identity and Mail, and a provider integration that registers native sessions. The daemon needs `bl` and `git` on its PATH. There’s no mobile install or inbox UI.

After installation or reload, let the agent **finish one turn**. A completed turn in a top-level, non-background chat arms a wait in that checkout’s lake. Previously idle chats aren’t enrolled retroactively. Waiting uses one `bl mail wait` process per idle chat and no model tokens.

Send a message to the agent’s registered identity in the same lake. The plugin sends a sender/subject summary and an inbox command into the existing chat, then reports delivery. It does not inject bodies, acknowledge mail, create another session, or resume closed agents. During turns, the native mail adapters can still announce mail after tools.

If delivery doesn’t start, check `paseo plugin logs botlake-mail` and the lake. A failed watcher can be rearmed by finishing another turn. Disable automatic turns with `paseo plugin disable botlake-mail`.
