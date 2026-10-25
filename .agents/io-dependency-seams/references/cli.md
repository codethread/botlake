# Subprocesses and CLIs

Wrap the first subprocess invocation in a named function with typed inputs and results. Start locally; a package or second adapter can wait for a concrete need.

Keep command construction, argument translation and output parsing inside the live adapter. Consumers call typed operations; the adapter maps them to the executable's commands and flags. Group related operations when the CLI's command structure makes call sites clearer.
