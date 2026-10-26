# @millstrand/identity

Native identity adapters for Codex, Pi and Claude, ported from Millhouse. This is the client plugin package, not the `@millstrand/spool-identity` server spool.

Pi uses the package's `pi.extensions` entry or `@millstrand/identity/pi`. Codex and Claude use the included `.codex-plugin` and `.claude-plugin` manifests. Hooks call `strand`; set `MILLSTRAND_STRAND_BIN` when it is not on `PATH`. Installation into a native harness is explicit, never performed by core or spool activation.

The target workspace must select both Identity and Harnesses. Direct sessions register identity/provenance without process ownership; managed callbacks bind to the current run invocation.
