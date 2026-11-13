# Changelog

All notable changes to Botlake CLI are documented in this file.

## 0.2.0 - 2026-11-13

### Added

- First tagged Go CLI release (192c363)

  Install botlake and bl together through the codethread/botlake Homebrew tap. botlake manages the Go supervisor and lake lifecycle; bl routes structured operations to each lake's Bun runtime. Lake startup and JavaScript evaluation use the selected workspace's installed Core. The formula supports an explicitly started Homebrew service; installation does not start the supervisor or select extensions.

  - **Adoption (optional):** Tap https://github.com/codethread/botlake as codethread/botlake, then install codethread/botlake/botlake. Finish active work before explicitly restarting an existing supervisor; start its lakes again after replacement. Core and extensions remain lake-local dependencies.
