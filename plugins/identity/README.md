# @botlake/identity

Native identity adapters for Codex, Pi and Claude. This is the client plugin package, not the `@botlake/extension-identity` server extension.

Pi uses the package's `pi.extensions` entry or `@botlake/identity/pi`. Codex and Claude use the included `.codex-plugin` and `.claude-plugin` manifests. Hooks call `bl`; set `BOTLAKE_BL_BIN` when it is not on `PATH`. Installation into a native harness is explicit, never performed by core or extension activation.

The target workspace must select Identity, Flags and Harnesses. Direct sessions register identity/provenance without process ownership; managed callbacks bind to the current run invocation.
