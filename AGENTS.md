## Tech stack

- Bun typescript project using oxfmt and oxlint.
- Write unit tests to help shape and validate, delete once finished.
- Write blackbox tests to verify the system as a user would.

## Package seam

- Core runs lakes; extensions own domains, configuration and assets. Core stays extension-independent.
- Cross-package imports use declared dependencies and public exports; relative imports stay within a package. Preserve Oxlint's `no-restricted-imports` boundary.
- Extension imports stay inert. Consumers explicitly select extensions and prerequisites; installation never activates them.

## Development cycle

1. build (make it work)
2. refactor (remove cruft, needless code, improve readability, minimise abstractions)
3. smoke test against a real disposable db (you can may build up seeding scripts in VCS to help, keep them well documented)
4. fix -> back to `1` as needed
5. delete tests
6. align and prune docs

## Doc guidance

- best docs are no docs, build on good DDD with well structured modules and folders.
- where needed, apply a very terse level of connective docs in ./docs/
