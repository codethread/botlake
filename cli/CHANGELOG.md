# Changelog

All notable changes to Botlake CLI are documented in this file.

## 0.3.1 - 2026-11-13

### Added

- Report the core-owned lake wire version per lake (58c91a6)

  Each published lake reports lakeWireVersion beside coreVersion in status members, lake list, selected-lake status and lifecycle acknowledgements. The value comes from the validated runner handshake, not lake configuration. Top-level protocolVersion still describes CLI-supervisor requests. Startup wire mismatches report supervisor and lake versions before extension activation.

  - **Adoption (optional):** Upgrade both CLIs and explicitly restart the supervisor after active work finishes to see members\[\].lakeWireVersion. Runtime 0.4.0 independently removes minimumCore from lake configuration; remove that field before upgrading the runtime. Core requirements belong in package dependencies and extension peer dependencies.

## 0.3.0 - 2026-11-13

### Changed

- Report Core versions per lake in status (aca09fd)

  Each published lake member carries its own loaded coreVersion, including in lake list and lifecycle acknowledgements. botlake status reports botlakeVersion for the running Go supervisor instead of supervisorVersion, and no longer samples one lake for a top-level coreVersion.

  - **Breaking:** botlake status replaces supervisorVersion with botlakeVersion and removes its top-level coreVersion. Read members\[\].coreVersion for each lake instead.
  - **Adoption (required):** Update status consumers to read botlakeVersion and members\[\].coreVersion. Upgrade the CLI, then explicitly restart the supervisor after active work finishes and start your lakes again; the running supervisor retains its previous status schema until replaced.

## 0.2.0 - 2026-11-13

### Added

- First tagged Go CLI release (192c363)

  Install botlake and bl together through the codethread/botlake Homebrew tap. botlake manages the Go supervisor and lake lifecycle; bl routes structured operations to each lake's Bun runtime. Lake startup and JavaScript evaluation use the selected workspace's installed Core. The formula supports an explicitly started Homebrew service; installation does not start the supervisor or select extensions.

  - **Adoption (optional):** Tap https://github.com/codethread/botlake as codethread/botlake, then install codethread/botlake/botlake. Finish active work before explicitly restarting an existing supervisor; start its lakes again after replacement. Core and extensions remain lake-local dependencies.
