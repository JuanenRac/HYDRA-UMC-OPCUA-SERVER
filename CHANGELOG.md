# Changelog

All notable work on **HYDRA-UMC-OPCUA-SERVER** is summarized here, newest first.
This file intentionally omits calendar dates from individual entries.

## Versioning scheme

`package.json`'s `version` field bumps via `bump_manifest_version.py`
(bare invocation - single owner, no separate `--sync` step), run by
`build.bat`/`build.sh` BEFORE `npm run build` itself - no manual version
edits, no build that silently ships under the previous number.
`scripts/bump-version.mjs` is a legacy native-only helper kept for
reference; `npm run build` on its own is deliberately compilation-only
(same convention HYDRA-UMC-SERVER/HYDRA-UMC-STUDIO already use), it does
not call that script.

It follows the ecosystem-wide base-10 "odometer" rule rather than
semantic-versioning judgment calls:

- `PATCH` +1 on every build
- when `PATCH` would exceed 9, it resets to 0 and `MINOR` +1 instead (e.g. `0.0.9` -> `0.1.0`, never `0.0.10`)
- the same carry cascades into `MAJOR` if `MINOR` would exceed 9

---

## [0.1.1] - Honesty check section in every README

Added a "Honesty check" paragraph right after the badges in `README.md`
and all 6 translated READMEs, naming the real, tested `src/server.ts`
and the real test count (20 passing across 3 files, including real
protocol-level tests against a real `OPCUAClient` and a proof that
`SecurityPolicy.None` is genuinely refused by default). States plainly
which gaps are deliberately deferred, not accidental: the static
(not per-robot-dynamic) address-space tree, untested OPC-UA
subscriptions, and the unimplemented Pub/Sub roadmap item - pointing at
`mejoras_futuras.txt` for the complete list. Documents the real,
current state of what's implemented vs. planned; no behavior changed.

## [0.1.0] - REV-020: real test-timing regression found in a second review pass

A second review pass reproduced a real intermittent failure
in `tests/security-policy.test.ts` (19/20 pass, 1 times out; 20/20 on an
immediate retry, no code change):

- **REV-020 [P2]:** every test in that file does a real
  `buildAddressSpaceServer()` call - a genuine `OPCUAServer.initialize()`
  (including this host's own real, one-time self-signed certificate/key
  generation) and a real TLS security-policy handshake for the encrypted
  cases. Vitest's own generic default timeout (5000ms) intermittently
  wasn't enough real budget under CPU contention from this repo's other
  test files' own real servers starting around the same time. Fixed: a
  real, explicit, generous timeout (20s) for these specific real-server
  tests - the security assertions themselves are unchanged, still
  exactly as strict.
  **Honest limit, stated explicitly:** the deeper root cause (real
  readiness synchronization, profiling exactly which phase is slow under
  contention) is real, separate future work, not attempted here.

## [0.0.9] - DOC-26 follow-up: keep mejoras_futuras.txt discoverable and correct

- **Correction to the [0.0.8] entry below:** `mejoras_futuras.txt` is a
  real, tracked, public file in this repo, not a stray reference to a
  private one - the earlier description of it as "an internal planning
  file with no public equivalent" was inaccurate. The underlying fix
  still stands (every cross-reference required jumping elsewhere for a
  short reason that fits inline, so each site now states its own reason
  directly), but removing all of them left the file itself undiscoverable
  and its own header claiming references that no longer exist. Fixed:
  the header now describes the real, current state, and the file is
  listed in the README's own directory structure (all 7 languages).

## [0.0.8] - DOC-26: removed private-document references

- **DOC-26 (P2):**
  removed the 18 remaining references to `mejoras_futuras.txt` across
  `CHANGELOG.md`, `src/server.ts`, `tests/security.test.ts`, and README
  in all 7 languages. Where the reference pointed at a real, useful list
  (the README's own "deliberately deferred" note), that list is now
  stated in place instead of pointing at a document outside the section
  the reader is already in. `npm run typecheck` clean; `npm test` (20
  tests) all passing.

## [0.0.7] - SecurityPolicy.None was a real, exposed default - now it's genuinely refused

- Found while auditing the code: `buildAddressSpaceServer()`
  left `securityPolicies`/`securityModes` unset, so node-opcua fell back
  to its own defaults - which include `MessageSecurityMode.None`, and
  node-opcua always adds a real, unencrypted `SecurityPolicy.None`
  endpoint whenever `None` is present in `securityModes` at all,
  regardless of `securityPolicies`. Any client could connect fully
  unauthenticated and unencrypted despite this project's own "Encryption:
  Basic256Sha256" README claim - that claim was real but optional, never
  enforced.
- **`src/server.ts`** - now passes explicit `securityModes: [Sign,
  SignAndEncrypt]` (`None` excluded) and `securityPolicies:
  [Basic256Sha256, Aes128_Sha256_RsaOaep, Aes256_Sha256_RsaPss]`, still
  using node-opcua's own auto-generated self-signed certificate (no new
  cert-management burden). New `OPCUA_ALLOW_INSECURE=1` env var: a real,
  explicit, off-by-default escape hatch for local development against a
  client that cannot yet manage a certificate exchange - logs a loud
  warning whenever it's active, never silently enabled.
