---
name: release
description: Use when packing, publishing or verifying Botlake runtime packages on npm.
---

# Release Botlake runtime packages

Release core, native-session and the lake extensions under `extensions/`, including the shared `@botlake/extension-ct-config` preset. The root, `.botlake` lake package and the harness adapters under `plugins/` are private. The identity plugin is harness-side: Claude/Codex discover its manifests through `.agents/plugins/marketplace.json`, while Pi loads `pi.ts` explicitly from that installed local plugin source.

1. Choose one version for the public set, update each public manifest directly, install the lockfile, and run the repository checks. Confirm `npm whoami` has `@botlake` publish access.
2. Pack the exact candidate with Bun:

   ```sh
   rm -rf dist/release && mkdir -p dist/release
   for package in packages/core packages/native-session extensions/agents extensions/batteries extensions/cron extensions/ct-config extensions/diary extensions/flags extensions/identity extensions/mail extensions/mail-agents extensions/mail-identity extensions/references extensions/work extensions/work-agents extensions/work-auto-bot extensions/workflow; do
     (cd "$package" && bun pm pack --destination "$OLDPWD/dist/release" --ignore-scripts)
   done
   bun scripts/verify-release.ts --packed
   ```

   The verifier checks the complete scope, MIT metadata/text, core NOTICE, source/README/assets, fresh-cache installation, installed imports and disposable SQLite graph/Mail operations through a private supervisor with `BL_CORE` set to the installed core.

3. Commit and freeze the candidate. Record the commit and archive integrities emitted by the verifier.
4. Check npm before publishing:

   ```sh
   bun scripts/verify-release.ts
   ```

   A partial result lists every available and unavailable artifact together. Publish only an unavailable version with no previously recorded successful npm acceptance, using its exact archive filename:

   ```sh
   npm publish dist/release/ARCHIVE.tgz --registry https://registry.npmjs.org --access public --ignore-scripts
   ```

   Record each npm acceptance in the release task notes. Newly accepted versions can return 404 for several minutes; that is pending distribution, not permission to publish again. A tarball-stage 404 always means wait for distribution. Rerun published verification after each publication or approval window. Never publish an accepted or available version again; verification either confirms its integrity or fails on a mismatch. Published verification is complete only when the full set installs and passes the SQLite smoke.

The registry availability report is the resumable cutover checkpoint. A Botlake Workflow run would not observe npm's irreversible side effect more reliably, so this release does not add parallel workflow orchestration.
