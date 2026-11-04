# Botlake

Botlake is a programmable lake of connected nodes. Each workspace lake owns a Bun worker, a SQLite database and explicitly selected extensions. `botlake` manages lakes and processes; `bl` invokes their structured operations.

Extend a lake with a TypeScript module exporting an `Extension`: register typed operations, queries, events and resources in `activate(ctx)`, then select the module and its prerequisites in `.botlake/package.json`. Installing or importing an extension does not activate it. Use `botlake lake info` to find selected extensions' source packages and README guides.

## Configuration

- [Workspace manifest and selection](usage.md#manifest-and-workspace-selection)
- [Packages and extension selection](usage.md#packages-and-extension-selection)
- [Configured local modules](usage.md#configured-local-modules)
- [Applying configuration](usage.md#applying-configuration)
- [Environment](usage.md#environment)
- [Zsh completion](usage.md#zsh-completion)

## Core

- [Graph, operations and extension API](../packages/core/README.md)
- [Extension authoring](../packages/core/README.md#extension-authoring)
- [JavaScript evaluation API](../packages/core/README.md#javascript-evaluation)
- [Native session protocol](../packages/native-session/README.md)
