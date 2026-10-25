# millstrand-ts

A Bun TypeScript project without React or UI dependencies.

## Run

Install [Bun](https://bun.com), then run:

```sh
bun install
bun start
```

Use `bun dev` to restart automatically when files change.

## Checks

```sh
bun run check        # TypeScript, lint, and formatting checks
bun run typecheck    # Strict TypeScript checks
bun run lint         # Type-aware Oxlint; warnings fail
bun run lint:fix     # Apply safe lint fixes
bun run format      # Format code, configuration, and Markdown
bun run format:check
```

TypeScript enables all `strict` checks plus exact optional properties, checked indexed access, unused-symbol checks, and explicit return-path checks. Oxlint enables correctness, suspicious, pedantic, and performance rules as errors, with additional strict TypeScript rules for unsafe types, assertions, promises, boolean conditions, and exhaustive switches. React and UI plugins are not enabled.

Oxfmt enforces consistent formatting and import ordering. Markdown is included with `proseWrap: "never"`, keeping each prose paragraph on a single line.

`bun install` prepares Husky's Git hooks. Before each commit, lint-staged fixes and formats staged code, formats staged configuration and Markdown, and then the hook type-checks the whole project. Fixed files are automatically re-staged. Run `bun run check` for the full-project checks.
