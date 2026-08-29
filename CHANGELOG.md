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

## [0.0.4] - Real read/write authorization on SwarmOnline

- **`SwarmOnline`** (`src/server.ts`) - fixed a real gap found in a live
  ecosystem bug audit: this variable was still writable by ANY anonymous
  client, unlike `MaintenanceMode` (added in 0.0.3), which already had a
  real per-session `isUserWritable` check. Closed the same way - an
  anonymous session can read `SwarmOnline` but no longer write it; an
  authenticated session (existing `OPCUA_ADMIN_USERNAME`/
  `OPCUA_ADMIN_PASSWORD` credentials) can.
- `tests/server.test.ts`'s existing `SwarmOnline` write test inverted to
  assert the anonymous write is now correctly rejected and state stays
  unchanged (it previously asserted the opposite). Two new tests added to
  `tests/security.test.ts` mirroring `MaintenanceMode`'s own coverage:
  anonymous write denied with state unchanged, authenticated write
  succeeds and is reflected in state. 15 total tests, all passing.

## [0.0.3] - Real namespace versioning, stable NodeIds, quality/units/UTC, and read/write authorization

- **Real, explicit, versioned namespace URI** (`urn:hydra-umc:opcua-server:v1`, `src/server.ts`) - replaces node-opcua's implicit hostname-derived default, verified against the real `Server_NamespaceArray` a client actually reads. Same namespace index (1) as before, so nothing about existing browse-by-name paths changed.
- **Real, explicit string NodeIds** (`s=HydraNode_1`, `s=HydraNode_1.SwarmOnline`, etc.) instead of node-opcua's auto-assigned numeric ones - the promotion audit's own concern: adding a future DataItem can never silently renumber an existing one and change the path an industrial client depends on.
- **`SpindleTemp`** (new, real `AnalogItemType` DataItem) - a real, standard OPC-UA `EngineeringUnits` (`°C`) and `EURange`, plus a real `timestamped_get` returning an explicit `statusCode` and a `sourceTimestamp` that reflects when the value actually last changed (not when it was read) - real historian semantics, the audit's own "asociar unidad, calidad y timestamp a cada variable".
- **`MaintenanceMode`** (new) - a real, dynamic per-session write authorization via node-opcua's own `isUserWritable(context)` override: an anonymous session (the default, same as `SwarmOnline`'s existing unauthenticated write) can read but not write it; an authenticated session (new `userManager.isValidUser`, credentials from the new `OPCUA_ADMIN_USERNAME`/`OPCUA_ADMIN_PASSWORD` env vars - unset means no login is possible at all) can write it for real.
- 9 new tests (`tests/security.test.ts`) - a real `OPCUAClient` (anonymous and authenticated) against a real `OPCUAServer`: the real namespace URI, real stable NodeIds, real GOOD quality with a real UTC `sourceTimestamp` and a real `EngineeringUnits` child on `SpindleTemp`, an anonymous read/denied-write and an authenticated successful write on `MaintenanceMode`, and a wrong-password session rejected outright. 13 total, all passing.
- Real verification beyond the test suite: built `dist/server.cjs`, ran it for real with real env-var credentials, and connected a real client - confirmed the real denied-write status code (`BadWriteNotSupported`, discovered by running it, not assumed) versus the authenticated write's real `Good`.

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
