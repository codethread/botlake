# Release the Go CLIs

`botlake` and `bl` share the version in `cli/internal/app/invoke.go`. The supervisor is `botlake start`, not a third executable. CLI tags use `vVERSION`; npm Core and extension versions are independent.

1. Work on a release branch. Check existing tags and releases before choosing a version. Update the Go CLI version and curate `cli/changelog.json`, then run `bun run changelog:generate`.
2. Verify the candidate:

   ```sh
   bun run build:cli
   bun run check
   bun run check:go
   bun run test
   ```

   Blackbox tests use trimmed-path binaries, packed dependencies and disposable SQLite databases. Also build both commands from a source archive using `go build -trimpath`, then initialize, start, invoke, evaluate and restart a disposable lake without `BL_CORE` or a checkout on the runtime path. Keep the smoke supervisor isolated with a temporary `BL_HOME`; never restart the host supervisor to verify a release.

3. Commit, integrate and push the verified candidate. Create an annotated `vVERSION` tag at that exact commit, push the tag, and create the GitHub release with curated notes. A draft release may stay unpublished while verifying the formula.
4. Download the tagged source archive and calculate its checksum:

   ```sh
   version=0.2.0
   state=$(mktemp -d)
   curl -fL "https://github.com/codethread/botlake/archive/refs/tags/v${version}.tar.gz" \
     -o "$state/botlake.tar.gz"
   shasum -a 256 "$state/botlake.tar.gz"
   ```

5. Set `Formula/botlake.rb` to that exact URL and SHA-256. Keep Go build-only and Bun a runtime dependency. The formula must build both commands from `cli/` without installing the root Bun workspace. Check Ruby syntax and Homebrew style, run the formula's install recipe against the downloaded archive, and verify both commands report the tagged version. Verify the generated service runs `botlake start` with Bun on its `PATH`; do not start the host service.
6. Commit and push the formula update to the default branch, which is also the `codethread/botlake` tap. Publish the draft release if used. Never replace a published tag or archive to correct a release; publish a new version instead. Remove disposable smoke state after stopping its supervisor.

The formula update follows the tag because its checksum describes that tagged archive. Users install the formula from the tap's default branch, not from inside the release archive. See [installation](../../README.md#install-with-homebrew) for the public commands and explicit supervisor-restart guidance.
