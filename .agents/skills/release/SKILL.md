---
name: release
description: Use when packing, publishing or verifying Botlake runtime packages on npm.
---

# Release Botlake runtime packages

Release only core, native-session and the lake extensions under `extensions/`, excluding `ct-config`. The root, `.botlake` dogfood package, `ct-config` and `plugins/identity` are private. The identity plugin is harness-side: Claude/Codex discover its manifests through `.agents/plugins/marketplace.json`, while Pi loads `pi.ts` explicitly from that installed local plugin source.

1. Choose one version for the public set, update each public manifest directly, install the lockfile, and run the repository checks. Confirm `npm whoami` has `@botlake` publish access.
2. Pack the exact candidate with Bun:

   ```sh
   rm -rf dist/release && mkdir -p dist/release
   for package in packages/core packages/native-session extensions/agents extensions/batteries extensions/cron extensions/diary extensions/flags extensions/identity extensions/references extensions/work extensions/work-agents extensions/work-auto-bot extensions/workflow; do
     (cd "$package" && bun pm pack --destination "$OLDPWD/dist/release" --ignore-scripts)
   done
   bun scripts/verify-release.ts --packed
   ```

   The verifier checks the complete scope, MIT metadata/text, core NOTICE, source/README/assets, fresh-cache installation, installed imports and disposable SQLite operation through a private supervisor with `BL_CORE` set to the installed core.

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

## Pack the private shared configuration

`extensions/ct-config` is packaged like the runtime packages but remains private and unpublished. Its canonical source stays in that directory; never generate or copy configuration into consumer repositories.

```sh
rm -rf dist/private && mkdir -p dist/private
(cd extensions/ct-config && bun pm pack --destination ../../dist/private --ignore-scripts)
bun scripts/verify-private-config.ts
```

Keep `private: true`, omit `publishConfig`, include `src`, `README.md` and `LICENSE`, and use `workspace:^` for Botlake peers in the source manifest. Bun must rewrite those protocols to public semver ranges in the packed manifest. Freeze the versioned archive under `dist/private/` in the canonical checkout, record its SHA-512 integrity, and install it in consumers as a file dependency alongside public npm peers. Do not publish it or add wrapper tasks; consumer wrapper modules only import the configured exports from `ct-config`.
