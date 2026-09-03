# Contributing to HYDRA-UMC-OPCUA-SERVER 🦾

We welcome contributions to the OPC-UA modeling module of the HYDRA-UMC ecosystem.

## Technology Stack
- **Language**: TypeScript / Node.js (v18+).
- **OPC-UA Stack**: [`node-opcua`](https://www.npmjs.com/package/node-opcua) — the same library UAExpert/Ignition-class clients speak to.
- **Build**: esbuild (`npm run build`, `--packages=external`), run with `tsx` in dev mode.
- **Tests**: Vitest, connecting a real `OPCUAClient` against a real `OPCUAServer` over the real binary protocol — see `tests/server.test.ts` and `tests/security.test.ts`.

## Guidelines
1. **Information Model Integrity**: Prefer explicit string NodeIds (`s=HydraNode_1...`) over node-opcua's auto-assigned numeric ones — a new DataItem must never silently renumber an existing one.
2. **Deterministic Modeling**: Keep the namespace URI and existing NodeIds stable across releases so an industrial client's hardcoded paths never break.
3. **Write Authorization**: Any variable a client can write needs a real per-session `isUserWritable(context)` check (see `MaintenanceMode`/`SwarmOnline` in `src/server.ts`) — never a static access-level flag.
4. **Testing**: New behavior needs a real protocol-level test (a real `OPCUAClient` session against a real `OPCUAServer`), in the same style as the existing suite — not a mock of the transport.
