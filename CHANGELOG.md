# CHANGELOG

All notable changes to this project should be documented in this file.

## v1.0.9 - 2026-06-30

### Added
- Added the in-repo `skills/clawfetch` wrapper for OpenClaw / ClawHub distribution.
- Added English and Chinese skill wrapper documentation for first-use installation and runtime lifecycle.

### Changed
- Aligned the project version, skill wrapper version, and bootstrap fallback version to `1.0.9`.
- Clarified that first-time setup requires two separate stages: installing the published npm CLI and installing the CLI-managed browser runtime.
- Clarified that browser runtime location and lifecycle are owned by the `clawfetch` CLI, not by the skill wrapper.

### Fixed
- Fixed skill bootstrap so `clawfetch` component dependencies are initialized inside `node_modules/clawfetch`, matching the CLI runtime boundary checks.
- Added bootstrap validation for the expected CLI entry file and the component-local `playwright-core` dependency.
- Restored executable permission for `skills/clawfetch/bootstrap_deps.sh`.
- Fixed the ClawHub installation path so `runtime install` and `runtime check` can succeed after bootstrap.

### Notes
- `openclaw skills install clawfetch` installs the wrapper only; first use still requires running the bootstrap script and then `clawfetch runtime install`.
