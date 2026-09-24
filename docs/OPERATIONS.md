<!-- =============================================================================
HYDRA-UMC-OPCUA-SERVER - Operations guide
Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0 - see LICENSE
============================================================================= -->

# Operations Guide

What an integrator needs to run, connect to and safely expose this server.
Everything below describes what `src/server.ts` really does today; where
something is not implemented it says so.

## Endpoint and configuration

| Setting | Meaning | Default |
| --- | --- | --- |
| `PORT` | OPC-UA TCP port (1-65535, otherwise startup fails) | `4840` |
| `OPCUA_ADMIN_USERNAME` / `OPCUA_ADMIN_PASSWORD` | The one authenticated account | unset = **no one can log in** |
| `OPCUA_ALLOW_INSECURE` | `1` also exposes an unencrypted `SecurityPolicy.None` endpoint | off |

The endpoint URL is printed at startup, with resource path
`/HYDRA-UMC-OPCUA-SERVER` (for example `opc.tcp://<host>:4840/HYDRA-UMC-OPCUA-SERVER`).
The service does not load a `.env` file: export the variables through
systemd, Docker or the shell. Never commit credentials.

## Security model

- **Sessions must sign.** Only `Sign` and `SignAndEncrypt` are offered, with
  `Basic256Sha256`, `Aes128_Sha256_RsaOaep` and `Aes256_Sha256_RsaPss`.
  `None` exists only when `OPCUA_ALLOW_INSECURE=1`, prints a warning, and is
  meant for a local smoke test - never for a real deployment.
- **Anonymous is read-only.** Every client that does not log in is
  `anonymous` and can browse and read.
- **One write role.** With the admin credentials set, a logged-in session may
  write `SwarmOnline` and `MaintenanceMode`. With them unset, nobody can.
- **No dangerous writes are published.** The only writable nodes are those
  two Booleans; there is no actuator, setpoint or command node.

## Certificates

node-opcua generates and manages the server's own application certificate
in its default PKI store on first start. Clients must trust it (and the
server must trust each client's certificate) before a `Sign`/`SignAndEncrypt`
session opens; the exact trust step depends on your client (UAExpert,
Ignition, TIA Portal ...). Certificate rotation and a managed PKI location
are not configured by this project - if you deploy it, keep the PKI
directory on persistent storage or every restart will present a new
identity to your clients.

## Address space

Namespace URI `urn:hydra-umc:opcua-server:v1`, namespace index 1. NodeIds are
explicit strings, so they stay stable when nodes are added later. The
namespace version changes only on a breaking change to this shape.

| NodeId | Type | Access | Notes |
| --- | --- | --- | --- |
| `s=HydraNode_1` | Object | - | Root object |
| `s=HydraNode_1.SwarmOnline` | Boolean | read; write authenticated | |
| `s=HydraNode_1.ActiveRobotCount` | UInt32 | read | |
| `s=HydraNode_1.SpindleTemp` | Double (°C, range -20..150) | read | Real source timestamp; quality drops to `UncertainLastUsableValue` when the source stops updating - the last value stays readable |
| `s=HydraNode_1.MaintenanceMode` | Boolean | read; write authenticated | |

Honest limits: this is a fixed placeholder tree. The per-robot tree
generated from HYDRA-UMC-SERVER's live state is not wired up yet, and no
process feeds `SpindleTemp` or `ActiveRobotCount` on its own - they change
only when code mutates the server's state object.

## Reconnection and subscriptions

Clients reconnect on their own; the server keeps no per-client state beyond
the OPC-UA session, so a restart simply ends sessions and clients must
re-establish them (and re-trust the certificate if the PKI store was lost).
Variables sample at a minimum of 1000 ms.

## Docker

The Gateway stack (`HYDRA-UMC-GATEWAY-INDUSTRIAL/docker-compose.yml`)
publishes port 4840. After pulling new code, rebuild the container:
`docker compose up -d --build` - a plain `git pull` does not change a
running container.

## Recovery

| Symptom | Likely cause |
| --- | --- |
| Client cannot connect | Certificate not trusted on one side, or a security mode/policy the client does not support |
| Login refused | `OPCUA_ADMIN_*` not set, or wrong credentials |
| Write refused | Session is anonymous |
| `PORT must be an integer` at startup | Invalid `PORT` value |
