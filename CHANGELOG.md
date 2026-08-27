# Changelog

All notable work on **HYDRA-UMC-OPCUA-SERVER** is summarized here, newest first. Full
session-by-session detail (including dates) lives in a private,
unpublished internal log - this file is public, so it intentionally
omits calendar dates.

## Versioning scheme

`scripts/bump-version.mjs` bumps `package.json`'s `version` field
automatically as the first step of every real `npm run build` (same
mechanism HYDRA-UMC-SERVER/HYDRA-UMC-STUDIO already use) - no manual
version edits, no build that silently ships under the previous number.

It follows the ecosystem-wide base-10 "odometer" rule rather than
semantic-versioning judgment calls:

- `PATCH` +1 on every build
- when `PATCH` would exceed 9, it resets to 0 and `MINOR` +1 instead (e.g. `0.0.9` -> `0.1.0`, never `0.0.10`)
- the same carry cascades into `MAJOR` if `MINOR` would exceed 9

---

## [0.0.2] - Real, protocol-level test coverage

- **`tests/server.test.ts`** - 4 real tests connecting a real `OPCUAClient` (node-opcua's own client, the same library UAExpert/Ignition would use) against a real `OPCUAServer` over the real OPC-UA binary protocol on a real TCP port: a session actually opens, `SwarmOnline`/`ActiveRobotCount` are browsed by path and read back with real values, a mutation made directly on server-side state is observed through a real read, and a real client-issued write is confirmed both in the read-back value and in server-side state.
- **`src/server.ts`** refactored: address space construction now lives in an exported `buildAddressSpaceServer(port)` so tests (and any future embedder) can start a real server on a test port without going through `main()`'s `process.env.PORT` default.
- **`src/version.ts`** - the OPC-UA server's `buildInfo.buildNumber` now reads `package.json`'s real, current version at runtime instead of the hardcoded `"1"` placeholder.
- **`build.sh`/`build.bat`** - now run the real test suite (`npm test`, vitest) as a required step before compiling; a failing test fails the build.

## [0.0.1] - Automatic version bump on build

- Added `scripts/bump-version.mjs` (copied/adapted from HYDRA-UMC-SERVER's
  own) and wired it into `package.json`'s `build` script - this project
  no longer relies on a manual version edit before each real build, like
  every other Node project in the ecosystem.

## [0.0.0] - Initial scaffolding

- **`src/server.ts`** - minimal real entry point. No OPC-UA server logic yet - exposing this cell's own robot/controller state as a real OPC-UA address space lands in a later pass.
- **`package.json`** - project metadata, no runtime dependencies yet.
- **`build.sh` / `build.bat`** - `npm install && npm run build`.
- **`dev.sh` / `dev.bat`** - run against source directly (no build step) for local development.
