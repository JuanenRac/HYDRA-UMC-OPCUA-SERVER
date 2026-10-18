<!-- =============================================================================
HYDRA-UMC-OPCUA-SERVER - Operations guide
Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
GPL-3.0-or-later - see LICENSE
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
| `OPCUA_AUTO_ACCEPT` | `1` accepts the application certificate of any client that connects (lab use). User certificates are never auto-accepted | off: unknown clients wait in `rejected/` until you trust them |
| `OPCUA_PKI_DIR` | Directory of the certificate stores (`PKI/` and `UserPKI/` below it). Put it on a persistent volume | the library's per-user default location |
| `OPCUA_ALTERNATE_HOSTNAME` | Extra host name the server certificate and the advertised endpoints use (the name your SCADA resolves) | the machine's host name |
| `OPCUA_LOGIN_MAX_FAILURES` | Failed logins allowed per minute before every login is refused until the minute passes | `10` |
| `HYDRA_SERVER_URL` + (`HYDRA_SERVER_TOKEN` or `HYDRA_SERVER_USER` + `HYDRA_SERVER_PASSWORD`) | Read the robot roster from HYDRA-UMC-SERVER (`GET /api/settings`, which only a logged-in account may read) and keep one `Robot_<id>` object per robot. An account is logged in with `POST /api/login` and logged in again, once, when the session is refused; a token expires with its session. A response over 4 MiB is refused | off |
| `HYDRA_SERVER_POLL_MS` | Roster polling interval in milliseconds (at least 1000) | `5000` |

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
- **One write role.** Only a session that logged in with the administrator's
  user name and password (`OPCUA_ADMIN_USERNAME` / `OPCUA_ADMIN_PASSWORD`) may
  write `SwarmOnline` and `MaintenanceMode`. A session whose identity is a
  certificate can never write, whoever signed it; a user certificate is also
  refused at login unless you put it in `UserPKI/trusted/certs/`. With the
  credentials unset, nobody can write.
- **Logins are bounded.** The password is compared in constant time, and after
  `OPCUA_LOGIN_MAX_FAILURES` failures in a minute every login is refused until
  that minute passes (an attacker can therefore also keep the administrator out
  for as long as the attack lasts).
- **No dangerous writes are published.** The only writable nodes are those
  two Booleans, and writing them changes a value held in this process only: it
  is not sent to HYDRA-UMC-SERVER and does not inhibit any robot or job. There
  is no actuator, setpoint or command node.

## Certificates

node-opcua generates the server's own application certificate on first start,
in the PKI store (`OPCUA_PKI_DIR`, on persistent storage in a deployment, or
every restart presents a new identity to your clients).

The server **does not trust a client by itself**: the first time a client
connects, its application certificate lands in `PKI/rejected/`, and the
connection is refused. Move that file to `PKI/trusted/certs/` (or set
`OPCUA_AUTO_ACCEPT=1` in a lab) and connect again. Clients must in turn trust
the server's certificate; the exact step depends on your client (UAExpert,
Ignition, TIA Portal ...). The stores for user certificates (`UserPKI/`) never
auto-accept, whatever `OPCUA_AUTO_ACCEPT` says. Certificate rotation is not
managed by this project.

## Address space

Namespace URI `urn:hydra-umc:opcua-server:v1`, namespace index 1. NodeIds are
explicit strings, so they stay stable when nodes are added later. The
namespace version changes only on a breaking change to this shape.

| NodeId | Type | Access | Notes |
| --- | --- | --- | --- |
| `s=HydraNode_1` | Object | - | Root object |
| `s=HydraNode_1.SwarmOnline` | Boolean | read; write authenticated | |
| `s=HydraNode_1.ActiveRobotCount` | UInt32 | read | Robots of the roster whose `online` flag is true |
| `s=HydraNode_1.SpindleTemp` | Double (°C, range -20..150) | read | `BadWaitingForInitialData` until a real source reports a value (nothing feeds it today); then a real source timestamp, and quality drops to `UncertainLastUsableValue` when the source stops updating - the last value stays readable |
| `s=Robot_<id>` | Object | - | One per robot of the roster, with `Name` (String) and `Online` (Boolean), both read-only. An id with characters outside letters, digits, `_` and `-` gets them replaced and a short hash appended |
| `s=HydraNode_1.MaintenanceMode` | Boolean | read; write authenticated | |

Honest limits: with `HYDRA_SERVER_URL` set, `SwarmOnline` is true only while
the last read of HYDRA-UMC-SERVER worked; without it, it is a plain flag.
`Online` (and so `ActiveRobotCount`) is the `online` flag HYDRA-UMC-SERVER keeps
for each robot, the one the operator interface toggles: it says the robot is
enabled there, not that its controller answered. Nothing feeds `SpindleTemp`.
There are no companion-specification types (OPC UA Robotics / DI) yet; the
robots hang from the Objects folder.

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
| Client cannot connect, certificate in `PKI/rejected/` | Trust it: move it to `PKI/trusted/certs/` (or `OPCUA_AUTO_ACCEPT=1` in a lab) |
| Login refused | `OPCUA_ADMIN_*` not set, wrong credentials, or too many failed logins in the last minute |
| Write refused | Session is anonymous or certificate-based, not the administrator's user name and password |
| `PORT must be an integer` at startup | Invalid `PORT` value |