- **`tests/security-policy.test.ts`** (new) - proves, against a real
  `OPCUAServer`/`OPCUAClient` pair, that a `SecurityPolicy.None`
  connection is genuinely refused by default, genuinely accepted only
  with `OPCUA_ALLOW_INSECURE=1` (and only that exact value), and that a
  real `Basic256Sha256`/`SignAndEncrypt` session still connects
  correctly on the same hardened server.
- **`tests/server.test.ts`**/**`tests/security.test.ts`** - every
  existing test converted from `SecurityPolicy.None` to a real
  `Basic256Sha256`/`SignAndEncrypt` session, so at least one real test
  actually opens a genuine Signed or SignAndEncrypt session rather than
  only asserting on the encryption gate itself - no `serverCertificate`
  needed on the client side; `OPCUAClient.connect()` discovers and
  trusts the server's own certificate automatically, the standard
  OPC-UA connection flow.
- `.env.example`, README (all 7 languages) updated to describe the
  real, now-enforced behavior instead of the library-default one.
  `npm run typecheck` and the full `npm test` (20
  tests across 3 files) both pass.

## [0.0.6] - Fixed the Docker image: MODULE_NOT_FOUND on every real run

- **`src/server.ts`** - `PORT` is now parsed as a required valid TCP port
  when provided: only integer values in `1..65535` are accepted. Invalid,
  fractional or negative configuration fails at startup rather than passing
  an ambiguous value to the OPC-UA listener. Added a regression test for
  default, valid and invalid port settings. Landed just ahead of this
  build, so it ships as part of 0.0.6 rather than its own version bump.
- **`Dockerfile`'s runtime stage never installed dependencies** - real bug
  found live building and running this image for the first time (as part
  of HYDRA-UMC-GATEWAY-INDUSTRIAL's own `docker-compose.yml`): the build
  stage bundles with esbuild's own `--packages=external` (deliberate -
  keeps real npm dependencies as real `require()` calls rather than
  inlining them), so the runtime stage needed them installed separately -
  it never was, so the container crashed immediately with
  `MODULE_NOT_FOUND` on every real start. Now copies `package-lock.json`
  too and runs `npm ci --omit=dev` in the runtime stage, the same pattern
  HYDRA-UMC-OS's own `install_server.sh` already uses for
  HYDRA-UMC-SERVER (also esbuild + `--packages=external`). Verified live:
  the container now starts and stays up, and
  `HYDRA-UMC-GATEWAY-INDUSTRIAL`'s own `GET /status` reports this service
  reachable with a real measured latency.

## [0.0.5] - Real ecosystem live-status opt-in

- **`hydra-umc.project.json`** declares its real `service.port` (4840,
  the standard OPC-UA listen port) - HYDRA-UMC-SERVER's ecosystem status
  endpoint now does a real TCP-connect probe against it instead of only
  reporting static manifest metadata. No `health_path` (OPC-UA is a
  binary protocol, not HTTP), so the probe is a bare connect.

## [0.0.4] - Real read/write authorization on SwarmOnline

- **`SwarmOnline`** (`src/server.ts`) - fixed a real gap found while
  auditing the code: this variable was still writable by ANY anonymous
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
- **Real, explicit string NodeIds** (`s=HydraNode_1`, `s=HydraNode_1.SwarmOnline`, etc.) instead of node-opcua's auto-assigned numeric ones - an explicit concern: adding a future DataItem can never silently renumber an existing one and change the path an industrial client depends on.
- **`SpindleTemp`** (new, real `AnalogItemType` DataItem) - a real, standard OPC-UA `EngineeringUnits` (`°C`) and `EURange`, plus a real `timestamped_get` returning an explicit `statusCode` and a `sourceTimestamp` that reflects when the value actually last changed (not when it was read) - real historian semantics, an explicit "asociar unidad, calidad y timestamp a cada variable".
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
