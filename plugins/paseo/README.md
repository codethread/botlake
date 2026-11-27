# Botlake Identity for Paseo

See an agent’s registered Botlake name beside its message box on mobile or desktop. Tap the fingerprint pill to see the full, selectable name in a bottom sheet on mobile or a popover on desktop. If there’s no name yet, tap to check again. It does not rename the chat, set an identity, or read the conversation.

Install once on the Paseo daemon machine, from the root of this checkout:

```sh
paseo plugin install "$PWD/plugins/paseo"
paseo plugin ls botlake-identity
```

Connect your client to that daemon and open an existing agent chat. The pill is in the composer row beside Tasks and Subagents, not in the workspace list or a new-chat draft. If the app was already open, reconnect it. After editing the plugin, run `paseo plugin reload botlake-identity`.

The daemon needs `bl` on its PATH and a running lake with Identity and Batteries for the agent’s Git checkout. Linked worktrees use the main checkout’s lake. The plugin matches the provider and native session ID from Paseo’s persistence handle against registered Botlake sessions. A name is attribution, not evidence that the agent is running.

- **No session:** Paseo hasn’t supplied a native session handle yet.
- **Not registered:** The lake is reachable, but no identity matches. Check that the native Botlake identity adapter is active for that provider.
- **Unavailable:** The lookup failed. Check the lake and `bl` on the daemon host, then tap to retry.

Disable with `paseo plugin disable botlake-identity`.
